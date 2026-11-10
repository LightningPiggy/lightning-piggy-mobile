import SwiftUI
import WidgetKit

/// Small: wallet name, balance, Receive and Send.
/// Medium: wallet name, balance, fiat + "Updated N min ago", Receive, Scan, Send.
/// Buttons are deep links into the app (the same ones the Android widget
/// uses); the app then shows its normal Receive / Send screens, app lock and
/// payment confirmation included. A widget never pays.
struct WalletWidgetView: View {
  let entry: WalletEntry
  @Environment(\.widgetFamily) private var family

  private var palette: WidgetPalette { entry.style.palette }

  var body: some View {
    content
      .foregroundColor(palette.text)
      .environment(\.locale, L10n.locale)
      .widgetBackground(palette)
  }

  @ViewBuilder private var content: some View {
    switch entry.content {
    case .empty:
      // No widgetURL: a tap just opens the app.
      MessageView(text: L10n.string("widget.empty"))
    case let .wallet(wallet, index, count):
      let display = WalletDisplay(wallet: wallet, hideBalance: entry.hideBalance, now: entry.date)
      Group {
        if family == .systemMedium {
          MediumWalletView(entry: entry, display: display, index: index, count: count)
        } else {
          SmallWalletView(entry: entry, display: display, index: index, count: count)
        }
      }
      // Taps outside the buttons open Receive for this wallet.
      .widgetURL(DeepLink.url(.receive, walletId: wallet.id))
    }
  }
}

// MARK: What to show (mirrors buildWalletWidgetModel in src/widgets/walletWidgetModel.ts)

struct WalletDisplay {
  let walletId: String
  let name: String
  let connected: Bool
  /// The amount, or dots when hidden.
  let balanceText: String
  /// "sats" beside the amount; nil while hidden.
  let unitText: String?
  /// "≈ $68.81 · 2 min ago", "Updated 2 min ago", or nil.
  let detailText: String?
  let balanceLabel: String

  static let hiddenBalance = "••••••"

  init(wallet: WidgetWallet, hideBalance: Bool, now: Date) {
    walletId = wallet.id
    let displayName = wallet.name.isEmpty ? L10n.string("widget.unnamedWallet") : wallet.name
    name = displayName
    connected = wallet.connected ?? false
    // Hidden by the widget's switch, or no amount to show (unknown, or hidden
    // for this wallet in the app).
    let amount = hideBalance ? nil : wallet.balanceSats.map(BalanceText.sats)
    balanceText = amount ?? Self.hiddenBalance
    unitText = amount == nil ? nil : L10n.string("widget.satsUnit")
    let fiat = amount == nil ? nil : BalanceText.fiat(wallet.fiatValue, currency: wallet.currency)
    let age = wallet.updatedDate.map { AgeText.make(since: $0, now: now) }
    switch (fiat, age) {
    case let (fiat?, age?): detailText = L10n.format("widget.fiatAndAge", fiat, age)
    case let (fiat?, nil): detailText = L10n.format("widget.fiat", fiat)
    case let (nil, age?): detailText = L10n.format("widget.updated", age)
    default: detailText = nil
    }
    balanceLabel =
      amount.map { L10n.format("widget.a11y.balance", displayName, $0) }
      ?? L10n.format("widget.a11y.balanceHidden", displayName)
  }
}

// MARK: Sizes

private struct SmallWalletView: View {
  let entry: WalletEntry
  let display: WalletDisplay
  let index: Int
  let count: Int

  var body: some View {
    let palette = entry.style.palette
    VStack(spacing: 0) {
      WalletHeader(entry: entry, display: display, count: count, centred: true)
      Spacer(minLength: 4)
      BalanceView(display: display, palette: palette, size: 24, centred: true)
      DetailView(display: display, palette: palette, size: 10.5)
      Spacer(minLength: 4)
      HStack(spacing: 6) {
        ActionLink(action: .receive, walletId: display.walletId, palette: palette, primary: true)
        ActionLink(action: .send, walletId: display.walletId, palette: palette, primary: false)
      }
      PageDots(index: index, count: count, color: palette.text)
        .padding(.top, 6)
    }
    .padding(12)
  }
}

private struct MediumWalletView: View {
  let entry: WalletEntry
  let display: WalletDisplay
  let index: Int
  let count: Int

