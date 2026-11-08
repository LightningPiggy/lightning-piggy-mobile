import { I18n } from 'i18n-js';
import type { Scope, TranslateOptions } from 'i18n-js';
import type { Translations } from './locales/types';
import { pinCountlessSingulars, registerPluralRules } from './plurals';
import { perfLog } from '../utils/perfLog';

// #137 infra; languages added in batches since (#1312). Adding one: drop
// `locales/<code>.json` next to en.json, add it to SUPPORTED_LOCALES and
// CATALOGUE_LOADERS below, add a CLDR rule in plurals.ts and a native-name
// label in DisplayLanguageScreen. catalogues.test.ts then guards key parity,
// placeholders and plural forms.
//
// Locale catalogues are plain JSON (not .ts) so a translation-only
// contribution — the issue explicitly calls this out as a good first
// contribution — never requires touching TypeScript. The `Translations`
// check on CATALOGUE_LOADERS is what keeps them honest: a catalogue that is
// missing (or misspells) a key fails `tsc`, same guarantee a hand-written .ts
// file would give.
//
// Only English (the fallback every lookup ends in) is loaded eagerly. Each
// other catalogue is 200-350 KB of JSON: building all of them at module load,
// and deep-merging all of them into every I18n instance, was cold-start work
// for languages nobody on the phone uses. A catalogue now loads the first time
// an instance for its locale is built (`createI18nInstance` /
// `setSharedLocale`). The requires stay static string literals because Metro
// only bundles what it can see; they are just evaluated lazily.
const loadStartedAt = Date.now();
const en: Translations = require('./locales/en.json') as typeof import('./locales/en.json');

export const SUPPORTED_LOCALES = [
  'en',
  'de',
  'es',
  'hu',
  'pl',
  'uk',
  'hi',
  'mr',
  'zh-Hans',
] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

/** One static require per catalogue; `satisfies` keeps this map and
 *  SUPPORTED_LOCALES in step and type-checks every catalogue's keys. */
const CATALOGUE_LOADERS = {
  en: () => en,
  de: () => require('./locales/de.json') as typeof import('./locales/de.json'),
  es: () => require('./locales/es.json') as typeof import('./locales/es.json'),
  hu: () => require('./locales/hu.json') as typeof import('./locales/hu.json'),
  pl: () => require('./locales/pl.json') as typeof import('./locales/pl.json'),
  uk: () => require('./locales/uk.json') as typeof import('./locales/uk.json'),
  hi: () => require('./locales/hi.json') as typeof import('./locales/hi.json'),
  mr: () => require('./locales/mr.json') as typeof import('./locales/mr.json'),
  'zh-Hans': () => require('./locales/zh-Hans.json') as typeof import('./locales/zh-Hans.json'),
} satisfies Record<SupportedLocale, () => Translations>;

const loaded = new Map<SupportedLocale, Translations>([['en', en]]);
const pinned = new Map<SupportedLocale, Translations>();

/** A locale's raw catalogue, loaded (and cached) on first use. */
export function loadCatalogue(locale: SupportedLocale): Translations {
  let catalogue = loaded.get(locale);
  if (!catalogue) {
    const t0 = Date.now();
    catalogue = CATALOGUE_LOADERS[locale]();
    loaded.set(locale, catalogue);
    perfLog(`i18n catalogue ${locale} loaded in ${Date.now() - t0}ms`);
  }
  return catalogue;
}

/** Locales whose catalogue has been loaded this session, in load order. */
export function loadedLocales(): SupportedLocale[] {
  return [...loaded.keys()];
}

/**
 * Every catalogue, keyed by locale. Loads them ALL, so it is for tests and
 * catalogue tooling only, never an app code path.
 */
export function loadAllCatalogues(): Record<SupportedLocale, Translations> {
  return Object.fromEntries(
    SUPPORTED_LOCALES.map((locale) => [locale, loadCatalogue(locale)]),
  ) as Record<SupportedLocale, Translations>;
}

/** What I18n instances actually load: the catalogue with singular-only `one`
 *  forms pinned to `=1` where CLDR `one` covers other numbers (plurals.ts).
 *  Pinned once per locale, then shared by every instance. */
