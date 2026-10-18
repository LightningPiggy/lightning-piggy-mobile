import { enabledAppRelays, loadAppRelayPrefs } from './appRelayPrefs';
import { DEFAULT_RELAYS } from './nostrService';
import { lockRelays } from '../config/testRelayLockdown';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { RelayConfig } from '../types/nostr';
import { perAccountKey } from './perAccountStorage';
import { getUserRelays, mergeRelays } from './nostrRelayStorage';
import {
  RELAY_LIST_CACHE_KEY_BASE,
  DM_INBOX_RELAYS_CACHE_KEY_BASE,
} from '../contexts/nostrCacheKeys';

/**
 * Resolve the viewer's read relays the same way the app's foreground context
 * does: defaults + cached NIP-65 list + user overrides, merged with the same
 * precedence (`mergeRelays`), plus the user's own DM inbox relays (kind 10050,
 * where others deliver NIP-17 DMs). `getUserRelays()` alone is ONLY the user's
 * explicit in-app overrides — `[]` for anyone who never customised relays —
 * which is why the watch must never use it bare: it silently armed nothing
 * for default-relay users (the original #279 swipe-away bug). `mergeRelays`
 * always folds in DEFAULT_RELAYS, so this can't return an empty read set.
 */
export async function resolveReadRelays(pubkey: string): Promise<string[]> {
  await loadAppRelayPrefs(pubkey);
  let nip65: RelayConfig[] = [];
  try {
    const raw = await AsyncStorage.getItem(perAccountKey(RELAY_LIST_CACHE_KEY_BASE, pubkey));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      nip65 = parsed.filter(
        (r): r is RelayConfig =>
          r &&
          typeof r === 'object' &&
          typeof r.url === 'string' &&
          typeof r.read === 'boolean' &&
          typeof r.write === 'boolean',
      );
    }
  } catch {
    // Unreadable cache just means defaults + user overrides.
  }
  const user = await getUserRelays().catch(() => []);
  const read = mergeRelays({
    nip65,
    user,
    defaults: enabledAppRelays('default', DEFAULT_RELAYS, pubkey),
  })
    .filter((r) => r.read)
    .map((r) => r.url);
  // Others deliver NIP-17 DMs to the user's own DM inbox relays — watch them too.
  let inbox: string[] = [];
  try {
    const raw = await AsyncStorage.getItem(perAccountKey(DM_INBOX_RELAYS_CACHE_KEY_BASE, pubkey));
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) inbox = parsed.filter((u): u is string => typeof u === 'string');
  } catch {
    // Unreadable cache — the merged read relays above still apply.
  }
  return lockRelays([...new Set([...read, ...inbox])], pubkey);
}
