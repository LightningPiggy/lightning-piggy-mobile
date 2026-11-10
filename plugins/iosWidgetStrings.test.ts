/** @jest-environment node */
import fs from 'node:fs';
import path from 'node:path';
import { buildAppleStrings, collectEntries, placeholderNames, toFormat } from './iosWidgetStrings';

describe('collectEntries', () => {
  it('flattens only the requested namespaces, keeping plural nodes whole', () => {
    const catalogue = {
      other: { ignored: 'x' },
      widget: {
        receive: 'Receive',
        nested: { title: 'Title' },
        minutes: { one: '1 min ago', other: '{{count}} min ago' },
      },
    };
    expect(collectEntries(catalogue, ['widget'])).toEqual({
      'widget.receive': 'Receive',
      'widget.nested.title': 'Title',
      'widget.minutes': { one: '1 min ago', other: '{{count}} min ago' },
    });
  });

  it('returns nothing for a missing namespace', () => {
    expect(collectEntries({ a: 'b' }, ['widget'])).toEqual({});
  });
});

describe('toFormat', () => {
  it('leaves text without placeholders untouched, % included', () => {
    expect(toFormat('100% Piggy', [])).toBe('100% Piggy');
  });

  it('uses %@ for a single placeholder and escapes a literal %', () => {
    expect(toFormat('{{name}} is 100% ready', ['name'])).toBe('%@ is 100%% ready');
  });

  it('numbers several placeholders by their English order', () => {
    const order = placeholderNames('Wallet {{index}} of {{total}}');
    expect(toFormat('{{total}}中的第 {{index}} 个', order)).toBe('%2$@中的第 %1$@ 个');
  });

  it('understands the %{name} form too', () => {
    expect(toFormat('Save %{filename}', ['filename'])).toBe('Save %@');
  });
});

describe('buildAppleStrings', () => {
  const english = {
    'widget.receive': 'Receive',
    'widget.quote': 'Say "hi"\\now',
    'widget.position': 'Wallet {{index}} of {{total}}',
    'widget.minutes': { one: '1 min ago', other: '{{count}} min ago' },
    'widget.bad': { one: '{{name}} one', other: '{{name}} {{count}}' },
  };

  it('writes escaped .strings lines and a plural stringsdict', () => {
    const { strings, stringsdict, skipped } = buildAppleStrings(english, english);
    expect(strings).toContain('"widget.receive" = "Receive";');
    expect(strings).toContain('"widget.quote" = "Say \\"hi\\"\\\\now";');
    expect(strings).toContain('"widget.position" = "Wallet %1$@ of %2$@";');
    expect(stringsdict).toContain('<key>widget.minutes</key>');
    expect(stringsdict).toContain('<string>%#@count@</string>');
    expect(stringsdict).toContain('<key>other</key>\n      <string>%d min ago</string>');
    expect(skipped).toEqual(['widget.bad']);
  });

  it('keeps every CLDR form a language defines', () => {
    const ukrainian = {
      'widget.minutes': {
        one: '{{count}} хв',
        few: '{{count}} хв',
        many: '{{count}} хв',
        other: '{{count}} хв',
      },
    };
    const { stringsdict } = buildAppleStrings(ukrainian, english);
    for (const form of ['one', 'few', 'many', 'other']) {
      expect(stringsdict).toContain(`<key>${form}</key>`);
    }
  });
});

describe('the real catalogues', () => {
  const localesDir = path.join(__dirname, '../src/i18n/locales');
  const read = (file: string) => JSON.parse(fs.readFileSync(path.join(localesDir, file), 'utf8'));
  const english = collectEntries(read('en.json'), ['widget']);

  it.each(fs.readdirSync(localesDir).filter((file) => file.endsWith('.json')))(
    '%s converts with no skipped strings and keeps "sats" in Latin script',
    (file) => {
      const entries = collectEntries(read(file), ['widget']);
      const { strings, skipped } = buildAppleStrings(entries, english);
      expect(skipped).toEqual([]);
      if (english['widget.satsUnit']) expect(strings).toContain('"widget.satsUnit" = "sats";');
    },
  );
});
