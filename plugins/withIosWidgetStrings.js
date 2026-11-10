// Localises the iPhone widget extension (#1849) from the app's own
// catalogues. At `expo prebuild` it writes `<lang>.lproj/Localizable.strings`
// and `Localizable.stringsdict` for every src/i18n/locales/<lang>.json into
// the widget's source folder (targets/widget, linked into Xcode by
// @bacons/apple-targets as a synchronised folder, so the files are bundled
// without touching the project file). The generated folders are gitignored:
// the JSON catalogues stay the single copy of the text.
//
// Only the `widget` namespace is exported; the Swift code looks strings up
// by their catalogue path (e.g. `widget.receive`).
const fs = require('fs');
const path = require('path');
const { withDangerousMod } = require('expo/config-plugins');
const { collectEntries, buildAppleStrings } = require('./iosWidgetStrings');

const LOCALES_DIR = 'src/i18n/locales';

function writeWidgetStrings(projectRoot, { targetDir, prefixes }) {
  const localesDir = path.join(projectRoot, LOCALES_DIR);
  const outDir = path.join(projectRoot, targetDir);
  const read = (file) => JSON.parse(fs.readFileSync(path.join(localesDir, file), 'utf8'));
  const englishEntries = collectEntries(read('en.json'), prefixes);

  // Drop folders from an earlier run (e.g. a locale that has since been removed).
  for (const entry of fs.readdirSync(outDir)) {
    if (entry.endsWith('.lproj')) fs.rmSync(path.join(outDir, entry), { recursive: true });
  }

  const locales = fs
    .readdirSync(localesDir)
    .filter((file) => file.endsWith('.json'))
    .map((file) => file.replace(/\.json$/, ''));
  for (const locale of locales) {
    const entries = collectEntries(read(`${locale}.json`), prefixes);
    const { strings, stringsdict, skipped } = buildAppleStrings(entries, englishEntries, locale);
    if (skipped.length > 0) {
      console.warn(
        `[withIosWidgetStrings] ${locale}: skipped plural strings with placeholders other than {{count}}: ${skipped.join(', ')}`,
      );
    }
    const lproj = path.join(outDir, `${locale}.lproj`);
    fs.mkdirSync(lproj, { recursive: true });
    fs.writeFileSync(path.join(lproj, 'Localizable.strings'), strings);
    fs.writeFileSync(path.join(lproj, 'Localizable.stringsdict'), stringsdict);
  }
}

const withIosWidgetStrings = (
  config,
  { targetDir = 'targets/widget', prefixes = ['widget'] } = {},
) =>
  withDangerousMod(config, [
    'ios',
    async (modConfig) => {
      writeWidgetStrings(modConfig.modRequest.projectRoot, { targetDir, prefixes });
      return modConfig;
    },
  ]);

module.exports = withIosWidgetStrings;
module.exports.writeWidgetStrings = writeWidgetStrings;
