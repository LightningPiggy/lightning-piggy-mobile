import SwiftUI
import WidgetKit

/// iOS 17+ gets the configurable, interactive widget. iOS 15–16 get a static
/// one instead (first wallet, Piggy pink, no ‹ ›). WidgetBundleBuilder only
/// allows `if #available` without an `else`, so both are always declared and
/// the static one hides itself from the gallery on iOS 17+ (no families).
let walletWidgetKind = "LightningPiggyWallet"
let legacyWalletWidgetKind = "LightningPiggyWalletLegacy"

@main
struct LightningPiggyWidgets: WidgetBundle {
  var body: some Widget {
    LegacyWalletWidget()
    if #available(iOS 17.0, *) {
      WalletWidget()
    }
  }
}

// MARK: Timeline entry

struct WalletEntry: TimelineEntry {
  enum Content {
    /// No wallet to show: signed out, no wallets yet, or nothing synced yet.
    case empty
    case wallet(WidgetWallet, index: Int, count: Int)
  }

  let date: Date
  let content: Content
  let style: WidgetStyleKind
  let hideBalance: Bool
  /// ‹ › are shown only where interactive widgets exist (iOS 17+).
  let canSwitch: Bool
  let cursorKey: String
  let startingWalletId: String?

  /// Identifies a widget configuration (see `WidgetStore.Cursor`).
  static func cursorKey(
    family: WidgetFamily, startingWalletId: String?, style: WidgetStyleKind, hideBalance: Bool
  ) -> String {
    [String(describing: family), startingWalletId ?? "-", style.rawValue, hideBalance ? "h" : "v"]
      .joined(separator: "|")
  }

  static func make(
    date: Date, snapshot: WidgetSnapshot?, family: WidgetFamily, startingWalletId: String?,
    style: WidgetStyleKind, hideBalance: Bool, canSwitch: Bool
  ) -> WalletEntry {
    let cursorKey = cursorKey(
      family: family, startingWalletId: startingWalletId, style: style, hideBalance: hideBalance)
    let wallets = snapshot?.orderedWallets ?? []
    let content: Content
    if let index = WalletSelection.resolve(
      wallets: wallets, startingWalletId: startingWalletId,
      cursor: canSwitch ? WidgetStore.cursor(for: cursorKey) : nil)
    {
      content = .wallet(wallets[index], index: index, count: wallets.count)
    } else {
      content = .empty
    }
    return WalletEntry(
      date: date, content: content, style: style, hideBalance: hideBalance, canSwitch: canSwitch,
      cursorKey: cursorKey, startingWalletId: startingWalletId)
  }

  /// Only for the widget gallery before the app has shared anything (and the
  /// redacted placeholder); a placed widget with no snapshot shows "Add a
  /// wallet in Lightning Piggy" instead.
  static func sample(style: WidgetStyleKind = .default) -> WalletEntry {
    let wallet = WidgetWallet(
      id: "sample", name: "Lightning Piggy", balanceSats: 21_000, fiatValue: nil, currency: nil,
      updatedAt: Date().timeIntervalSince1970 * 1000, order: 0, connected: true)
    return WalletEntry(
      date: Date(), content: .wallet(wallet, index: 0, count: 1), style: style, hideBalance: false,
      canSwitch: false, cursorKey: "sample", startingWalletId: nil)
  }
}

/// One entry. The "Updated 14:32" text is absolute, so it only needs a new
/// timeline when it rolls over at local midnight ("yesterday 14:32"); every
/// snapshot the app writes reloads the timelines too.
func walletTimeline(_ entry: WalletEntry) -> Timeline<WalletEntry> {
  Timeline(
    entries: [entry], policy: .after(UpdatedTimeText.nextChange(after: entry.date, calendar: .current)))
}

// MARK: iOS 17+ — configurable and interactive

