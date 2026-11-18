const fs = require('fs');
const path = require('path');
const {
  AndroidConfig,
  withAndroidManifest,
  withDangerousMod,
  withStringsXml,
} = require('expo/config-plugins');

/**
 * Translates the home-screen widget's name and description in the launcher's
 * widget picker (#1849). react-native-android-widget writes the label as a
 * literal and the description as an untranslatable string, so this plugin:
 *   - points each widget receiver's `android:label` at `@string/widget_picker_<name>_label`,
 *   - adds `android:description="@string/widget_picker_<name>_description"` to
 *     each widget provider XML,
 *   - writes those strings to `values/` (English) and to a `values-<lang>/`
 *     file per app language, from `src/i18n/locales/<lang>.json` → `widget.picker`.
 *
 * ORDER: Expo runs mods last-registered-first, so this plugin must be listed
 * BEFORE `react-native-android-widget` in app.config.ts — its edits then run
 * after the library has created the receivers and provider XML files.
 *
 * Options: `{ widgets: [{ name, pickerKey }] }`, where `pickerKey` is the
 * `widget.picker.<pickerKey>Label` / `<pickerKey>Description` key prefix.
 */

const localesDir = (projectRoot) => path.join(projectRoot, 'src', 'i18n', 'locales');

// Android resource qualifier per app language. Every Chinese variant reads the
// Simplified catalogue in the app, so `values-zh` (all Chinese) mirrors that.
const RESOURCE_QUALIFIER = { 'zh-Hans': 'zh' };

function escapeAndroidString(value) {
  return String(value)
    .replace(/\\/g, '\\\\')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/^([@?])/, '\\$1')
    .replace(/\n/g, '\\n');
}

function stringName(widget, kind) {
  return `widget_picker_${widget.name.toLowerCase()}_${kind}`;
}

function pickerStrings(projectRoot, locale, widgets) {
  const file = path.join(localesDir(projectRoot), `${locale}.json`);
  const catalogue = JSON.parse(fs.readFileSync(file, 'utf8'));
  const picker = (catalogue.widget && catalogue.widget.picker) || {};
  const out = [];
  for (const widget of widgets) {
    for (const kind of ['label', 'description']) {
      const key = `${widget.pickerKey}${kind === 'label' ? 'Label' : 'Description'}`;
      if (typeof picker[key] === 'string' && picker[key]) {
        out.push({ name: stringName(widget, kind), value: picker[key] });
      }
    }
  }
  return out;
}

function otherLocales(projectRoot) {
  return fs
    .readdirSync(localesDir(projectRoot))
    .filter((file) => file.endsWith('.json') && file !== 'en.json')
    .map((file) => file.replace(/\.json$/, ''));
}

module.exports = function withWidgetPickerStrings(config, { widgets }) {
  // English (the default resources). Raw values: Expo escapes them on write.
  config = withStringsXml(config, (stringsConfig) => {
    stringsConfig.modResults = AndroidConfig.Strings.setStringItem(
      pickerStrings(stringsConfig.modRequest.projectRoot, 'en', widgets).map(({ name, value }) => ({
        $: { name },
        _: value,
      })),
      stringsConfig.modResults,
    );
    return stringsConfig;
  });

  // Receiver labels → string resources.
  config = withAndroidManifest(config, (manifestConfig) => {
    const app = AndroidConfig.Manifest.getMainApplicationOrThrow(manifestConfig.modResults);
    for (const receiver of app.receiver ?? []) {
      const receiverName = receiver.$['android:name'] || '';
      const widget = widgets.find((w) => receiverName.endsWith(`.${w.name}`));
      if (widget) receiver.$['android:label'] = `@string/${stringName(widget, 'label')}`;
    }
    return manifestConfig;
  });

  // Provider descriptions + the translated string files.
  config = withDangerousMod(config, [
    'android',
    async (dangerousConfig) => {
      const resDir = path.join(
        dangerousConfig.modRequest.platformProjectRoot,
        'app',
        'src',
        'main',
        'res',
      );
      for (const widget of widgets) {
        const xmlPath = path.join(resDir, 'xml', `widgetprovider_${widget.name.toLowerCase()}.xml`);
        if (!fs.existsSync(xmlPath)) {
          throw new Error(
            `withWidgetPickerStrings: ${xmlPath} not found — list this plugin before react-native-android-widget.`,
          );
        }
        const xml = fs
          .readFileSync(xmlPath, 'utf8')
          .replace(/\s*android:description="[^"]*"/, '')
          .replace(
            /<appwidget-provider\b/,
            `<appwidget-provider android:description="@string/${stringName(widget, 'description')}"`,
          );
        fs.writeFileSync(xmlPath, xml);
      }
      const { projectRoot } = dangerousConfig.modRequest;
      for (const locale of otherLocales(projectRoot)) {
        const strings = pickerStrings(projectRoot, locale, widgets);
        if (strings.length === 0) continue;
        const dir = path.join(resDir, `values-${RESOURCE_QUALIFIER[locale] ?? locale}`);
        fs.mkdirSync(dir, { recursive: true });
        const body = strings
          .map(
            ({ name, value }) => `  <string name="${name}">${escapeAndroidString(value)}</string>`,
          )
          .join('\n');
        fs.writeFileSync(
          path.join(dir, 'widget_picker_strings.xml'),
          `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n${body}\n</resources>\n`,
        );
      }
      return dangerousConfig;
    },
  ]);

  return config;
};
