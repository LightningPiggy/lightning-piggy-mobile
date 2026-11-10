// Two build-setting fixes for the iPhone widget extension (#1849), applied to
// the target @bacons/apple-targets generates:
//
// 1. Weak-link ActivityKit (iOS 16.1+) and AppIntents (iOS 16+). The library
//    links every widget target against them as REQUIRED frameworks, and a
//    required framework the OS doesn't have stops the extension loading at
//    all. The widget keeps the app's deployment target (iOS 15.1) so iOS 15–16
//    still get the static widget; its Swift only uses them behind
//    `#available`. This is Xcode's "Optional" framework status.
//
// 2. Make targets/widget/Info.plist the only source of the widget's
//    Info.plist (GENERATE_INFOPLIST_FILE = NO). With generation on, Xcode
//    takes CFBundleVersion from CURRENT_PROJECT_VERSION (1 after prebuild)
//    and ignores the plist's value, but EAS sets the remote build number by
//    writing CFBundleVersion into each signed target's Info.plist. Without
//    this the widget would ship build 1 inside an app with build N.
//
// Must be listed BEFORE '@bacons/apple-targets' in app.config.ts: mods of the
// same kind run in reverse registration order, so these edits land after the
// target has been created.
const { withXcodeProjectBeta } = require('@bacons/apple-targets/build/with-bacons-xcode');

const WEAK_FRAMEWORKS = ['ActivityKit', 'AppIntents'];

function applyWidgetTargetSettings(project, productName) {
  const target = project.rootObject.props.targets.find(
    (candidate) => candidate.props.productName === productName,
  );
  if (!target) {
    throw new Error(`[withWidgetTargetSettings] no "${productName}" target in the Xcode project`);
  }
  for (const buildFile of target.ensureFrameworks(WEAK_FRAMEWORKS)) {
    buildFile.props.settings = { ...buildFile.props.settings, ATTRIBUTES: ['Weak'] };
  }
  target.setBuildSetting('GENERATE_INFOPLIST_FILE', 'NO');
}

const withWidgetTargetSettings = (config, { productName = 'LightningPiggyWidget' } = {}) =>
  withXcodeProjectBeta(config, (modConfig) => {
    applyWidgetTargetSettings(modConfig.modResults, productName);
    return modConfig;
  });

module.exports = withWidgetTargetSettings;
module.exports.applyWidgetTargetSettings = applyWidgetTargetSettings;
