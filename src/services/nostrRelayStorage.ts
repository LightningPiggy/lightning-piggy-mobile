import { enabledAppRelays } from './appRelayPrefs';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { RelayConfig } from '../types/nostr';
import { DEFAULT_RELAYS } from './nostrService';

/**
 * User-managed relay overrides. Lives separately from the published
 * NIP-65 (kind-10002) list so users can add/remove relays in-app
 * without us auto-broadcasting metadata events on their behalf
 * (out of scope for #202 — see issue thread). The merge in
 * `mergeRelays` unions these with whatever NIP-65 returned, so the
 * existing read/write filter pipeline picks them up automatically.
 *
 * Stored in AsyncStorage (NOT SecureStore) — relay URLs aren't
 * sensitive; they're public infrastructure and the same data is
 * already broadcast in users' kind-10002 events.
 */
const USER_RELAYS_KEY = 'user_relays_v1';

/**
 * Read the user's persisted relay overrides. Returns `[]` (not
 * defaults) when none have been saved — defaults are merged in by
 * `mergeRelays`, this only reflects the user's explicit overrides.
 */
export async function getUserRelays(): Promise<RelayConfig[]> {
  const json = await AsyncStorage.getItem(USER_RELAYS_KEY);
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    // Defensive filter — old/garbled entries shouldn't crash the merge.
    return parsed.filter(
      (r): r is RelayConfig =>
        r &&
        typeof r === 'object' &&
        typeof r.url === 'string' &&
        typeof r.read === 'boolean' &&
        typeof r.write === 'boolean',
    );
  } catch {
    return [];
  }
}

export async function setUserRelays(relays: RelayConfig[]): Promise<void> {
  await AsyncStorage.setItem(USER_RELAYS_KEY, JSON.stringify(relays));
}

/**
 * Validate a relay URL. Accepts `wss://` for production and `ws://`
 * for local dev (`localhost`, `127.0.0.1`, `10.0.2.2` for Android
 * emulator, and any `*.local` mDNS host so devs can reach a relay
 * running on another machine on the LAN). Anything else is rejected
 * so we can't accidentally try to open an `https://` URL as a
 * websocket.
 *
 * Returns the normalised URL (trimmed, trailing slash removed) on
 * success, or an error message on failure.
 */
export function validateRelayUrl(
  input: string,
): { ok: true; url: string } | { ok: false; error: string } {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: 'Relay URL is required.' };

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, error: 'Not a valid URL.' };
  }

  if (parsed.protocol === 'wss:') {
    // ok
  } else if (parsed.protocol === 'ws:') {
    const host = parsed.hostname;
    const isLocal =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '10.0.2.2' ||
      host.endsWith('.local');
    if (!isLocal) {
      return {
        ok: false,
        error:
          'Plain ws:// is only allowed for local dev (localhost / 127.0.0.1 / 10.0.2.2 / *.local).',
      };
    }
  } else {
    return { ok: false, error: 'Relay URL must start with wss:// (or ws:// for local dev).' };
  }

  // Strip trailing slash for canonical comparison — `wss://r.example/`
  // and `wss://r.example` should dedupe in the merge.
  const normalised = trimmed.replace(/\/+$/, '');
  return { ok: true, url: normalised };
}

/**
 * Merge the NIP-65 list, the app defaults, and the user's overrides
 * into one ordered, deduped list. Used by `NostrContext.relays` so
 * existing read/write filter sites pick up user-added relays without
 * any further plumbing.
 *
 * Precedence (for read/write flags on duplicates):
 *   user > nip65 > default
 * — the user's most recent explicit choice wins. Defaults always
 * appear (read+write) so the app stays bootable even when a user
 * removes everything.
 */
export function mergeRelays(input: {
  nip65: RelayConfig[];
  user: RelayConfig[];
  defaults?: string[];
}): RelayConfig[] {
  const defaults = input.defaults ?? enabledAppRelays('default', DEFAULT_RELAYS);
  const byUrl = new Map<string, RelayConfig>();
  // Canonicalise per-source URLs before dedup. `validateRelayUrl`
  // strips trailing slashes for user-added rows, but NIP-65 / default
  // sources don't pass through it — without this normaliser an event
  // listing `wss://relay.example/` would dedupe separately from a
  // default of `wss://relay.example`.
  const norm = (u: string) => u.trim().replace(/\/+$/, '');

  // Lowest priority first so subsequent writes overwrite.
  for (const url of defaults) {
    const u = norm(url);
    byUrl.set(u, { url: u, read: true, write: true });
  }
  for (const r of input.nip65) {
    const u = norm(r.url);
    byUrl.set(u, { url: u, read: r.read, write: r.write });
  }
  for (const r of input.user) {
    const u = norm(r.url);
    byUrl.set(u, { url: u, read: r.read, write: r.write });
  }

  return [...byUrl.values()];
}
