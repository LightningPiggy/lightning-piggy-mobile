import Foundation

/// Widget text, in the language the user chose in the app.
///
/// The `<lang>.lproj/Localizable.strings(dict)` files are generated at prebuild
/// from src/i18n/locales/*.json by plugins/withIosWidgetStrings.js, so the
/// app's catalogues stay the only copy. Keys are the catalogue paths
/// (e.g. `widget.receive`). The app shares its chosen language through the
/// App Group; without one, the system's language order applies.
enum L10n {
  private static let fallbackLanguage = "en"

  /// The language whose `.lproj` the widget reads.
  static var language: String {
    if let chosen = WidgetStore.appLocale, bundlePath(for: chosen) != nil { return chosen }
    return Bundle.main.preferredLocalizations.first ?? fallbackLanguage
  }

  static var locale: Locale { Locale(identifier: language) }

  static func string(_ key: String) -> String {
    let value = bundle.localizedString(forKey: key, value: missing, table: nil)
    if value != missing { return value }
    let english = englishBundle.localizedString(forKey: key, value: missing, table: nil)
    return english != missing ? english : key
  }

  /// `{{name}}`-style placeholders become `%@` / `%1$@` in the generated
  /// files, in the order they appear in the English string.
  static func format(_ key: String, _ args: CVarArg...) -> String {
    String(format: string(key), locale: locale, arguments: args)
  }

  /// Plural strings live in Localizable.stringsdict (one entry per CLDR form).
  static func plural(_ key: String, count: Int) -> String {
    String(format: string(key), locale: locale, count)
  }

  // MARK: Bundles

  private static let missing = "\u{0}missing"

  private static func bundlePath(for language: String) -> String? {
    Bundle.main.path(forResource: language, ofType: "lproj")
  }

  private static var bundle: Bundle {
    if let path = bundlePath(for: language), let bundle = Bundle(path: path) { return bundle }
    return englishBundle
  }

  private static var englishBundle: Bundle {
    if let path = bundlePath(for: fallbackLanguage), let bundle = Bundle(path: path) { return bundle }
    return .main
  }
}
