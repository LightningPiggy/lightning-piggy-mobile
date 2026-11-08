import * as Application from 'expo-application';
import enJson from '../i18n/locales/en.json';
import { SUPPORTED_LOCALES, loadAllCatalogues } from '../i18n';
import { requiredPluralCategories } from '../i18n/plurals';
import { validateCatalogue, type Catalogue } from './i18nSync';
import {
  PSEUDO_LOCALE,
  createPseudoI18nInstance,
  isPseudoLocaleAvailable,
  pseudoCatalogue,
  pseudoLocalize,
} from './pseudoLocale';

jest.mock('expo-application', () => ({ applicationId: 'com.lightningpiggy.app.dev' }));

const translations = loadAllCatalogues();

type Tree = { [key: string]: string | Tree };

function leaves(tree: Tree): string[] {
  return Object.values(tree).flatMap((v) => (typeof v === 'string' ? [v] : leaves(v)));
}

const placeholderSet = (s: string) => (s.match(/\{\{[^}]*\}\}|%\{[^}]*\}/g) ?? []).sort().join(',');

describe('pseudoLocalize', () => {
  it('accents, pads and brackets a label', () => {
    expect(pseudoLocalize('Wallets')).toBe('[Ŵåļļéţš···]');
  });

  it('is deterministic', () => {
    const s = 'Send {{amount}} sats to {{name}}';
    expect(pseudoLocalize(s)).toBe(pseudoLocalize(s));
  });

  it('keeps placeholders, URLs, emails and line breaks intact', () => {
    const out = pseudoLocalize(
      'Hi {{name}}, %{count} new.\nSee https://example.com/help or mail me@lightningpiggy.app',
    );
    expect(out).toContain('{{name}}');
    expect(out).toContain('%{count}');
    expect(out).toContain('https://example.com/help');
    expect(out).toContain('me@lightningpiggy.app');
    expect(out).toContain('\n');
    expect(out.startsWith('[Ĥî ')).toBe(true);
    expect(out.endsWith('·]')).toBe(true);
  });

  it('grows text by about 40% (plus the brackets)', () => {
    const s = 'Share your location with the other people in this group?';
    const out = pseudoLocalize(s);
    const growth = (out.length - 2) / s.length;
    expect(growth).toBeGreaterThanOrEqual(1.4);
    expect(growth).toBeLessThan(1.45);
  });

  it('leaves an empty string empty', () => {
    expect(pseudoLocalize('')).toBe('');
  });
});

describe('pseudoCatalogue', () => {
  const pseudo = pseudoCatalogue(enJson as Tree);

  it('keeps every key and every placeholder of en.json', () => {
    const enLeaves = leaves(enJson as Tree);
    const pseudoLeaves = leaves(pseudo);
    expect(pseudoLeaves).toHaveLength(enLeaves.length);
    enLeaves.forEach((source, i) => {
      expect(placeholderSet(pseudoLeaves[i])).toBe(placeholderSet(source));
    });
  });

  it('brackets every non-empty string', () => {
    for (const value of leaves(pseudo)) {
      if (value) expect(value).toMatch(/^\[[\s\S]*\]$/);
    }
  });
});

describe('en-XA vs the catalogue guard', () => {
  it('is not a registered catalogue, so the guard never treats it as a partial locale', () => {
    expect(SUPPORTED_LOCALES).not.toContain(PSEUDO_LOCALE);
    expect(Object.keys(translations)).not.toContain(PSEUDO_LOCALE);
  });

  it('would pass the same validation as a real locale (en plural rules)', () => {
    const pseudo = pseudoCatalogue(enJson as Tree) as Catalogue;
    expect(validateCatalogue(enJson as Catalogue, pseudo, requiredPluralCategories('en'))).toEqual(
      [],
    );
  });
});

describe('createPseudoI18nInstance', () => {
  it('renders en-XA with interpolation and plurals working', () => {
    const i18n = createPseudoI18nInstance();
    expect(i18n.locale).toBe(PSEUDO_LOCALE);
    expect(i18n.t('tabs.wallets')).toBe('[Ŵåļļéţš···]');
    expect(i18n.t('market.reviews.count', { count: 3 })).toBe('[3 ŕéṽîéŵš····]');
    expect(i18n.t('market.reviews.count', { count: 1 })).toBe('[1 ŕéṽîéŵ···]');
    expect(i18n.t('market.reviews.count', { count: 21 })).toBe('[21 ŕéṽîéŵš····]');
  });
});

describe('isPseudoLocaleAvailable', () => {
  const app = Application as { applicationId: string | null };
  const originalId = app.applicationId;
  const originalFlag = process.env.EXPO_PUBLIC_KEEP_PERF_LOGS;
  const g = globalThis as { __DEV__?: boolean };
  const originalDev = g.__DEV__;

  afterEach(() => {
    app.applicationId = originalId;
    process.env.EXPO_PUBLIC_KEEP_PERF_LOGS = originalFlag;
    g.__DEV__ = originalDev;
  });

  it('is offered in dev builds', () => {
    g.__DEV__ = true;
    expect(isPseudoLocaleAvailable()).toBe(true);
  });

  it('is offered in preview builds (EXPO_PUBLIC_KEEP_PERF_LOGS=1)', () => {
    g.__DEV__ = false;
    app.applicationId = 'com.lightningpiggy.app.preview';
    process.env.EXPO_PUBLIC_KEEP_PERF_LOGS = '1';
    expect(isPseudoLocaleAvailable()).toBe(true);
  });

  it('is never offered in the production binary', () => {
    g.__DEV__ = false;
    process.env.EXPO_PUBLIC_KEEP_PERF_LOGS = '';
    app.applicationId = 'com.lightningpiggy.app';
    expect(isPseudoLocaleAvailable()).toBe(false);
    // Even if a production build were made with the perf flag.
    process.env.EXPO_PUBLIC_KEEP_PERF_LOGS = '1';
    expect(isPseudoLocaleAvailable()).toBe(false);
  });
});