  var body: some View {
    let palette = entry.style.palette
    VStack(alignment: .leading, spacing: 0) {
      HStack {
        WalletHeader(entry: entry, display: display, count: count, centred: false)
        Spacer(minLength: 6)
        PageDots(index: index, count: count, color: palette.text)
      }
      Spacer(minLength: 4)
      BalanceView(display: display, palette: palette, size: 28, centred: false)
      DetailView(display: display, palette: palette, size: 12)
      Spacer(minLength: 6)
      HStack(spacing: 8) {
        ActionLink(action: .receive, walletId: display.walletId, palette: palette, primary: true)
        ActionLink(action: .scan, walletId: display.walletId, palette: palette, primary: false)
        ActionLink(action: .send, walletId: display.walletId, palette: palette, primary: false)
      }
    }
    .padding(14)
  }
}

// MARK: Pieces

/// Connection dot + wallet name, with ‹ › on iOS 17+ when there's more than
/// one wallet to switch between.
private struct WalletHeader: View {
  let entry: WalletEntry
  let display: WalletDisplay
  let count: Int
  let centred: Bool

  var body: some View {
    HStack(spacing: 4) {
      if showArrows { SwitchButton(entry: entry, offset: -1) }
      if centred { Spacer(minLength: 0) }
      Circle()
        .fill(display.connected ? Color.lpConnected : Color.lpDisconnected)
        .frame(width: 6, height: 6)
        .accessibilityHidden(true)
      Text(display.name)
        .font(.system(size: 12, weight: .bold))
        .lineLimit(1)
      if centred { Spacer(minLength: 0) }
      if showArrows { SwitchButton(entry: entry, offset: 1) }
    }
  }

  private var showArrows: Bool { entry.canSwitch && count > 1 }
}

private struct SwitchButton: View {
  let entry: WalletEntry
  let offset: Int

  var body: some View {
    if #available(iOS 17.0, *) {
      Button(
        intent: SwitchWalletIntent(
          cursorKey: entry.cursorKey, startingWalletId: entry.startingWalletId, offset: offset)
      ) {
        Image(systemName: offset < 0 ? "chevron.left" : "chevron.right")
          .font(.system(size: 13, weight: .bold))
          .opacity(0.8)
          .frame(width: 22, height: 22)
          .contentShape(Rectangle())
      }
      .buttonStyle(.plain)
      .accessibilityLabel(
        L10n.string(offset < 0 ? "widget.a11y.previousWallet" : "widget.a11y.nextWallet"))
    }
  }
}

private struct BalanceView: View {
  let display: WalletDisplay
  let palette: WidgetPalette
  let size: CGFloat
  let centred: Bool

  var body: some View {
    HStack(alignment: .firstTextBaseline, spacing: 3) {
      Text(display.balanceText)
        .font(.system(size: size, weight: .heavy))
        .foregroundColor(palette.balance)
        .lineLimit(1)
        .minimumScaleFactor(0.5)
      if let unit = display.unitText {
        Text(unit)
          .font(.system(size: size * 0.5, weight: .bold))
          .foregroundColor(palette.balance.opacity(0.8))
      }
    }
    .frame(maxWidth: centred ? .infinity : nil, alignment: centred ? .center : .leading)
    .accessibilityElement(children: .ignore)
    .accessibilityLabel(display.balanceLabel)
  }
}

private struct DetailView: View {
  let display: WalletDisplay
  let palette: WidgetPalette
  let size: CGFloat

  var body: some View {
    if let detail = display.detailText {
      Text(detail)
        .font(.system(size: size, weight: .semibold))
        .foregroundColor(palette.secondaryText)
        .lineLimit(1)
        .minimumScaleFactor(0.7)
        .padding(.top, 2)
    }
  }
}

private struct ActionLink: View {
  let action: DeepLink.Action
  let walletId: String
  let palette: WidgetPalette
  let primary: Bool

  var body: some View {
    Link(destination: DeepLink.url(action, walletId: walletId)) {
      HStack(spacing: 4) {
        Image(systemName: action.symbol)
          .font(.system(size: 11, weight: .bold))
        if action != .scan {
          Text(L10n.string(action.labelKey))
            .font(.system(size: 12, weight: .bold))
            .lineLimit(1)
            .minimumScaleFactor(0.7)
        }
      }
      .foregroundColor(primary ? palette.primaryButtonText : palette.secondaryButtonText)
      .frame(maxWidth: action == .scan ? 30 : .infinity, minHeight: 30, maxHeight: 30)
      .padding(.horizontal, action == .scan ? 0 : 8)
      .background(Capsule().fill(primary ? palette.primaryButton : palette.secondaryButton))
    }
    .accessibilityLabel(L10n.string(action.labelKey))
  }
}

