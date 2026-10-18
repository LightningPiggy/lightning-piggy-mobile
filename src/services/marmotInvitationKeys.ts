import { enabledAppRelays, loadAppRelayPrefs } from './appRelayPrefs';
import { isTestRelayLockdown, TEST_RELAY_URL } from '../config/testRelayLockdown';
import { MARMOT_KEY_PACKAGE_RELAYS, parseKeyPackageRelayList } from './marmotKeyPackageRelays';
// Relay side of "Devices that can get new chats" (#1236): a bounded inventory
// of the account's public invitation keys, and removing other devices' keys
// through #1230's retirement path. No private key material is read or
// changed here, and this phone's own key is never removed from this screen —
// it can only be refreshed (MarmotSession.refreshInvitationKey).
import { type Event as NostrEvent, type EventTemplate, type Filter } from 'nostr-tools';

import { isRelayUrl, relayListFromTags } from '../utils/relayListEvents';
import { pool, trackRelays } from './nostrPool';
import { DEFAULT_RELAYS } from './nostrService';
import { newestEvent } from './marmotKeyPackages';
import { createSqliteMarmotBackend } from './marmotStore';
import {
  localKeyPackageFootprint,
  retireFootprint,
  type RetireTransport,
} from './marmotKeyPackageRetire';
import {
  shapeInvitationKeys,
  stillOldDevices,
  type InvitationDevice,
  type InvitationKey,
} from './marmotInvitationDevices';

const MAX_RELAYS = 12;
const PER_RELAY_LIMIT = 100;

export interface InvitationInventory {
  keys: InvitationKey[];
  /** Some relay failed or hit the limit: the list may be missing devices. */
  partial: boolean;
  /** Last local key/list maintenance failed; Refresh retries it. */
  publicationFailed?: boolean;
  /** This phone's current publication slot, if it has one. */
  localSlot?: string;
}

export type InventoryQuery = (relays: string[], filter: Filter) => Promise<NostrEvent[]>;
export const queryInvitationKeys: InventoryQuery = (relays, filter) => {
  trackRelays(relays);
  return new Promise((resolve, reject) => {
    const events: NostrEvent[] = [];
    // nostr-tools synthesizes EOSE at maxWait. Our earlier deadline must
    // reject first, otherwise a timed-out relay looks like a complete scan.
    let subscription: { close(): void } | undefined;
    const timer = setTimeout(() => {
      reject(new Error('Invitation-key relay timed out'));
      subscription?.close();
    }, 5000);
    subscription = pool.subscribeManyEose(relays, filter, {
      maxWait: 6000,
      onevent: (event) => events.push(event),
      onclose: (reasons) => {
        clearTimeout(timer);
        if (reasons.some((reason) => reason !== 'closed automatically on eose'))
          reject(new Error('Invitation-key relay unavailable'));
        else resolve(events);
      },
    });
  });
};