function runtimeCatalogue(locale: SupportedLocale): Translations {
  let catalogue = pinned.get(locale);
  if (!catalogue) {
    catalogue = pinCountlessSingulars(locale, loadCatalogue(locale));
    pinned.set(locale, catalogue);
  }
  return catalogue;
}

export function isSupportedLocale(code: string): code is SupportedLocale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(code);
}

/**
 * Map a device locale (a BCP-47 tag such as `es-MX`, `zh-Hans-CN`, `zh_TW`, or
 * a bare language code such as `uk`) to the catalogue that serves it, or
 * `null` when there is none. Chinese is the one language whose catalogue key
 * carries a script: every `zh*` tag maps to `zh-Hans` (Simplified), including
 * Traditional (`zh-Hant`, `zh-TW`, `zh-HK`) until a Traditional catalogue
 * exists, since Simplified is far more readable to them than English.
 */
export function supportedLocaleForDevice(tag: string | null | undefined): SupportedLocale | null {
  if (!tag) return null;
  const language = tag.split(/[-_]/)[0].toLowerCase();
  const candidate = language === 'zh' ? 'zh-Hans' : language;
  return isSupportedLocale(candidate) ? candidate : null;
}

/**
 * BCP-47 tag to hand to `Intl` / `toLocale*String` when formatting numbers and
 * dates for a catalogue locale. Identical to the catalogue code except where
 * the CLDR default numbering system isn't what our users see in payment apps:
 * Marathi defaults to Devanagari digits (१,२३४), but Indian wallets show
 * Western digits, so pin `latn` (Hindi already defaults to it; pinned too so
 * both stay in step). Indian digit grouping (1,23,456) is kept, as expected.
 */
const INTL_TAG_OVERRIDES: Partial<Record<string, string>> = {
  hi: 'hi-u-nu-latn',
  mr: 'mr-u-nu-latn',
};

export function intlLocaleFor(locale: SupportedLocale): string {
  return INTL_TAG_OVERRIDES[locale] ?? locale;
}

/** Shared config every I18n instance in the app uses — kept in one place
 *  so the module-level singleton below and LocaleContext's per-locale
 *  render instances can't drift apart. Starts with just `en` (the
 *  fallback); a catalogue is loaded into the instance the first time its
 *  `.locale` is set to that language (i18n-js runs `onChange` synchronously
 *  inside the setter, so it's there before the next `t()`). */
export function createI18nInstance(locale: SupportedLocale): I18n {
  const instance = new I18n({ en: runtimeCatalogue('en') });
  instance.onChange(() => {
    const active = instance.locale;
    if (isSupportedLocale(active) && !instance.translations[active]) {
      instance.store({ [active]: runtimeCatalogue(active) });
    }
  });
  instance.defaultLocale = 'en';
  instance.enableFallback = true;
  instance.locale = locale;
  // CLDR plural rules per locale (i18n-js defaults to English rules for all).
  registerPluralRules(instance);
  return instance;
}

// Module-level singleton for non-React call sites only (service/util code
// that can't use `useTranslation()`). `LocaleContext` keeps its `.locale`
// in sync via a `useEffect` — after commit, never during render — so nothing
// in the render phase ever depends on this object's mutable state. See the
// comment on `t()` below and the render-purity note in LocaleContext.tsx.
const i18n = createI18nInstance('en');
perfLog(`i18n module load ${Date.now() - loadStartedAt}ms (en)`);

export default i18n;

/**
 * Plain (non-hook) translate — for service/util call sites that aren't
 * React components and can't use `useTranslation()`. Always reads
 * whichever locale `LocaleContext` last set on the shared `i18n`
 * instance (synced post-commit, so it can lag the UI by a tick — fine
 * for imperative/async call sites, which is all this is for). Not wired
 * to anything yet (GIPHY's `lang` param is a follow-up per #137), but
 * the surface is ready when that lands.
 */
export function t(scope: Scope, options?: TranslateOptions): string {
  return i18n.t(scope, options);
}
