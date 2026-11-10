import AppIntents
import WidgetKit

// iOS 17+: the Edit Widget sheet (wallet, style, Hide balance) and the
// interactive ‹ › wallet switch. Nothing here pays or opens the app.

@available(iOS 17.0, *)
struct WalletEntity: AppEntity {
  static var typeDisplayRepresentation: TypeDisplayRepresentation = TypeDisplayRepresentation(
    name: LocalizedStringResource("widget.unnamedWallet"))
  static var defaultQuery = WalletEntityQuery()

  let id: String
  let name: String

  var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
}

/// Wallet choices come from the snapshot the app shares through the App Group.
@available(iOS 17.0, *)
struct WalletEntityQuery: EntityQuery {
  private func all() -> [WalletEntity] {
    (WidgetStore.loadSnapshot()?.orderedWallets ?? []).map { WalletEntity(id: $0.id, name: $0.name) }
  }

  func entities(for identifiers: [WalletEntity.ID]) async throws -> [WalletEntity] {
    all().filter { identifiers.contains($0.id) }
  }

  func suggestedEntities() async throws -> [WalletEntity] { all() }

  func defaultResult() async -> WalletEntity? { all().first }
}

@available(iOS 17.0, *)
enum WidgetStyleOption: String, AppEnum {
  case piggyPink
  case cleanWhite
  case nightGlass

  static var typeDisplayRepresentation: TypeDisplayRepresentation = TypeDisplayRepresentation(
    name: LocalizedStringResource("widget.config.styleSection"))
  static var caseDisplayRepresentations: [WidgetStyleOption: DisplayRepresentation] = [
    .piggyPink: DisplayRepresentation(title: LocalizedStringResource("widget.config.stylePiggyPink")),
    .cleanWhite: DisplayRepresentation(title: LocalizedStringResource("widget.config.styleCleanWhite")),
    .nightGlass: DisplayRepresentation(title: LocalizedStringResource("widget.config.styleNightGlass")),
  ]

  var kind: WidgetStyleKind { WidgetStyleKind(rawValue: rawValue) ?? .default }
}

@available(iOS 17.0, *)
struct WalletWidgetConfigurationIntent: WidgetConfigurationIntent {
  static var title: LocalizedStringResource = LocalizedStringResource("widget.config.title")
  static var description = IntentDescription(LocalizedStringResource("widget.config.subtitle"))

  @Parameter(title: LocalizedStringResource("widget.config.walletSection"))
  var wallet: WalletEntity?

  @Parameter(title: LocalizedStringResource("widget.config.styleSection"), default: .piggyPink)
  var style: WidgetStyleOption

  @Parameter(title: LocalizedStringResource("widget.config.hideBalance"), default: false)
  var hideBalance: Bool
}

/// ‹ / › on the widget: shows the previous / next wallet in carousel order,
/// in place. WidgetKit reloads the timeline once `perform()` returns.
@available(iOS 17.0, *)
struct SwitchWalletIntent: AppIntent {
  static var title: LocalizedStringResource = LocalizedStringResource("widget.a11y.nextWallet")
  static var isDiscoverable = false

  @Parameter(title: "Cursor") var cursorKey: String
  @Parameter(title: "Starting wallet") var startingWalletId: String
  @Parameter(title: "Offset") var offset: Int

  init() {}

  init(cursorKey: String, startingWalletId: String?, offset: Int) {
    self.cursorKey = cursorKey
    self.startingWalletId = startingWalletId ?? ""
    self.offset = offset
  }

  func perform() async throws -> some IntentResult {
    let wallets = WidgetStore.loadSnapshot()?.orderedWallets ?? []
    let current = WalletSelection.resolve(
      wallets: wallets,
      startingWalletId: startingWalletId.isEmpty ? nil : startingWalletId,
      cursor: WidgetStore.cursor(for: cursorKey))
    if let current {
      let next = WalletSelection.step(from: current, by: offset, count: wallets.count)
      WidgetStore.setCursor(WidgetStore.Cursor(walletId: wallets[next].id, index: next), for: cursorKey)
    }
    return .result()
  }
}
