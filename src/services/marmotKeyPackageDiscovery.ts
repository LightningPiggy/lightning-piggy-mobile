import { enabledAppRelays, loadAppRelayPrefs } from './appRelayPrefs';
// Persist discovery receipts per account, so startup/resume never republishes
// unchanged keys/lists. Upgrades copy the existing signed key to the new relays.
import type { MarmotClient } from '@internet-privacy/marmot-ts';
import type { Event as NostrEvent } from 'nostr-tools';

import { isTestRelayLockdown, TEST_RELAY_URL } from '../config/testRelayLockdown';
import { RELAY_LIST_INDEXERS } from '../utils/relayListEvents';
import { publishWithReceipt } from './marmotPublicationReceipt';
import {
  currentKeyPackage,
  maintainKeyPackage,
  type MaintainKeyPackageOptions,
} from './marmotKeyPackageLifecycle';
import { newestEvent } from './marmotKeyPackages';
import {
  buildKeyPackageRelayList,
  cleanKeyPackageRelays,
  keyPackagePublishRelays,
} from './marmotKeyPackageRelays';
import type { MarmotKvBackend } from './marmotStore';
import { rememberKeyPackageRelays } from './marmotKeyPackageHistory';

interface DiscoveryOptions extends MaintainKeyPackageOptions {
  acceptedRelays?: (eventId: string) => string[];
}

export async function maintainDiscoverableKeyPackage(
  client: Pick<MarmotClient, 'keyPackages' | 'network' | 'signer'>,
  backend: MarmotKvBackend,
  owner: string,
  opts: DiscoveryOptions,
): Promise<'published' | 'unchanged' | 'failed'> {
  try {
    const outcome = await maintainDiscovery(client, backend, owner, opts);
    if (!opts.cancelled?.())
      await backend.set('keyPackageDiscovery', 'failed', String(outcome === 'failed'));
    return outcome;
  } catch (error) {
    if (!opts.cancelled?.()) await backend.set('keyPackageDiscovery', 'failed', 'true');
    throw error;
  }
}

async function maintainDiscovery(
  client: Pick<MarmotClient, 'keyPackages' | 'network' | 'signer'>,
  backend: MarmotKvBackend,
  owner: string,
  opts: DiscoveryOptions,
): Promise<'published' | 'unchanged' | 'failed'> {
  await loadAppRelayPrefs(owner);
  const relays = keyPackagePublishRelays(owner, opts.relays);
  if (opts.cancelled?.()) return 'failed';
  const outcome = await maintainKeyPackage(client.keyPackages, { ...opts, relays });
  if (outcome === 'failed' || opts.cancelled?.()) return 'failed';
  const current = currentKeyPackage(await client.keyPackages.list(), opts.slot);
  const event = newestEvent((current?.published ?? []) as NostrEvent[]);
  if (!event || opts.cancelled?.()) return 'failed';
  // Persist before copying: even an interrupted publication may reach a relay.
  await rememberKeyPackageRelays(backend, relays, event);
  if (opts.cancelled?.()) return 'failed';
  const namespace = 'keyPackageDiscovery';
  const fingerprint = JSON.stringify([...relays].sort());
  const publish = (targets: string[], signed: NostrEvent, key: string, fresh = false) =>
    publishWithReceipt({
      network: client.network,
      backend,
      key,
      event: signed,
      targets,
      initial: fresh ? opts.acceptedRelays?.(signed.id) : [],
      alreadyAttempted: fresh,
      cancelled: opts.cancelled,
    });
  const keyComplete = await publish(relays, event, 'keyAcks', outcome === 'published');
  let listComplete = true;
  const previousList = await backend.get(namespace, 'list');
  const pending = await backend.get(namespace, 'pendingList');
  const cached = pending ? (JSON.parse(pending) as NostrEvent) : undefined;
  const pendingFingerprint = cached && JSON.stringify(cached.tags.map((t) => t[1]).sort());
  const pendingTargets = JSON.parse(
    (await backend.get(namespace, 'pendingListTargets')) ?? '[]',
  ) as string[];
  // A newer, partially accepted list can supersede the completed list even
  // when settings revert. Correct it with a strictly newer signed event.
  if (
    previousList !== fingerprint ||
    (cached && pendingFingerprint !== fingerprint) ||
    pendingTargets.length
  ) {
    const targets = isTestRelayLockdown(owner)
      ? [TEST_RELAY_URL]
      : [
          ...new Set([
            ...relays,
            ...cleanKeyPackageRelays(previousList ? (JSON.parse(previousList) as string[]) : []),
            ...cleanKeyPackageRelays(cached ? cached.tags.map((t) => t[1]) : []),
            ...pendingTargets,
            ...enabledAppRelays('indexers', RELAY_LIST_INDEXERS, owner),
          ]),
        ];
    let signed = cached && pendingFingerprint === fingerprint ? cached : undefined;
    if (!signed) {
      const previous = Number(await backend.get(namespace, 'timestamp')) || 0;
      const draft = buildKeyPackageRelayList(
        owner,
        relays,
        Math.max(Math.floor(Date.now() / 1000), previous + 1),
      );
      if (opts.cancelled?.()) throw new Error('marmot: discovery cancelled');
      signed = (await client.signer.signEvent(draft)) as NostrEvent;
      if (opts.cancelled?.()) throw new Error('marmot: discovery cancelled');
      await backend.set(namespace, 'timestamp', String(signed.created_at));
      await backend.set(namespace, 'pendingList', JSON.stringify(signed));
    }
    // Keep each superseded destination only until it accepts the correction.
    await backend.set(namespace, 'pendingListTargets', JSON.stringify(targets));
    try {
      listComplete = await publish(targets, signed, 'listAcks');
    } finally {
      // A later batch may throw after earlier batches accepted the correction.
      // Do not carry those completed destinations into the next signed list.
      if (!opts.cancelled?.()) {
        const acks = JSON.parse((await backend.get(namespace, 'listAcks')) ?? 'null') as {
          id: string;
          relays: string[];
        } | null;
        if (acks?.id === signed.id) {
          await backend.set(
            namespace,
            'pendingListTargets',
            JSON.stringify(targets.filter((relay) => !acks.relays.includes(relay))),
          );
        }
      }
    }
    if (listComplete) {
      await backend.set(namespace, 'list', fingerprint);
      await backend.remove(namespace, 'pendingListTargets');
    }
  }
  return keyComplete && listComplete ? outcome : 'failed';
}
