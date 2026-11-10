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

  static func make(
    date: Date, snapshot: WidgetSnapshot?, family: WidgetFamily, startingWalletId: String?,
    style: WidgetStyleKind, hideBalance: Bool, canSwitch: Bool
  ) -> WalletEntry {
    let cursorKey = [
      String(describing: family), startingWalletId ?? "-", style.rawValue, hideBalance ? "h" : "v",
    ].joined(separator: "|")
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

  /// Shown in the widget gallery before the app has shared anything.
  static func sample(style: WidgetStyleKind = .default) -> WalletEntry {
    let wallet = WidgetWallet(
      id: "sample", name: "Lightning Piggy", balanceSats: 21_000, fiatValue: nil, currency: nil,
      updatedAt: Date().timeIntervalSince1970 * 1000, order: 0, connected: true)
    return WalletEntry(
      date: Date(), content: .wallet(wallet, index: 0, count: 1), style: style, hideBalance: false,
      canSwitch: false, cursorKey: "sample", startingWalletId: nil)
  }
}

/// One entry now and one every 5 minutes so "Updated N min ago" keeps
/// counting; after 30 minutes WidgetKit asks again. The app also reloads
/// every timeline whenever it writes a new snapshot.
func walletTimeline(_ makeEntry: (Date) -> WalletEntry) -> Timeline<WalletEntry> {
  let now = Date()
  let entries = (0...6).map { step in makeEntry(now.addingTimeInterval(TimeInterval(step * 5 * 60))) }
  return Timeline(entries: entries, policy: .after(now.addingTimeInterval(30 * 60)))
}

// MARK: iOS 17+ — configurable and interactive

@available(iOS 17.0, *)
struct WalletIntentProvider: AppIntentTimelineProvider {
  func placeholder(in context: Context) -> WalletEntry { .sample() }

  func snapshot(for configuration: WalletWidgetConfigurationIntent, in context: Context) async -> WalletEntry {
    guard WidgetStore.loadSnapshot() != nil else { return .sample(style: configuration.style.kind) }
    return entry(for: configuration, in: context, at: Date())
  }

  func timeline(for configuration: WalletWidgetConfigurationIntent, in context: Context) async -> Timeline<
    WalletEntry
  > {
    walletTimeline { date in entry(for: configuration, in: context, at: date) }
  }

  private func entry(for configuration: WalletWidgetConfigurationIntent, in context: Context, at date: Date)
    -> WalletEntry
  {
    WalletEntry.make(
      date: date, snapshot: WidgetStore.loadSnapshot(), family: context.family,
      startingWalletId: configuration.wallet?.id, style: configuration.style.kind,
      hideBalance: configuration.hideBalance, canSwitch: true)
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
    guard WidgetStore.loadSnapshot() != nil else { return completion(.sample()) }
    completion(entry(in: context, at: Date()))
  }

  func getTimeline(in context: Context, completion: @escaping (Timeline<WalletEntry>) -> Void) {
    completion(walletTimeline { date in entry(in: context, at: date) })
  }

  private func entry(in context: Context, at date: Date) -> WalletEntry {
    WalletEntry.make(
      date: date, snapshot: WidgetStore.loadSnapshot(), family: context.family, startingWalletId: nil,
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
