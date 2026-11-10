// Turns the app's i18n catalogues (src/i18n/locales/<lang>.json) into the
// Apple string files the iPhone widget extension reads (#1849):
//   <lang>.lproj/Localizable.strings      plain and placeholder strings
//   <lang>.lproj/Localizable.stringsdict  plural strings (CLDR forms)
// Generated at prebuild by withIosWidgetStrings.js, so the JSON catalogues
// stay the only copy of the text. Pure functions, unit-tested in
// iosWidgetStrings.test.ts.

const cardinals = require('make-plural/cardinals');

const PLURAL_FORMS = ['zero', 'one', 'two', 'few', 'many', 'other'];
// i18n-js's exact-one form. Apple's stringsdict has no equivalent, so it is
// written as a plain `<key>.=1` string that L10n.plural uses for a count of 1.
const EXACTLY_ONE = '=1';
const IGNORED_PLURAL_KEYS = [EXACTLY_ONE];
const PLACEHOLDER = /\{\{\s*(\w+)\s*\}\}|%\{(\w+)\}/g;
const COUNT_PLACEHOLDER = /\{\{\s*count\s*\}\}|%\{\s*count\s*\}/g;

/** True when CLDR `one` in `locale` covers a whole number other than 1
 *  (Ukrainian 21, 31…; Hindi 0). Mirrors src/i18n/plurals.ts. */
function oneCoversOtherNumbers(locale) {
  const rule = cardinals[locale] ?? cardinals[String(locale).split('-')[0]];
  if (!rule) return false;
  for (let n = 0; n <= 200; n++) if (n !== 1 && rule(n) === 'one') return true;
  return false;
}

/**
 * The app's pinCountlessSingulars (src/i18n/plurals.ts), for Apple: where
 * `one` also covers 21, 31… a `one` form that doesn't show the number
 * ("1 хв тому") must only be used for exactly 1, so it moves to `=1` and
 * every other `one` count falls through to `other`, as it does in the app.
 * Returns { forms, exactlyOne }.
 */
function pinExactlyOne(node, locale) {
  const forms = { ...node };
  let exactlyOne = forms[EXACTLY_ONE];
  delete forms[EXACTLY_ONE];
  if (
    exactlyOne === undefined &&
    typeof forms.one === 'string' &&
    !forms.one.match(COUNT_PLACEHOLDER) &&
    oneCoversOtherNumbers(locale)
  ) {
    exactlyOne = forms.one;
    delete forms.one;
  }
  return { forms, exactlyOne };
}

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
 * @param {string} locale catalogue code (`uk`, `zh-Hans`, …)
 * @returns {{ strings: string, stringsdict: string, skipped: string[] }}
 */
function buildAppleStrings(entries, englishEntries, locale) {
  const lines = [];
  const plurals = [];
  const skipped = [];
  for (const key of Object.keys(entries).sort()) {
    const raw = entries[key];
    const reference = englishEntries[key] ?? raw;
    if (typeof raw === 'string') {
      const order = placeholderNames(typeof reference === 'string' ? reference : raw);
      lines.push(`"${escapeStrings(key)}" = "${escapeStrings(toFormat(raw, order))}";`);
      continue;
    }
    const { forms: value, exactlyOne } = pinExactlyOne(raw, locale);
    const forms = PLURAL_FORMS.filter((form) => typeof value[form] === 'string');
    const names = [...new Set(forms.flatMap((form) => placeholderNames(value[form])))];
    if (names.some((name) => name !== 'count')) {
      skipped.push(key);
      continue;
    }
    if (exactlyOne !== undefined) {
      const text = exactlyOne.replace(COUNT_PLACEHOLDER, '1');
      lines.push(`"${escapeStrings(`${key}.${EXACTLY_ONE}`)}" = "${escapeStrings(text)}";`);
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

module.exports = {
  collectEntries,
  buildAppleStrings,
  toFormat,
  placeholderNames,
  isPluralNode,
  oneCoversOtherNumbers,
};
