import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import { isTestRelayLockdown, TEST_RELAY_URL } from '../config/testRelayLockdown';
import { getCurrentUserPubkey } from './nostrActiveAccount';
import { perAccountKey } from './perAccountStorage';

export type AppRelayGroup = 'default' | 'indexers' | 'geocache' | 'marmot' | 'market';
export const APP_RELAY_PREFS_KEY = 'app_relay_prefs_v1';
type Preferences = Partial<Record<AppRelayGroup, string[]>>;
const EMPTY_RELAYS: string[] = [];
const accounts = new Map<string, Preferences>();
const loading = new Map<string, Promise<void>>();
const retryAfter = new Map<string, number>();
const RETRY_COOLDOWN_MS = 1000;
const listeners = new Set<() => void>();
let revision = 0;
const normalise = (url: string) => url.trim().replace(/\/+$/, '').toLowerCase();
const notify = () => {
  revision++;
  listeners.forEach((fn) => fn());
};
export const appRelayPrefsRevision = () => revision;
export const subscribeAppRelayPrefs = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};

/** Hydrate before exposing an account to network consumers. */
export function loadAppRelayPrefs(pubkey: string): Promise<void> {
  pubkey = pubkey.toLowerCase();
  if (accounts.has(pubkey)) return Promise.resolve();
  const pending = loading.get(pubkey);
  if (pending) return pending;
  const task = AsyncStorage.getItem(perAccountKey(APP_RELAY_PREFS_KEY, pubkey))
    .then((raw) => {
      const prefs: Preferences = {};
      if (raw) {
        try {
          const parsed = JSON.parse(raw);
          for (const group of ['default', 'indexers', 'geocache', 'marmot', 'market'] as const) {
            if (Array.isArray(parsed?.[group]))
              prefs[group] = parsed[group]
                .filter((u: unknown) => typeof u === 'string')
                .map(normalise);
          }
        } catch {
          /* Invalid preferences start with all relays enabled. */
        }
      }
      retryAfter.delete(pubkey);
      accounts.set(pubkey, prefs);
      notify();
    })
    .catch((error) => {
      retryAfter.set(pubkey, Date.now() + RETRY_COOLDOWN_MS);
      throw error;
    })
    .finally(() => loading.delete(pubkey));
  loading.set(pubkey, task);
  return task;
}

export function isAppRelayEnabled(
  pubkey: string | null,
  group: AppRelayGroup,
  url: string,
): boolean {
  return !(pubkey && accounts.get(pubkey.toLowerCase())?.[group]?.includes(normalise(url)));
}

/** Only filters app-provided relays; an explicitly chosen personal relay stays personal. */
export function enabledAppRelays<T extends readonly string[]>(
  group: AppRelayGroup,
  list: T,
  pubkey = getCurrentUserPubkey(),
): T | string[] {
  if (isTestRelayLockdown(pubkey)) return [TEST_RELAY_URL];
  if (!pubkey) return list;
  const prefs = accounts.get(pubkey.toLowerCase());
  // Never briefly connect to a disabled default while storage is loading.
  if (!prefs) {
    const retryAt = retryAfter.get(pubkey.toLowerCase());
    // Ordinary reads retry failed hydration, sharing one load and backing off
    // storage failures. Keep defaults closed until a successful load notifies consumers.
    if (retryAt !== undefined && Date.now() >= retryAt) {
      void loadAppRelayPrefs(pubkey).catch(() => {});
    }
    return EMPTY_RELAYS;
  }
  if (!prefs[group]?.length) return list;
  const disabled = new Set(prefs[group]);
  return list.filter((url) => !disabled.has(normalise(url)));
}

// Serialize writes so a rapid off/on cannot persist in reverse order.
let writes: Promise<void> = Promise.resolve();
export function setAppRelayEnabled(
  pubkey: string,
  group: AppRelayGroup,
  url: string,
  enabled: boolean,
): Promise<void> {
  pubkey = pubkey.toLowerCase();
  const task = writes
    .catch(() => {})
    .then(async () => {
      await loadAppRelayPrefs(pubkey);
      const previous = accounts.get(pubkey)!;
      const disabled = new Set(previous[group] ?? []);
      if (enabled) disabled.delete(normalise(url));
      else disabled.add(normalise(url));
      const next = { ...previous, [group]: [...disabled] };
      await AsyncStorage.setItem(perAccountKey(APP_RELAY_PREFS_KEY, pubkey), JSON.stringify(next));
      accounts.set(pubkey, next);
      notify();
      if (
        group === 'default' &&
        Platform.OS === 'android' &&
        getCurrentUserPubkey()?.toLowerCase() === pubkey
      ) {
        // Load lazily: the background watch itself reads this preference store.
        // Sync after persistence to refresh live relays or restart a stopped host
        // when the watch preference is enabled.
        try {
          const { syncBackgroundDmWatchFromPreference } =
            // eslint-disable-next-line @typescript-eslint/no-require-imports -- Avoid the watch/store import cycle.
            require('./backgroundDmService') as typeof import('./backgroundDmService');
          await syncBackgroundDmWatchFromPreference();
        } catch (error) {
          console.warn('[AppRelayPrefs] background DM sync failed:', error);
        }
      }
    });
  writes = task;
  return task;
}

export async function forgetAppRelayPrefs(pubkey: string): Promise<void> {
  pubkey = pubkey.toLowerCase();
  await loading.get(pubkey)?.catch(() => {});
  await writes.catch(() => {});
  accounts.delete(pubkey);
  retryAfter.delete(pubkey);
  notify();
}
