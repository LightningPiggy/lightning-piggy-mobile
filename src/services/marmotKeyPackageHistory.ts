// Copied keys can outlive relay settings. Keep their destinations only until
// the last key copied there expires; list corrections have separate receipts.
import { getKeyPackageLifetime } from '@internet-privacy/marmot-ts';
import type { Event as NostrEvent } from 'nostr-tools';
import { isRelayUrl } from '../utils/relayListEvents';
import type { MarmotKvBackend } from './marmotStore';

const NAMESPACE = 'keyPackageDiscovery';
/** Maximum MLS lifetime, including one hour of clock-skew grace. */
export const KEY_PACKAGE_HISTORY_SECS = 84 * 24 * 60 * 60 + 60 * 60;
type RelayHistory = Record<string, number>;

// Match the Marmot per-account promise chains (marmotSignatureKey). SQL
// adapters and their fenced session wrappers share an owner; in-memory test
// stores without an owner are independent by backend identity.
const pending = new Map<string | MarmotKvBackend, Promise<unknown>>();

function serialized<T>(backend: MarmotKvBackend, task: () => Promise<T>): Promise<T> {
  const account = backend.owner ?? backend;
  const run = (pending.get(account) ?? Promise.resolve()).catch(() => undefined).then(task);
  pending.set(account, run);
  void run
    .finally(() => {
      if (pending.get(account) === run) pending.delete(account);
    })
    .catch(() => undefined);
  return run;
}

export function keyPackageRelayHistory(backend: MarmotKvBackend): Promise<RelayHistory> {
  return serialized(backend, () => loadRelayHistory(backend));
}

/** Migration and pruning also write: call only inside the account's chain. */
async function loadRelayHistory(backend: MarmotKvBackend): Promise<RelayHistory> {
  const now = Math.floor(Date.now() / 1000);
  const history = JSON.parse(
    (await backend.get(NAMESPACE, 'relayHistory')) ?? '{}',
  ) as RelayHistory;
  const legacy = JSON.parse((await backend.get(NAMESPACE, 'relays')) ?? '[]') as string[];
  // Old records have no lifetime. Migrate once with a conservative deadline,
  // rather than extending them on every maintenance run or footprint read.
  for (const relay of legacy) {
    if (isRelayUrl(relay))
      history[relay] = Math.max(history[relay] ?? 0, now + KEY_PACKAGE_HISTORY_SECS);
  }
  const live = Object.fromEntries(
    Object.entries(history).filter(([relay, expiry]) => isRelayUrl(relay) && expiry > now),
  );
  await backend.set(NAMESPACE, 'relayHistory', JSON.stringify(live));
  await backend.remove(NAMESPACE, 'relays');
  return live;
}

export async function rememberKeyPackageRelays(
  backend: MarmotKvBackend,
  relays: string[],
  event: NostrEvent,
): Promise<void> {
  return serialized(backend, async () => {
    const history = await loadRelayHistory(backend);
    const lifetime = getKeyPackageLifetime(event);
    const expiry = lifetime
      ? Number(lifetime.notAfter) + 60 * 60
      : event.created_at + KEY_PACKAGE_HISTORY_SECS;
    if (expiry > Math.floor(Date.now() / 1000)) {
      for (const relay of relays) history[relay] = Math.max(history[relay] ?? 0, expiry);
    }
    await backend.set(NAMESPACE, 'relayHistory', JSON.stringify(history));
  });
}
