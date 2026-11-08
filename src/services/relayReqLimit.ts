import { isTestRelayLockdown } from '../config/testRelayLockdown';
import { getCurrentUserPubkey, onCurrentUserPubkeyChange } from './nostrActiveAccount';
import { isPublicRelayUrl } from '../utils/publicUrl';

// NIP-11 is advisory. Never delay arming the inbox for HTTP discovery. Bound
// concurrency, timeout and cache size; unavailable documents use the default.
const cache = new Map<string, Promise<number | undefined>>();
let active = 0;
const inFlight = new Set<AbortController>();
// A session that enters lockdown must not complete a public request already queued.
onCurrentUserPubkeyChange((pubkey) => {
  if (isTestRelayLockdown(pubkey)) for (const c of inFlight) c.abort();
});
export function discoverRelayReqLimit(url: string): Promise<number | undefined> {
  // Test accounts never contact public hosts, even for advisory NIP-11 discovery.
  if (isTestRelayLockdown(getCurrentUserPubkey())) return Promise.resolve(undefined);
  const hit = cache.get(url);
  if (hit) return hit;
  if (!isPublicRelayUrl(url) || active >= 2 || cache.size >= 100) return Promise.resolve(undefined);
  active++;
  const controller = new AbortController();
  inFlight.add(controller);
  const timer = setTimeout(() => controller.abort(), 3000);
  const result = Promise.resolve()
    .then(() => {
      if (isTestRelayLockdown(getCurrentUserPubkey())) throw new Error('test relay lockdown');
      // Load the native HTTP module only for advisory discovery, after arming REQs.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { fetch } = require('expo/fetch') as typeof import('expo/fetch');
      return fetch(url.replace(/^wss:/, 'https:'), {
        // Expo fetch enforces this on native platforms; RN global fetch ignores redirects.
        // The public-URL check only covers this URL, not a relay's redirect target.
        redirect: 'error',
        headers: { Accept: 'application/nostr+json' },
        signal: controller.signal,
      });
    })
    .then(async (response) => {
      if (!response.ok) return undefined;
      const info = await response.json();
      const max = info?.limitation?.max_subscriptions;
      return Number.isInteger(max) && max > 0 ? Math.min(max, 10) : undefined;
    })
    .catch(() => undefined)
    .finally(() => {
      clearTimeout(timer);
      inFlight.delete(controller);
      active--;
    });
  cache.set(url, result);
  return result;
}
