import Foundation

// What the widget shows, as plain Foundation code (no SwiftUI), so
// scripts/ios-tests/WidgetLogicTests.swift can compile and run it on macOS
// in CI. Each type is a port of the Android widget's TypeScript; keep them in
// step:
//   WalletDisplay     ← buildWalletWidgetModel   (src/widgets/walletWidgetModel.ts)
//   UpdatedTimeText   ← widgetUpdatedTimeText    (same file)
//   PageDotsWindow    ← visiblePageDots          (same file)
//   DeepLink          ← buildWidgetDeepLink      (src/navigation/widgetDeepLinks.ts)
//   WalletSelection   ← selectWidgetWallet / cycleWidgetWallet (src/widgets/walletCycling.ts,
//                       in Snapshot.swift; shared cases in src/widgets/walletSelectionCases.json)

struct WalletDisplay {
  let walletId: String
  let name: String
  let connected: Bool
  /// The amount, or dots when hidden.
  let balanceText: String
  /// "sats" beside the amount; nil while hidden.
  let unitText: String?
  /// "≈ $68.81 · 14:32", "Updated 14:32", or nil.
  let detailText: String?
  let balanceLabel: String

  static let hiddenBalance = "••••••"

  init(
    wallet: WidgetWallet, hideBalance: Bool, now: Date, locale: Locale = L10n.locale,
    calendar: Calendar = .current
  ) {
    walletId = wallet.id
    let displayName = wallet.name.isEmpty ? L10n.string("widget.unnamedWallet") : wallet.name
    name = displayName
    connected = wallet.connected ?? false
    // Hidden by the widget's switch, or no amount to show (unknown, or hidden
    // for this wallet in the app).
    let amount = hideBalance ? nil : wallet.balanceSats.map { BalanceText.sats($0, locale: locale) }
    balanceText = amount ?? Self.hiddenBalance
    unitText = amount == nil ? nil : L10n.string("widget.satsUnit")
    let fiat =
      amount == nil ? nil : BalanceText.fiat(wallet.fiatValue, currency: wallet.currency, locale: locale)
    let time = wallet.updatedDate.map {
      UpdatedTimeText.make(updated: $0, now: now, locale: locale, calendar: calendar)
    }
    switch (fiat, time) {
    case let (fiat?, time?): detailText = L10n.format("widget.fiatAndTime", fiat, time)
    case let (fiat?, nil): detailText = L10n.format("widget.fiat", fiat)
    case let (nil, time?): detailText = L10n.format("widget.updatedAt", time)
    default: detailText = nil
    }
    balanceLabel =
      amount.map { L10n.format("widget.a11y.balance", displayName, $0) }
      ?? L10n.format("widget.a11y.balanceHidden", displayName)
  }
}

enum BalanceText {
  static func sats(_ value: Double, locale: Locale) -> String {
    guard value.isFinite else { return "–" }
    let formatter = NumberFormatter()
    formatter.numberStyle = .decimal
    formatter.maximumFractionDigits = 0
    formatter.locale = locale
    return formatter.string(from: NSNumber(value: value.rounded(.down))) ?? "\(Int64(value))"
  }

  /// nil for an unknown or missing currency (the line is then left out).
  static func fiat(_ value: Double?, currency: String?, locale: Locale) -> String? {
    guard let value, value.isFinite, let currency, !currency.isEmpty else { return nil }
    let formatter = NumberFormatter()
    formatter.numberStyle = .currency
    formatter.currencyCode = currency
    formatter.locale = locale
    return formatter.string(from: NSNumber(value: value))
  }
}

/// When the balance was fetched, as an absolute time: "14:32" today,
/// "yesterday 14:32", else the date ("3 Nov"). Absolute, so the widget never
/// needs a redraw to keep "N min ago" true. A future time (clock skew) reads
/// as now.
enum UpdatedTimeText {
  static func make(updated: Date, now: Date, locale: Locale, calendar: Calendar) -> String {
    let at = min(updated, now)
    let timeFormatter = DateFormatter()
    timeFormatter.locale = locale
    timeFormatter.calendar = calendar
    timeFormatter.timeZone = calendar.timeZone
    timeFormatter.setLocalizedDateFormatFromTemplate("jmm")
    let time = timeFormatter.string(from: at)
    if calendar.isDate(at, inSameDayAs: now) { return time }
    if let yesterday = calendar.date(byAdding: .day, value: -1, to: now),
      calendar.isDate(at, inSameDayAs: yesterday)
    {
      return L10n.format("widget.yesterdayAt", time)
    }
    let dateFormatter = DateFormatter()
    dateFormatter.locale = locale
    dateFormatter.calendar = calendar
    dateFormatter.timeZone = calendar.timeZone
    dateFormatter.setLocalizedDateFormatFromTemplate("dMMM")
    return dateFormatter.string(from: at)
  }

  /// The text changes ("14:32" → "yesterday 14:32" → "3 Nov") only at local
  /// midnight, so that's when the timeline needs refreshing.
  static func nextChange(after now: Date, calendar: Calendar) -> Date {
    calendar.nextDate(
      after: now, matching: DateComponents(hour: 0, minute: 0, second: 5), matchingPolicy: .nextTime)
      ?? now.addingTimeInterval(24 * 60 * 60)
  }
}

/// At most `max` page dots, sliding so the current wallet's dot stays shown.
enum PageDotsWindow {
  static let maxDots = 7

  static func visible(pageCount: Int, pageIndex: Int, max: Int = maxDots) -> (count: Int, active: Int) {
    let count = Swift.min(Swift.max(pageCount, 0), max)
    if pageCount <= max { return (count, pageIndex) }
    let start = Swift.min(Swift.max(pageIndex - max / 2, 0), pageCount - max)
    return (count, pageIndex - start)
  }
}

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
