// Only en (the fallback) plus the active locale's catalogue may be loaded:
// the other ~2 MB of JSON stays unevaluated until someone picks that language.
type I18nModule = typeof import('./index');

const NON_EN = ['de', 'es', 'hu', 'pl', 'uk', 'hi', 'mr', 'zh-Hans'] as const;

/** A fresh copy of the i18n module, with every non-en catalogue's JSON module
 *  wrapped so evaluating it is recorded. */
function freshI18n(): { mod: I18nModule; evaluated: string[] } {
  const evaluated: string[] = [];
  let mod!: I18nModule;
  jest.resetModules();
  jest.isolateModules(() => {
    for (const locale of NON_EN) {
      jest.doMock(`./locales/${locale}.json`, () => {
        evaluated.push(locale);
        return jest.requireActual(`./locales/${locale}.json`);
      });
    }
    mod = require('./index');
  });
  return { mod, evaluated };
}

afterEach(() => {
  for (const locale of NON_EN) jest.dontMock(`./locales/${locale}.json`);
});

describe('lazy locale catalogues', () => {
  it('loads only en at module load', () => {
    const { mod, evaluated } = freshI18n();
    expect(evaluated).toEqual([]);
    expect(mod.loadedLocales()).toEqual(['en']);
    expect(Object.keys(mod.default.translations)).toEqual(['en']);
  });

  it('an instance for the active locale loads just that catalogue, holding en + it', () => {
    const { mod, evaluated } = freshI18n();
    const instance = mod.createI18nInstance('uk');
    expect(evaluated).toEqual(['uk']);
    expect(mod.loadedLocales()).toEqual(['en', 'uk']);
    expect(Object.keys(instance.translations).sort()).toEqual(['en', 'uk']);
    expect(instance.t('tabs.wallets')).toBe(mod.loadCatalogue('uk').tabs.wallets);
    expect(instance.t('tabs.wallets')).not.toBe(mod.loadCatalogue('en').tabs.wallets);
  });

  it('an en instance loads nothing else', () => {
    const { mod, evaluated } = freshI18n();
    expect(Object.keys(mod.createI18nInstance('en').translations)).toEqual(['en']);
    expect(evaluated).toEqual([]);
  });

  it('switching language on the shared instance loads that catalogue on demand, once', () => {
    const { mod, evaluated } = freshI18n();
    mod.default.locale = 'es';
    expect(mod.t('tabs.wallets')).toBe(mod.loadCatalogue('es').tabs.wallets);
    mod.default.locale = 'de';
    expect(mod.t('tabs.wallets')).toBe(mod.loadCatalogue('de').tabs.wallets);
    mod.createI18nInstance('de');
    mod.default.locale = 'es';
    expect(evaluated).toEqual(['es', 'de']);
    expect(mod.loadedLocales()).toEqual(['en', 'es', 'de']);
    mod.default.locale = 'en';
    expect(mod.t('tabs.wallets')).toBe(mod.loadCatalogue('en').tabs.wallets);
  });

  it('the en-XA pseudo-locale (generated from en) loads no catalogue', () => {
    const { mod, evaluated } = freshI18n();
    const instance = mod.createI18nInstance('en');
    instance.locale = 'en-XA';
    expect(evaluated).toEqual([]);
    expect(Object.keys(instance.translations)).toEqual(['en']);
  });

  it('falls back to en for a key the active catalogue lacks', () => {
    const { mod } = freshI18n();
    const instance = mod.createI18nInstance('pl');
    instance.translations.pl = { tabs: {} };
    expect(instance.t('tabs.wallets')).toBe(mod.loadCatalogue('en').tabs.wallets);
  });

  it('pins countless singulars for the active locale only (uk 21 is not "one")', () => {
    const { mod } = freshI18n();
    const instance = mod.createI18nInstance('uk');
    const uk = instance.translations.uk as Record<string, unknown>;
    // Some uk plural entry had a count-less `one` moved to `=1` (plurals.ts).
    expect(JSON.stringify(uk)).toContain('"=1"');
    expect(JSON.stringify(mod.loadCatalogue('uk'))).not.toContain('"=1"');
  });

  it('loadAllCatalogues (tests / tooling only) loads every locale', () => {
    const { mod, evaluated } = freshI18n();
    expect(Object.keys(mod.loadAllCatalogues())).toEqual([...mod.SUPPORTED_LOCALES]);
    expect([...evaluated].sort()).toEqual([...NON_EN].sort());
  });
});
