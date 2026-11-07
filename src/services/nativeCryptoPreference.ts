/**
 * Persisted on/off preference for the rust-nostr native crypto path (#1057,
 * epic #1036). Split out from the `nostrCrypto` facade so the Settings screen
 * can read/write the flag without dragging in the facade's crypto graph, and
 * so `index.ts` can read it at startup with a single async call.
 *
 * Default ON (#1727): when the native module is linked and warms up, local
 * crypto runs natively; the Settings toggle is an opt-out. Only an explicit
 * `'false'` (a user turning it off) keeps routing on JS. An unavailable or
 * broken module still falls back to JS for the session (warmUpNativeCrypto).
 * The facade reads this pref ONCE at startup (index.ts) and calls
 * `setNativeCryptoEnabled(pref)` before warming up — there is deliberately no
 * mid-session re-routing, so this value is never consulted on the crypto hot
 * path. Mirrors backgroundDmPreference.ts.
 */
import AsyncStorage from '@react-native-async-storage/async-storage';

const NATIVE_CRYPTO_ENABLED_KEY = 'native_crypto_enabled_v1';

let cached: boolean | null = null;

/** Read the persisted preference. Defaults to true (on) when unset or unreadable. */
export async function loadNativeCryptoEnabled(): Promise<boolean> {
  if (cached !== null) return cached;
  const raw = await AsyncStorage.getItem(NATIVE_CRYPTO_ENABLED_KEY).catch(() => null);
  // A save that landed while this read was in flight is newer: keep it.
  if (cached === null) cached = raw !== 'false';
  return cached;
}

/** Persist the preference (takes effect on the next launch). */
export async function saveNativeCryptoEnabled(enabled: boolean): Promise<void> {
  cached = enabled;
  await AsyncStorage.setItem(NATIVE_CRYPTO_ENABLED_KEY, enabled ? 'true' : 'false').catch(() => {});
}

/** Test hook: drop the in-memory cache so tests don't poison each other. */
export function __resetForTests(): void {
  cached = null;
}
