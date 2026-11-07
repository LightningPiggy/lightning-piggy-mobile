const { withAppBuildGradle } = require('expo/config-plugins');

/**
 * Builds one release APK per CPU architecture instead of one universal APK.
 *
 * The universal production APK carried native libraries for all four ABIs
 * (~320 MB). Gradle's ABI splits emit `app-arm64-v8a-release.apk` (nearly
 * every phone) and `app-armeabi-v7a-release.apk` (older 32-bit phones). The
 * x86 / x86_64 emulator ABIs are left out of the release; dev and preview
 * builds don't use this plugin, so emulators keep working with those.
 *
 * versionCode: deliberately NO per-ABI offset (`versionCodeOverride`). Both
 * APKs keep the versionCode EAS's remote counter assigns, so either one
 * upgrades an existing install in place (`adb install -r`), and the integer
 * stays in step with the iOS build and any future Play upload. An offset is
 * only needed to publish several APKs to one Play listing, which an AAB
 * replaces.
 *
 * Wired in app.config.ts for the production variant only. Release workflow
 * and doc: docs/DEPLOYMENT.adoc → "Android release APKs".
 */
const ABIS = ['arm64-v8a', 'armeabi-v7a'];
const MARKER = '// withAndroidAbiSplits: per-ABI release APKs';

function addAbiSplits(contents) {
  if (contents.includes(MARKER)) return contents;
  const androidBlock = /^android\s*\{[^\S\n]*$/m;
  if (!androidBlock.test(contents)) {
    throw new Error('withAndroidAbiSplits: no top-level `android {` block in app/build.gradle');
  }
  const splits = [
    `    ${MARKER} (plugins/withAndroidAbiSplits.js)`,
    '    splits {',
    '        abi {',
    '            enable true',
    '            reset()',
    `            include ${ABIS.map((abi) => `"${abi}"`).join(', ')}`,
    '            universalApk false',
    '        }',
    '    }',
  ].join('\n');
  return contents.replace(androidBlock, (line) => `${line}\n${splits}`);
}

module.exports = function withAndroidAbiSplits(config) {
  return withAppBuildGradle(config, (config) => {
    if (config.modResults.language !== 'groovy') {
      throw new Error('withAndroidAbiSplits: expected a Groovy app/build.gradle');
    }
    config.modResults.contents = addAbiSplits(config.modResults.contents);
    return config;
  });
};

module.exports.addAbiSplits = addAbiSplits;
