// Turns the app's i18n catalogues (src/i18n/locales/<lang>.json) into the
// Apple string files the iPhone widget extension reads (#1849):
//   <lang>.lproj/Localizable.strings      plain and placeholder strings
//   <lang>.lproj/Localizable.stringsdict  plural strings (CLDR forms)
// Generated at prebuild by withIosWidgetStrings.js, so the JSON catalogues
// stay the only copy of the text. Pure functions, unit-tested in
// iosWidgetStrings.test.ts.

const PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];
// i18n-js's exact-one form; Apple has no equivalent, `one` covers it.
const IGNORED_PLURAL_KEYS = ['=1'];
const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}|%\{(\w+)\}/g;

function isPluralNode(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
  const keys = Object.keys(node);
  return (
    keys.includes('other') &&
    keys.every(
      (k) =>
        (PLURAL_FORMS.includes(k) || IGNORED_PLURAL_KEYS.includes(k)) &&
        typeof node[k] === 'string',
    )
  );
}

/**
 * Flattens the subtree at each prefix into { 'a.b.c': string | pluralNode }.
 * @param {Record<string, unknown>} catalogue
 * @param {string[]} prefixes
 * @returns {Record<string, string | Record<string, string>>}
 */
function collectEntries(catalogue, prefixes) {
  const out = {};
  const walk = (node, path) => {
    if (typeof node === 'string' || isPluralNode(node)) {
      out[path] = node;
      return;
    }
    if (node && typeof node === 'object') {
      for (const [key, child] of Object.entries(node)) walk(child, `${path}.${key}`);
    }
  };
  for (const prefix of prefixes) {
    const node = prefix.split('.').reduce((acc, key) => (acc ? acc[key] : undefined), catalogue);
    if (node !== undefined) walk(node, prefix);
  }
  return out;
}

function placeholderNames(text) {
  const names = [];
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1] || match[2];
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

/**
 * i18n placeholders → printf. `order` is the English string's placeholder
 * order, so every language passes the same arguments; with more than one
 * placeholder they become positional (`%1$@`, `%2$@`) because translations
 * may reorder them. Text with placeholders is a format string, so a literal
 * `%` is doubled; text without any is used as-is.
 */
function toFormat(text, order, spec = () => '@') {
  if (order.length === 0) return text;
  const escaped = text.replace(/%(?!\{)/g, '%%');
  return escaped.replace(PLACEHOLDER, (whole, a, b) => {
    const name = a || b;
    const position = order.indexOf(name);
    if (position === -1) return whole;
    return order.length === 1 ? `%${spec(name)}` : `%${position + 1}$${spec(name)}`;
  });
}

function escapeStrings(text) {
  return text.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

function escapeXml(text) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Builds both files for one locale. `english` supplies placeholder order.
 * Returns { strings, stringsdict, skipped } where `skipped` lists keys that
 * can't be expressed (a plural with a placeholder other than `count`).
 * @param {Record<string, string | Record<string, string>>} entries
 * @param {Record<string, string | Record<string, string>>} englishEntries
 * @returns {{ strings: string, stringsdict: string, skipped: string[] }}
 */
function buildAppleStrings(entries, englishEntries) {
  const lines = [];
  const plurals = [];
  const skipped = [];
  for (const key of Object.keys(entries).sort()) {
    const value = entries[key];
    const reference = englishEntries[key] ?? value;
    if (typeof value === 'string') {
      const order = placeholderNames(typeof reference === 'string' ? reference : value);
      lines.push(`"${escapeStrings(key)}" = "${escapeStrings(toFormat(value, order))}";`);
      continue;
    }
    const forms = PLURAL_FORMS.filter((form) => typeof value[form] === 'string');
    const names = [...new Set(forms.flatMap((form) => placeholderNames(value[form])))];
    if (names.some((name) => name !== 'count')) {
      skipped.push(key);
      continue;
    }
    const formXml = forms
      .map((form) => {
        const text = toFormat(value[form], names, () => 'd');
        return `      <key>${form}</key>\n      <string>${escapeXml(text)}</string>`;
      })
      .join('\n');
    plurals.push(
      [
        `  <key>${escapeXml(key)}</key>`,
        '  <dict>',
        '    <key>NSStringLocalizedFormatKey</key>',
        '    <string>%#@count@</string>',
        '    <key>count</key>',
        '    <dict>',
        '      <key>NSStringFormatSpecTypeKey</key>',
        '      <string>NSStringPluralRuleType</string>',
        '      <key>NSStringFormatValueTypeKey</key>',
        '      <string>d</string>',
        formXml,
        '    </dict>',
        '  </dict>',
      ].join('\n'),
    );
  }
  const header =
    '/* Generated from src/i18n/locales by plugins/withIosWidgetStrings.js. Do not edit. */';
  const strings = `${header}\n${lines.join('\n')}\n`;
  const stringsdict = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<!-- Generated from src/i18n/locales by plugins/withIosWidgetStrings.js. Do not edit. -->',
    '<plist version="1.0">',
    '<dict>',
    ...plurals,
    '</dict>',
    '</plist>',
    '',
  ].join('\n');
  return { strings, stringsdict, skipped };
}

module.exports = { collectEntries, buildAppleStrings, toFormat, placeholderNames, isPluralNode };
