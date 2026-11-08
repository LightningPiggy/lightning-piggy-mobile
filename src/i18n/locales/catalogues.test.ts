import { SUPPORTED_LOCALES, loadAllCatalogues } from '..';
import { CARDINAL_RULES, requiredPluralCategories } from '../plurals';

const translations = loadAllCatalogues();

type Tree = { [key: string]: string | Tree };

const CLDR_CATEGORIES = ['zero', 'one', 'two', 'few', 'many', 'other'];

const en = translations.en as unknown as Tree;

/** Ceiling on the share of (non-trivial) strings left identical to English. */
const MAX_IDENTICAL_SHARE = 0.05;

/** Words every language keeps as-is: brand / protocol names (GLOSSARY.md),
 *  units, and tech loanwords. Stripped before deciding whether an English
 *  string has anything left to translate. */
const UNTRANSLATED_TERMS =
  /Lightning Piggy|Bitcoin|Lightning|Nostr|Marmot|White Noise|Amethyst|NIP-GC|NIP-\d+|NWC|Amber|Clave|Blossom|LNURL|Boltz|MLS|Electrum|CoinOS|Coinos|Piggy|Piglets?|sats?|SATS|BTC( Map)?|npub|nsec|GIPHY|OpenStreetMap|Facebook|Instagram|QR|NFC|URL|PIN|ID|OK|Zaps?|On-chain|on-chain|Admin|Relay|Swap|Preimage|geohash/g;

/** True when an English string has nothing translatable once placeholders,
 *  URLs, addresses and UNTRANSLATED_TERMS are removed (e.g. "{{amount}} sats",
 *  "NWC", "Zap ({{reason}})"). */
function isLegitimatelyIdentical(source: string): boolean {
  const rest = source
    .replace(/\{\{[^}]+\}\}|%\{[^}]+\}|https?:\S+|\S+@\S+/g, '')
    .replace(UNTRANSLATED_TERMS, '');
  return !/\p{L}{2,}/u.test(rest);
}
const others = SUPPORTED_LOCALES.filter((l) => l !== 'en');

function isPluralObject(node: Tree): boolean {
  const keys = Object.keys(node);
  return keys.length > 0 && keys.every((k) => CLDR_CATEGORIES.includes(k));
}

function leaves(tree: Tree, prefix = ''): Map<string, string> {
  const out = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(path, value);
    else for (const [k, v] of leaves(value, path)) out.set(k, v);
  }
  return out;
}

/** Every plural object (path → node) in a catalogue. */
function pluralObjects(tree: Tree, prefix = ''): Map<string, Tree> {
  const out = new Map<string, Tree>();
  for (const [key, value] of Object.entries(tree)) {
    if (typeof value === 'string') continue;
    const path = prefix ? `${prefix}.${key}` : key;
    if (isPluralObject(value)) out.set(path, value);
    else for (const [k, v] of pluralObjects(value, path)) out.set(k, v);
  }
  return out;
}

/** Sorted `{{name}}` and `%{name}` interpolations (i18n-js supports both). */
function placeholders(s: string): string {
  return (s.match(/\{\{\s*[\w.]+\s*\}\}|%\{\s*\w+\s*\}/g) ?? [])
    .map((p) => p.replace(/\s+/g, ''))
    .sort()
    .join(',');
}

/** Key paths in `tree` missing from / extra to `ref`. Extra keys are allowed
 *  only as additional CLDR categories inside a plural object (e.g. `few` and
 *  `many` for Polish and Ukrainian). */
function structuralDiff(ref: Tree, tree: Tree, prefix = ''): string[] {
  const errors: string[] = [];
  for (const [key, value] of Object.entries(ref)) {
    const path = prefix ? `${prefix}.${key}` : key;
    const other = tree[key];
    if (other === undefined) errors.push(`missing ${path}`);
    else if (typeof value === 'string') {
      if (typeof other !== 'string') errors.push(`not a string ${path}`);
    } else if (typeof other === 'string') errors.push(`not an object ${path}`);
    else errors.push(...structuralDiff(value, other, path));
  }
  const plural = isPluralObject(ref);
  for (const key of Object.keys(tree)) {
    if (key in ref) continue;
    if (!(plural && CLDR_CATEGORIES.includes(key))) {
      errors.push(`extra ${prefix ? `${prefix}.` : ''}${key}`);
    }
  }
  return errors;
}