@available(iOS 17.0, *)
struct WalletIntentProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> WalletEntry { .sample() }

  func snapshot(for configuration: WalletWidgetConfigurationIntent, in context: Context) async -> WalletEntry {
    if context.isPreview && WidgetStore.loadSnapshot() == nil {
      return .sample(style: configuration.style.kind)
    }
    return entry(for: configuration, in: context)
  }

  func timeline(for configuration: WalletWidgetConfigurationIntent, in context: Context) async -> Timeline<
    WalletEntry
  > {
    let entry = entry(for: configuration, in: context)
    // Remember what this configuration shows, so a removed wallet hands over
    // to the next one, then forget configurations no widget uses any more.
    if case let .wallet(wallet, index, _) = entry.content {
      WidgetStore.setCursor(WidgetStore.Cursor(walletId: wallet.id, index: index), for: entry.cursorKey)
    }
    await pruneUnusedCursors(current: entry.cursorKey)
    return walletTimeline(entry)
  }

  private func entry(for configuration: WalletWidgetConfigurationIntent, in context: Context) -> WalletEntry {
    WalletEntry.make(
      date: Date(), snapshot: WidgetStore.loadSnapshot(), family: context.family,
      startingWalletId: configuration.wallet?.id, style: configuration.style.kind,
      hideBalance: configuration.hideBalance, canSwitch: true)
  }

  private func pruneUnusedCursors(current: String) async {
    let infos: [WidgetInfo] = await withCheckedContinuation { continuation in
      WidgetCenter.shared.getCurrentConfigurations { result in
        continuation.resume(returning: (try? result.get()) ?? [])
      }
    }
    let keys = Set(
      infos.filter { $0.kind == walletWidgetKind }.compactMap { info -> String? in
        guard let intent = info.widgetConfigurationIntent(of: WalletWidgetConfigurationIntent.self) else {
          return nil
        }
        return WalletEntry.cursorKey(
          family: info.family, startingWalletId: intent.wallet?.id, style: intent.style.kind,
          hideBalance: intent.hideBalance)
      })
    // Only trust a list that includes the widget being drawn right now.
    guard keys.contains(current) else { return }
    WidgetStore.pruneCursors(keeping: keys)
  }
}

@available(iOS 17.0, *)
struct WalletWidget: Widget {
  var body: some WidgetConfiguration {
    AppIntentConfiguration(
      kind: walletWidgetKind, intent: WalletWidgetConfigurationIntent.self, provider: WalletIntentProvider()
    ) { entry in
      WalletWidgetView(entry: entry)
    }
    .configurationDisplayName(L10n.string("widget.picker.cardLabel"))
    .description(L10n.string("widget.picker.barDescription"))
    .supportedFamilies([.systemSmall, .systemMedium])
    .contentMarginsDisabled()
  }
}

// MARK: iOS 15–16 — first wallet, default style, no switching

struct LegacyWalletProvider: TimelineProvider {
  func placeholder(in context: Context) -> WalletEntry { .sample() }

  func getSnapshot(in context: Context, completion: @escaping (WalletEntry) -> Void) {
    if context.isPreview && WidgetStore.loadSnapshot() == nil { return completion(.sample()) }
    completion(entry(in: context))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<WalletEntry>) -> Void) {
    completion(walletTimeline(entry(in: context)))
  }

  private func entry(in context: Context) -> WalletEntry {
    WalletEntry.make(
      date: Date(), snapshot: WidgetStore.loadSnapshot(), family: context.family, startingWalletId: nil,
      style: .default, hideBalance: false, canSwitch: false)
  }
}

struct LegacyWalletWidget: Widget {
  var body: some WidgetConfiguration {
    StaticConfiguration(kind: legacyWalletWidgetKind, provider: LegacyWalletProvider()) { entry in
      WalletWidgetView(entry: entry)
    }
    .configurationDisplayName(L10n.string("widget.picker.cardLabel"))
    .description(L10n.string("widget.picker.barDescription"))
    .supportedFamilies(families)
  }

  private var families: [WidgetFamily] {
    if #available(iOS 17.0, *) { return [] }
    return [.systemSmall, .systemMedium]
  }
}