/// Decorative: one dot per wallet (VoiceOver users switch with ‹ ›).
private struct PageDots: View {
  let index: Int
  let count: Int
  let color: Color

  var body: some View {
    if count > 1 {
      HStack(spacing: 4) {
        // At most 7 dots; beyond that the current one stays highlighted at the end.
        ForEach(0..<min(count, 7), id: \.self) { dot in
          let current = dot == min(index, 6)
          Capsule()
            .fill(color.opacity(current ? 1 : 0.35))
            .frame(width: current ? 12 : 5, height: 5)
        }
      }
      .accessibilityHidden(true)
    }
  }
}

private struct MessageView: View {
  let text: String

  var body: some View {
    VStack(spacing: 8) {
      Image(systemName: "bolt.circle.fill")
        .font(.system(size: 26, weight: .bold))
        .accessibilityHidden(true)
      Text(text)
        .font(.system(size: 13, weight: .semibold))
        .multilineTextAlignment(.center)
        .minimumScaleFactor(0.7)
    }
    .padding(14)
    .frame(maxWidth: .infinity, maxHeight: .infinity)
  }
}

// MARK: Text

enum BalanceText {
  static func sats(_ value: Double) -> String {
    guard value.isFinite else { return "–" }
    let formatter = NumberFormatter()
    formatter.numberStyle = .decimal
    formatter.maximumFractionDigits = 0
    formatter.locale = L10n.locale
    return formatter.string(from: NSNumber(value: value.rounded(.down))) ?? "\(Int64(value))"
  }

  /// nil for an unknown or missing currency (the line is then left out).
  static func fiat(_ value: Double?, currency: String?) -> String? {
    guard let value, value.isFinite, let currency, !currency.isEmpty else { return nil }
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency
    formatter.currencyCode = currency
    formatter.locale = L10n.locale
    return formatter.string(from: NSNumber(value: value))
  }
}

/// "just now" / "5 min ago" / "3 hours ago" / "2 days ago" (widgetAgeText).
enum AgeText {
  static func make(since updated: Date, now: Date) -> String {
    let minutes = max(0, Int(now.timeIntervalSince(updated) / 60))
    if minutes < 1 { return L10n.string("widget.age.justNow") }
    if minutes < 60 { return L10n.plural("widget.age.minutes", count: minutes) }
    let hours = minutes / 60
    if hours < 24 { return L10n.plural("widget.age.hours", count: hours) }
    return L10n.plural("widget.age.days", count: hours / 24)
  }
}

// MARK: Deep links (src/navigation/widgetDeepLinks.ts)

enum DeepLink {
  enum Action: String {
    case receive
    case send
    case scan

    var symbol: String {
      switch self {
      case .receive: return "arrow.down"
      case .send: return "arrow.up"
      case .scan: return "qrcode.viewfinder"
      }
    }

    var labelKey: String { "widget.\(rawValue)" }
  }

  /// lightningpiggy://receive?wallet=<id>
  static func url(_ action: Action, walletId: String) -> URL {
    var components = URLComponents()
    components.scheme = "lightningpiggy"
    components.host = action.rawValue
    components.queryItems = [URLQueryItem(name: "wallet", value: walletId)]
    return components.url ?? URL(string: "lightningpiggy://\(action.rawValue)")!
  }
}

// MARK: Background (containerBackground on iOS 17+)

extension View {
  @ViewBuilder func widgetBackground(_ palette: WidgetPalette) -> some View {
    if #available(iOS 17.0, *) {
      self.containerBackground(for: .widget) {
        ZStack {
          Rectangle().fill(palette.background)
          if let border = palette.border { ContainerRelativeShape().strokeBorder(border, lineWidth: 1) }
        }
      }
    } else {
      self
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(
          ZStack {
            Rectangle().fill(palette.background)
            if let border = palette.border { ContainerRelativeShape().strokeBorder(border, lineWidth: 1) }
          })
    }
  }
}