describe('locale registry', () => {
  it('registers a catalogue and a CLDR plural rule for every supported locale', () => {
    expect(Object.keys(translations).sort()).toEqual([...SUPPORTED_LOCALES].sort());
    for (const locale of SUPPORTED_LOCALES) {
      expect(CARDINAL_RULES).toHaveProperty([locale]);
    }
  });
});

describe.each(others)('%s catalogue', (locale) => {
  const tree = translations[locale] as unknown as Tree;
  const enLeaves = leaves(en);
  const localeLeaves = leaves(tree);

  it('has exactly the keys en.json has (plus extra CLDR plural forms only)', () => {
    expect(structuralDiff(en, tree)).toEqual([]);
  });

  it('keeps every placeholder of the English source, and no strings are empty', () => {
    const errors: string[] = [];
    for (const [path, value] of localeLeaves) {
      if (!value.trim()) errors.push(`empty ${path}`);
      // An extra CLDR form (`few`/`many`) has no en counterpart: compare it
      // with en's `other` form of the same plural object.
      const source =
        enLeaves.get(path) ?? enLeaves.get(path.replace(/\.(zero|one|two|few|many)$/, '.other'));
      if (source !== undefined && placeholders(source) !== placeholders(value)) {
        errors.push(`placeholders ${path}: "${placeholders(source)}" vs "${placeholders(value)}"`);
      }
    }
    expect(errors).toEqual([]);
  });

  it('defines every plural form a whole-number count can need (CLDR)', () => {
    const needed = requiredPluralCategories(locale);
    const errors: string[] = [];
    for (const [path, node] of pluralObjects(tree)) {
      for (const category of needed) {
        if (typeof node[category] !== 'string') errors.push(`${path} lacks "${category}"`);
      }
    }
    expect(errors).toEqual([]);
  });

  // #948 regression: a bad merge replaced ~1,500 existing Ukrainian strings
  // with the English source. Key parity can't catch that (English values
  // still have the right keys), so guard the catalogue's content too.
  it('is not just copied English', () => {
    let shared = 0;
    const identical: string[] = [];
    for (const [path, value] of localeLeaves) {
      const source = enLeaves.get(path);
      if (source === undefined || isLegitimatelyIdentical(source)) continue;
      shared++;
      if (source === value) identical.push(path);
    }
    expect(shared).toBeGreaterThan(1000);
    // Real catalogues sit at 1-2% (loanwords like "Admin", "Status"); a bulk
    // overwrite with English pushes this far past the ceiling.
    const share = identical.length / shared;
    if (share >= MAX_IDENTICAL_SHARE) {
      throw new Error(
        `${locale}: ${(share * 100).toFixed(1)}% of strings are identical to English ` +
          `(max ${MAX_IDENTICAL_SHARE * 100}%). Untranslated keys:\n  ${identical.join('\n  ')}`,
      );
    }
  });
});

describe('uk catalogue (#948 spot checks)', () => {
  it('keeps long-standing translations rather than the English source', () => {
    const uk = leaves(translations.uk as unknown as Tree);
    expect(uk.get('tabs.wallets')).toBe('Гаманці');
    expect(uk.get('aboutScreen.sendFeedback')).toBe('Надіслати відгук');
    expect(uk.get('orderPaymentActions.scanHint')).toBe('Відскануйте будь-яким гаманцем Lightning');
  });
});

// #1375: removed drawer subtitles must not linger in any catalogue, including en.
describe.each(SUPPORTED_LOCALES)('%s compact account drawer', (locale) => {
  it('removes all obsolete row subtitle keys', () => {
    const drawer = translations[locale].accountDrawerContent;
    for (const key of [
      'profileHint',
      'walletsHint',
      'messagesHint',
      'notificationsHint',
      'securityHint',
      'displayLanguageHint',
      'aboutHint',
      'advancedHint',
    ]) {
      expect(drawer).not.toHaveProperty(key);
    }
  });
});
