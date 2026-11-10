// iPhone home-screen widget (#1849): a WidgetKit extension built by
// @bacons/apple-targets. Prebuild links this folder into the generated Xcode
// project as its own target; nothing under `ios/` is committed.
//
// Variants: the extension's bundle id is the app's bundle id + `.widget`
// (com.lightningpiggy.app[.dev|.preview].widget), and it shares the app's
// App Group `group.<app bundle id>`, so dev, preview and production installs
// never read each other's wallet snapshot. The Swift code derives the same
// group from its own bundle id at runtime (see Snapshot.swift).
//
// Deployment target: the app's own (Expo SDK 55 default, iOS 15.1). iOS 17+
// gets the configurable, interactive widget; iOS 15–16 get a static one
// (first wallet, Piggy pink style, no ‹ › buttons). See WalletWidget.swift.

/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (config) => ({
  type: 'widget',
  name: 'LightningPiggyWidget',
  displayName: 'Lightning Piggy',
  bundleIdentifier: '.widget',
  deploymentTarget: '15.1',
  colors: {
    // Tint of the controls in the Edit Widget sheet.
    $accent: '#FF2D95',
    // Fallback background behind the widget's own gradient.
    $widgetBackground: '#FF2D95',
  },
  entitlements: {
    'com.apple.security.application-groups': [`group.${config.ios.bundleIdentifier}`],
  },
});
