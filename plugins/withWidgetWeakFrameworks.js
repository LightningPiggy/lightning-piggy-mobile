// The iPhone widget extension (#1849) keeps the app's deployment target
// (iOS 15.1) so iOS 15–16 still get the static widget. @bacons/apple-targets
// links every widget target against ActivityKit (iOS 16.1+) and AppIntents
// (iOS 16+) as REQUIRED frameworks, and a required framework the OS doesn't
// have stops the extension loading at all. This marks them Optional (weak),
// Xcode's "Optional" status; the Swift code only touches them behind
// `#available` checks.
//
// Must be listed BEFORE '@bacons/apple-targets' in app.config.ts: mods of the
// same kind run in reverse registration order, so this edit lands after the
// target has been created.
const { withXcodeProjectBeta } = require('@bacons/apple-targets/build/with-bacons-xcode');

const WEAK_FRAMEWORKS = ['ActivityKit', 'AppIntents'];

const withWidgetWeakFrameworks = (config, { productName = 'LightningPiggyWidget' } = {}) =>
  withXcodeProjectBeta(config, (modConfig) => {
    const project = modConfig.modResults;
    const target = project.rootObject.props.targets.find(
      (candidate) => candidate.props.productName === productName,
    );
    if (!target) {
      throw new Error(`[withWidgetWeakFrameworks] no "${productName}" target in the Xcode project`);
    }
    for (const buildFile of target.ensureFrameworks(WEAK_FRAMEWORKS)) {
      buildFile.props.settings = { ...buildFile.props.settings, ATTRIBUTES: ['Weak'] };
    }
    return modConfig;
  });

module.exports = withWidgetWeakFrameworks;
