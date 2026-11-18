// Translations for the widget and its configuration screen (#1849). Both run
// outside the app's LocaleProvider (a headless task / a separate activity), so
// they use the language the app last wrote into the snapshot — the user's
// chosen language — falling back to the phone's language, then English.
import type { TranslateOptions } from 'i18n-js';
import { getLocales } from 'expo-localization';
import {
  createI18nInstance,
  intlLocaleFor,
  isSupportedLocale,
  supportedLocaleForDevice,
  type SupportedLocale,
} from '../i18n';

export type WidgetTranslate = (scope: string, options?: TranslateOptions) => string;

export interface WidgetTranslator {
  locale: SupportedLocale;
  /** BCP-47 tag for number / currency formatting. */
  intlLocale: string;
  t: WidgetTranslate;
}

function deviceLanguageTag(): string | null {
  try {
    const first = getLocales()[0];
    return first?.languageTag ?? first?.languageCode ?? null;
  } catch {
    return null;
  }
}

export function resolveWidgetLocale(
  snapshotLocale: string | null | undefined,
  deviceTag: string | null = deviceLanguageTag(),
): SupportedLocale {
  if (snapshotLocale && isSupportedLocale(snapshotLocale)) return snapshotLocale;
  return supportedLocaleForDevice(deviceTag) ?? 'en';
}

const translators = new Map<SupportedLocale, WidgetTranslator>();

export function widgetTranslator(locale: SupportedLocale): WidgetTranslator {
  let translator = translators.get(locale);
  if (!translator) {
    const i18n = createI18nInstance(locale);
    translator = { locale, intlLocale: intlLocaleFor(locale), t: (scope, o) => i18n.t(scope, o) };
    translators.set(locale, translator);
  }
  return translator;
}
