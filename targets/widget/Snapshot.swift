import Foundation

/// One wallet as the app shares it with the widget: the allow-listed display
/// fields of src/services/widgetSnapshot.ts (`WidgetWallet`), never a
/// connection string, key, address or any other secret.
struct WidgetWallet: Codable, Hashable, Identifiable {
  let id: String
  let name: String
  /// nil when unknown, or when the user hides this wallet's balance in the app.
  let balanceSats: Double?
  let fiatValue: Double?
  /// ISO 4217 code of `fiatValue`.
  let currency: String?
  /// When the app last saw this balance on a connected wallet (ms since 1970).
  let updatedAt: Double?
  /// Position in the app's wallet carousel.
  let order: Int?
  let connected: Bool?

  var updatedDate: Date? {
    guard let updatedAt else { return nil }
    return Date(timeIntervalSince1970: updatedAt / 1000)
  }
}

/// The snapshot the app shares through the App Group (`WidgetSnapshot` in
/// src/services/widgetSnapshot.ts). Unknown keys are ignored.
struct WidgetSnapshot: Codable, Hashable {
  let version: Int?
  /// The language the user picked in the app.
  let locale: String?
  let wallets: [WidgetWallet]

  /// Wallets in carousel order (the app writes them sorted; this is a guard).
  var orderedWallets: [WidgetWallet] {
    wallets.enumerated()
      .sorted { ($0.element.order ?? $0.offset, $0.offset) < ($1.element.order ?? $1.offset, $1.offset) }
      .map(\.element)
  }
}

/// Read-only access to what the app shares through the App Group, plus the
/// widget's own per-configuration "current wallet" cursors.
enum WidgetStore {
  /// Written by the app (src/services/widgetAppGroup.ios.ts).
  static let snapshotKey = "widget_snapshot_v1"
  /// Written only by the widget (‹ › positions); the app clears it on wipe.
  static let cursorsKey = "widget_cursors_v1"

  /// `group.<app bundle id>`. The extension's bundle id is the app's plus
  /// `.widget`, so each variant (dev / preview / production) resolves its own
  /// group without a per-variant source change.
  static var appGroupIdentifier: String {
    let bundleId = Bundle.main.bundleIdentifier ?? "com.lightningpiggy.app.widget"
    let appBundleId = bundleId.hasSuffix(".widget") ? String(bundleId.dropLast(".widget".count)) : bundleId
    return "group.\(appBundleId)"
  }

  static var defaults: UserDefaults? { UserDefaults(suiteName: appGroupIdentifier) }

  /// nil when the app has never written a snapshot or the user signed out.
  static func loadSnapshot() -> WidgetSnapshot? {
    guard let raw = defaults?.string(forKey: snapshotKey), let data = raw.data(using: .utf8) else {
      return nil
    }
    if raw == cache?.raw { return cache?.snapshot }
    let snapshot = try? JSONDecoder().decode(WidgetSnapshot.self, from: data)
    cache = (raw, snapshot)
    return snapshot
  }

  /// One render reads the snapshot many times (every string looks up the
  /// app's language), so the last decode is kept until the JSON changes.
  private static var cache: (raw: String, snapshot: WidgetSnapshot?)?

  /// The language the user picked in the app (falls back to the system's).
  static var appLocale: String? { loadSnapshot()?.locale }

  // MARK: Wallet cursors (per widget configuration)

  /// WidgetKit gives an extension no per-widget id, so the wallet a widget
  /// has switched to is remembered per configuration (size, starting wallet,
  /// style, Hide balance). Two identically configured widgets switch together.
  struct Cursor: Codable {
    let walletId: String
    let index: Int
  }

  static func cursor(for key: String) -> Cursor? {
    guard let data = defaults?.data(forKey: cursorsKey),
      let all = try? JSONDecoder().decode([String: Cursor].self, from: data)
    else { return nil }
    return all[key]
  }

  static func setCursor(_ cursor: Cursor, for key: String) {
    var all: [String: Cursor] = [:]
    if let data = defaults?.data(forKey: cursorsKey),
      let decoded = try? JSONDecoder().decode([String: Cursor].self, from: data)
    {
      all = decoded
    }
    all[key] = cursor
    if let data = try? JSONEncoder().encode(all) {
      defaults?.set(data, forKey: cursorsKey)
    }
  }
}

/// Which wallet a widget shows, and how ‹ › move through the list.
enum WalletSelection {
  /// The wallet to show: the cursor's wallet if it still exists, else the one
  /// now at the cursor's position (a removed wallet hands over to the next),
  /// else the configured starting wallet, else the first. nil = no wallets.
  static func resolve(wallets: [WidgetWallet], startingWalletId: String?, cursor: WidgetStore.Cursor?)
    -> Int?
  {
    guard !wallets.isEmpty else { return nil }
    if let cursor {
      if let index = wallets.firstIndex(where: { $0.id == cursor.walletId }) { return index }
      return min(max(cursor.index, 0), wallets.count - 1)
    }
    if let startingWalletId, let index = wallets.firstIndex(where: { $0.id == startingWalletId }) {
      return index
    }
    return 0
  }

  /// Next (+1) or previous (-1) index, wrapping around.
  static func step(from index: Int, by offset: Int, count: Int) -> Int {
    guard count > 0 else { return 0 }
    return ((index + offset) % count + count) % count
  }
}
