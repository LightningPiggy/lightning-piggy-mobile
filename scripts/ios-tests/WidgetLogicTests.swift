// Runs the iPhone widget's display logic (targets/widget: Snapshot.swift,
// Strings.swift, WidgetDisplay.swift — plain Foundation) on macOS, against the
// same wallet-selection cases as the Jest tests
// (src/widgets/walletSelectionCases.json), plus the display rules ported from
// src/widgets/walletWidgetModel.ts. Run by CI's "iOS widget logic" job:
//
//   swiftc -swift-version 5 -parse-as-library targets/widget/Snapshot.swift \
//     targets/widget/Strings.swift targets/widget/WidgetDisplay.swift \
//     scripts/ios-tests/WidgetLogicTests.swift -o widget-logic
//   ./widget-logic src/widgets/walletSelectionCases.json
//
// No string catalogue is bundled here, so L10n returns keys: the display
// checks assert WHICH string was chosen, the Jest tests cover the wording.
import Foundation

struct Cases: Decodable {
  struct Selection: Decodable {
    struct CursorCase: Decodable {
      let walletId: String
      let index: Int
    }

    let name: String
    let wallets: [String]
    let cursor: CursorCase?
    let start: String?
    let shown: Int?
    let next: Int?
    let previous: Int?
  }

  struct Dots: Decodable {
    let pageCount: Int
    let pageIndex: Int
    let count: Int
    let active: Int
  }

  let selection: [Selection]
  let pageDots: [Dots]
}

var failures = 0

func check<T: Equatable>(_ actual: T, _ expected: T, _ label: String) {
  if actual != expected {
    failures += 1
    print("FAIL \(label): expected \(expected), got \(actual)")
  }
}

func wallet(
  _ id: String, name: String = "Piggy", balance: Double? = 92_369, fiat: Double? = 68.81,
  currency: String? = "USD", updatedAt: Date? = nil, connected: Bool? = true
) -> WidgetWallet {
  WidgetWallet(
    id: id, name: name, balanceSats: balance, fiatValue: fiat, currency: currency,
    updatedAt: updatedAt.map { $0.timeIntervalSince1970 * 1000 }, order: 0, connected: connected)
}

func runSelection(_ cases: [Cases.Selection]) {
  for c in cases {
    let wallets = c.wallets.map { wallet($0) }
    let cursor = c.cursor.map { WidgetStore.Cursor(walletId: $0.walletId, index: $0.index) }
    let shown = WalletSelection.resolve(wallets: wallets, startingWalletId: c.start, cursor: cursor)
    check(shown, c.shown, "\(c.name): shown")
    let next = shown.map { WalletSelection.step(from: $0, by: 1, count: wallets.count) }
    let previous = shown.map { WalletSelection.step(from: $0, by: -1, count: wallets.count) }
    check(next, c.next, "\(c.name): next")
    check(previous, c.previous, "\(c.name): previous")
  }
}

func runPageDots(_ cases: [Cases.Dots]) {
  for c in cases {
    let window = PageDotsWindow.visible(pageCount: c.pageCount, pageIndex: c.pageIndex)
    check(window.count, c.count, "dots \(c.pageCount)@\(c.pageIndex): count")
    check(window.active, c.active, "dots \(c.pageCount)@\(c.pageIndex): active")
  }
}

func runDisplay() {
  var calendar = Calendar(identifier: .gregorian)
  calendar.timeZone = TimeZone(identifier: "UTC")!
  let locale = Locale(identifier: "en_GB")
  let now = calendar.date(from: DateComponents(year: 2026, month: 11, day: 10, hour: 18, minute: 5))!
  let today = calendar.date(from: DateComponents(year: 2026, month: 11, day: 10, hour: 14, minute: 32))!
  let yesterday = calendar.date(byAdding: .day, value: -1, to: today)!
  let older = calendar.date(from: DateComponents(year: 2026, month: 11, day: 3, hour: 9))!
  let display = { (w: WidgetWallet, hide: Bool) in
    WalletDisplay(wallet: w, hideBalance: hide, now: now, locale: locale, calendar: calendar)
  }

  // Balance shown by default, with unit and fiat + time.
  let shown = display(wallet("a", updatedAt: today), false)
  check(shown.balanceText, "92,369", "balance text")
  check(shown.unitText, "widget.satsUnit", "unit shown")
  check(shown.detailText, "widget.fiatAndTime", "fiat and time")
  check(shown.balanceLabel, "widget.a11y.balance", "spoken balance")

  // Hidden by the widget's switch: dots, no unit, no fiat, still the time.
  let hidden = display(wallet("a", updatedAt: today), true)
  check(hidden.balanceText, WalletDisplay.hiddenBalance, "hidden balance")
  check(hidden.unitText, nil, "hidden unit")
  check(hidden.detailText, "widget.updatedAt", "hidden detail")
  check(hidden.balanceLabel, "widget.a11y.balanceHidden", "spoken hidden balance")

  // Hidden in the app (balance null) reads as hidden too.
  check(display(wallet("a", balance: nil), false).balanceText, WalletDisplay.hiddenBalance, "null balance")
  // No fiat (unknown currency) and no time: no detail line.
  check(display(wallet("a", fiat: nil), false).detailText, nil, "no detail")
  check(display(wallet("a", currency: nil), false).detailText, nil, "no currency, no detail")
  check(display(wallet("a"), false).detailText, "widget.fiat", "fiat only")
  // Unnamed wallet and connection flag.
  check(display(wallet("a", name: ""), false).name, "widget.unnamedWallet", "unnamed wallet")
  check(display(wallet("a", connected: nil), false).connected, false, "unknown connection")

  // "Updated" time: today → time, yesterday → "yesterday …", older → date,
  // future (clock skew) → as now.
  check(
    UpdatedTimeText.make(updated: today, now: now, locale: locale, calendar: calendar), "14:32",
    "time today")
  check(
    UpdatedTimeText.make(updated: yesterday, now: now, locale: locale, calendar: calendar),
    "widget.yesterdayAt", "time yesterday")
  check(
    UpdatedTimeText.make(updated: older, now: now, locale: locale, calendar: calendar), "3 Nov",
    "older date")
  check(
    UpdatedTimeText.make(
      updated: now.addingTimeInterval(3600), now: now, locale: locale, calendar: calendar), "18:05",
    "future time")
  let midnight = UpdatedTimeText.nextChange(after: now, calendar: calendar)
  check(calendar.component(.day, from: midnight), 11, "next change is the coming midnight")
  check(calendar.component(.hour, from: midnight), 0, "next change at 00:xx")

  // Deep links match src/navigation/widgetDeepLinks.ts.
  check(
    DeepLink.url(.receive, walletId: "w-1").absoluteString, "lightningpiggy://receive?wallet=w-1",
    "receive link")
  check(DeepLink.url(.scan, walletId: "a_b").absoluteString, "lightningpiggy://scan?wallet=a_b", "scan link")
}

@main
struct WidgetLogicTests {
  static func main() throws {
    guard CommandLine.arguments.count > 1 else {
      print("usage: widget-logic <path to walletSelectionCases.json>")
      exit(2)
    }
    let data = try Data(contentsOf: URL(fileURLWithPath: CommandLine.arguments[1]))
    let cases = try JSONDecoder().decode(Cases.self, from: data)
    runSelection(cases.selection)
    runPageDots(cases.pageDots)
    runDisplay()
    if failures > 0 {
      print("\(failures) widget logic check(s) failed")
      exit(1)
    }
    print("widget logic: \(cases.selection.count) selection cases, \(cases.pageDots.count) page-dot cases and the display checks passed")
  }
}
