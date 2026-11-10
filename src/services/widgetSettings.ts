// Per-widget settings for the home-screen widget (#1849), keyed by the
// launcher's widget id: which wallet the widget is showing, its style, and
// whether it hides the balance. Holds no balances or secrets — a wallet id is
// an app-internal random id. Each widget remembers its own wallet, so two
// widgets can show two different Piggies.
import AsyncStorage from '@react-native-async-storage/async-storage';

export const WIDGET_SETTINGS_KEY = 'widget_settings_v1';

export const WIDGET_STYLE_IDS = ['piggyPink', 'cleanWhite', 'nightGlass'] as const;
export type WidgetStyleId = (typeof WIDGET_STYLE_IDS)[number];
export const DEFAULT_WIDGET_STYLE: WidgetStyleId = 'piggyPink';

export interface WidgetSettings {
  /** The wallet currently shown; null = the first wallet in carousel order. */
  walletId: string | null;
  /** That wallet's carousel slot, so if it's removed the widget moves on to
   *  the wallet that takes its place (the next one) rather than the first. */
  walletIndex: number;
  style: WidgetStyleId;
  /** Off by default: the balance is shown unless the user opts out. */
  hideBalance: boolean;
}

export const DEFAULT_WIDGET_SETTINGS: WidgetSettings = {
  walletId: null,
  walletIndex: 0,
  style: DEFAULT_WIDGET_STYLE,
  hideBalance: false,
};

type SettingsMap = Record<string, WidgetSettings>;

export function isWidgetStyleId(value: unknown): value is WidgetStyleId {
  return (WIDGET_STYLE_IDS as readonly unknown[]).includes(value);
}

/** Coerce a stored entry to valid settings, defaulting anything missing. */
export function normaliseWidgetSettings(value: unknown): WidgetSettings {
  if (!value || typeof value !== 'object') return { ...DEFAULT_WIDGET_SETTINGS };
  const v = value as Record<string, unknown>;
  return {
    walletId: typeof v.walletId === 'string' && v.walletId ? v.walletId : null,
    walletIndex:
      typeof v.walletIndex === 'number' && Number.isInteger(v.walletIndex) && v.walletIndex >= 0
        ? v.walletIndex
        : 0,
    style: isWidgetStyleId(v.style) ? v.style : DEFAULT_WIDGET_STYLE,
    hideBalance: v.hideBalance === true,
  };
}

async function readMap(): Promise<SettingsMap> {
  try {
    const json = await AsyncStorage.getItem(WIDGET_SETTINGS_KEY);
    const parsed = json ? (JSON.parse(json) as unknown) : null;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as SettingsMap)
      : {};
  } catch {
    return {};
  }
}

// Read-modify-write runs serially: two widgets clicked in quick succession
// (or a click racing the configuration screen) must not drop each other's
// change.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(op: () => Promise<T>): Promise<T> {
  const next = queue.then(op, op);
  queue = next.catch(() => undefined);
  return next;
}

export async function readWidgetSettings(widgetId: number): Promise<WidgetSettings> {
  const map = await readMap();
  return normaliseWidgetSettings(map[String(widgetId)]);
}

export function saveWidgetSettings(widgetId: number, settings: WidgetSettings): Promise<void> {
  return enqueue(async () => {
    const map = await readMap();
    map[String(widgetId)] = normaliseWidgetSettings(settings);
    await AsyncStorage.setItem(WIDGET_SETTINGS_KEY, JSON.stringify(map));
  });
}

/** Atomic read-modify-write of one widget's settings; resolves to the result.
 *  Two quick ‹ › taps each step once instead of both reading the same value. */
export function updateWidgetSettings(
  widgetId: number,
  update: (current: WidgetSettings) => WidgetSettings,
): Promise<WidgetSettings> {
  return enqueue(async () => {
    const map = await readMap();
    const current = normaliseWidgetSettings(map[String(widgetId)]);
    const next = normaliseWidgetSettings(update(current));
    const unchanged = String(widgetId) in map && JSON.stringify(next) === JSON.stringify(current);
    if (!unchanged) {
      map[String(widgetId)] = next;
      await AsyncStorage.setItem(WIDGET_SETTINGS_KEY, JSON.stringify(map));
    }
    return next;
  });
}

/** The launcher removed the widget: forget its settings. */
export function deleteWidgetSettings(widgetId: number): Promise<void> {
  return enqueue(async () => {
    const map = await readMap();
    if (!(String(widgetId) in map)) return;
    delete map[String(widgetId)];
    await AsyncStorage.setItem(WIDGET_SETTINGS_KEY, JSON.stringify(map));
  });
}