export async function loadInvitationKeys(
  owner: string,
  relays: string[],
  fetch: InventoryQuery = queryInvitationKeys,
): Promise<InvitationInventory> {
  await loadAppRelayPrefs(owner);
  const backend = createSqliteMarmotBackend(owner);
  const locked = isTestRelayLockdown(owner);
  const lookup = [
    ...new Set(
      locked
        ? [TEST_RELAY_URL]
        : [
            ...enabledAppRelays('marmot', MARMOT_KEY_PACKAGE_RELAYS, owner),
            ...relays,
            ...enabledAppRelays('default', DEFAULT_RELAYS, owner),
          ],
    ),
  ]
    .filter(isRelayUrl)
    .slice(0, MAX_RELAYS);
  let discoveryFailed = false;
  const lists = await fetch(lookup, { kinds: [10002, 10051], authors: [owner], limit: 5 }).catch(
    () => {
      discoveryFailed = true;
      return [];
    },
  );
  const latest = newestEvent(lists.filter((e) => e.pubkey === owner && e.kind === 10002));
  const keyList = newestEvent(lists.filter((e) => e.pubkey === owner && e.kind === 10051));
  const allTargets = locked
    ? [TEST_RELAY_URL]
    : [
        ...new Set([
          ...enabledAppRelays('marmot', MARMOT_KEY_PACKAGE_RELAYS, owner),
          ...(keyList ? parseKeyPackageRelayList(keyList.tags) : []),
          ...(latest ? relayListFromTags(latest.tags).map((r) => r.url) : []),
          ...lookup,
        ]),
      ].filter(isRelayUrl);
  const targets = allTargets.slice(0, MAX_RELAYS);
  // No since: old and expired keys are precisely what this screen manages.
  const results = await Promise.allSettled(
    targets.map(async (relay) => ({
      relay,
      events: await fetch([relay], { kinds: [30443], authors: [owner], limit: PER_RELAY_LIMIT }),
    })),
  );
  const responses = results.flatMap((r) => (r.status === 'fulfilled' ? [r.value] : []));
  if (!responses.length) throw new Error('Invitation-key relays unavailable');
  const local = await localKeyPackageFootprint(backend);
  const localSlot = (await backend.get('meta', 'keyPackageSlot')) ?? undefined;
  return {
    keys: shapeInvitationKeys(owner, responses, local.slots),
    publicationFailed: (await backend.get('keyPackageDiscovery', 'failed')) === 'true',
    partial:
      discoveryFailed ||
      allTargets.length > MAX_RELAYS ||
      results.some((r) => r.status === 'rejected') ||
      responses.some((r) => r.events.length >= PER_RELAY_LIMIT),
    ...(localSlot ? { localSlot } : {}),
  };
}

export interface RemoveDevicesArgs {
  owner: string;
  devices: InvitationDevice[];
  /** The account's relays — the removal goes to these and each key's own relays. */
  relays: string[];
  sign: (template: EventTemplate) => Promise<NostrEvent>;
  /** False once the active account changed: nothing more is signed. */
  isCurrent: () => boolean;
  /** Bulk "Remove old devices": skip any device relays no longer show as old. */
  onlyIfStillOld?: boolean;
  transport?: RetireTransport;
  now?: number;
}

/**
 * Stop invites to other devices: a NIP-09 deletion plus an empty replacement
 * in each device's slot (#1230's retireFootprint). Resolves with how many
 * devices were removed; rejects when no relay or not every source relay took
 * it. Never this phone's slot — that would stop new chats reaching it while
 * its private key stays here unused.
 */
export async function removeInvitationDevices(args: RemoveDevicesArgs): Promise<number> {
  const { owner, devices } = args;
  if (!args.isCurrent() || !devices.length) throw new Error('Account changed');
  if (
    devices.some(
      (d) =>
        !d.versions.length ||
        d.versions.some((k) => k.event.pubkey !== owner || k.event.kind !== 30443),
    )
  )
    throw new Error('Invitation key belongs to another account');
  const local = await localKeyPackageFootprint(createSqliteMarmotBackend(owner));
  if (devices.some((d) => d.kind === 'thisPhone' || local.slots.includes(d.slot)))
    throw new Error("This phone's invitation key can only be refreshed");
  let removed = devices.length;
  const outcome = await retireFootprint({
    owner,
    footprint: {
      slots: devices.map((d) => d.slot),
      eventIds: devices.flatMap((d) => d.versions.map((k) => k.event.id)),
      relays: [...new Set(devices.flatMap((d) => d.relays))],
    },
    relays: args.relays,
    transport: args.transport,
    cancelled: () => !args.isCurrent(),
    recheck: args.onlyIfStillOld
      ? (onRelays) => {
          const still = stillOldDevices(devices, owner, onRelays, args.now);
          removed = still.slots.length;
          return still;
        }
      : undefined,
    sign: async (template) => {
      if (!args.isCurrent()) throw new Error('Account changed');
      const signed = await args.sign(template);
      if (!args.isCurrent()) throw new Error('Account changed');
      return signed;
    },
  });
  if (outcome === 'failed') throw new Error('Invitation-key removal incomplete');
  return outcome === 'nothing' ? 0 : removed;
}
