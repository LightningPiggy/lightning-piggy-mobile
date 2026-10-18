import { enabledAppRelays, loadAppRelayPrefs } from './appRelayPrefs';
// Removing an account's Marmot invitation keys (kind-30443 key packages)
// from relays when it signs out of this install (#1204).
//
// Marmot clients invite the newest key package they find, so one left behind
// by a signed-out install keeps attracting invites that nobody can open —
// they fail with "No matching secret" on every other device the person uses.
// White Noise does the same at sign-out ("Remove invitation keys from
// relays"): a kind-5 deletion per key package, sent while the signer is still
// available. We tag both the event (`e`) and this install's addressable slot
// (`a` = 30443:<pubkey>:<d>), so every version ever published into the slot
// goes, plus `k` = 30443 (NIP-09).
//
// Only THIS install's slot is touched — the person's other devices keep
// theirs. Best-effort and time-boxed: sign-out must never wedge on a relay or
// an unanswered signer prompt. When it can't finish (offline, signer refused
// or unavailable), a PUBLIC-ONLY record (slot ids, event ids, relays) survives
// the account wipe and is retried the next time this account signs in here.

import AsyncStorage from '@react-native-async-storage/async-storage';
import { getKeyPackageLifetime, getKeyPackageRelays } from '@internet-privacy/marmot-ts';
import {
  verifyEvent,
  type Event as NostrEvent,
  type EventTemplate,
  type Filter,
} from 'nostr-tools';

import { relayListFromTags, isRelayUrl } from '../utils/relayListEvents';
import { createSqliteMarmotBackend, decodeMarmotValue, type MarmotKvBackend } from './marmotStore';
import { newestEvent } from './marmotKeyPackages';
import { rememberKeyPackageTimestamp } from './marmotInstallationSlot';
import { pool, trackRelays } from './nostrPool';
import { DEFAULT_RELAYS } from './nostrService';
import { keyPackageRelayHistory } from './marmotKeyPackageHistory';
import { visitKeyPackageRelays } from './marmotKeyPackageRelays';

const KEY_PACKAGE_KIND = 30443;
const QUERY_MAX_WAIT_MS = 5_000;
const PUBLISH_TIMEOUT_MS = 8_000;
/** Long enough to approve one Amber / NIP-46 prompt. */
const SIGN_TIMEOUT_MS = 60_000;
/** Key packages live at most 84 days (+1 h); after that nothing can use them. */
const MAX_KEY_PACKAGE_LIFETIME_SECS = 7_261_200;
/** Give up on a pending retirement after this many sign-in retries. */
export const MAX_RETIREMENT_ATTEMPTS = 5;
const PENDING_KEY_PREFIX = 'marmot_pending_key_retirement_';

export type RetireOutcome = 'deleted' | 'nothing' | 'failed';

export interface RetireTransport {
  query(relays: string[], filter: Filter): Promise<NostrEvent[]>;
  /** The relays that accepted the event. */
  publish(relays: string[], event: NostrEvent): Promise<string[]>;
}

/** What this install published for an account — public data only. */
export interface KeyPackageFootprint {
  slots: string[];
  eventIds: string[];
  /** Relays our key packages were published to (their `relays` tag). */
  relays: string[];
  /** When the newest of them expires (unix s); nothing to retire after. */
  expiresAt?: number;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

const poolTransport: RetireTransport = {
  async query(relays, filter) {
    trackRelays(relays);
    return pool.querySync(relays, filter, { maxWait: QUERY_MAX_WAIT_MS });
  },
  async publish(relays, event) {
    trackRelays(relays);
    const settled = await Promise.allSettled(
      pool.publish(relays, event).map((p) => withTimeout(p, PUBLISH_TIMEOUT_MS)),
    );
    return relays.filter((_, i) => settled[i]?.status === 'fulfilled');
  },
};

/** What this install published for the backend's owner. */
export async function localKeyPackageFootprint(
  backend: MarmotKvBackend,
): Promise<KeyPackageFootprint> {
  const slots = new Set<string>();
  const eventIds = new Set<string>();
  const history = await keyPackageRelayHistory(backend);
  const relays = new Set(Object.keys(history));
  let expiresAt: number | undefined = Object.values(history).length
    ? Math.max(...Object.values(history))
    : undefined;
  const slot = await backend.get('meta', 'keyPackageSlot');
  if (slot) slots.add(slot);
  for (const key of await backend.keys('keyPackages')) {
    const raw = await backend.get('keyPackages', key);
    if (!raw) continue;
    try {
      const kp = decodeMarmotValue<{ identifier?: string; published?: NostrEvent[] }>(raw);
      if (kp.identifier) slots.add(kp.identifier);
      for (const e of kp.published ?? []) {
        eventIds.add(e.id);
        const notAfter = safely(() => getKeyPackageLifetime(e))?.notAfter;
        if (notAfter !== undefined && Number(notAfter) + 3600 < Date.now() / 1000) continue;
        for (const url of safely(() => getKeyPackageRelays(e)) ?? []) relays.add(url);
        if (notAfter !== undefined) expiresAt = Math.max(expiresAt ?? 0, Number(notAfter));
      }
    } catch {
      // unreadable row — nothing to learn from it
    }
  }
  return {
    slots: [...slots],
    eventIds: [...eventIds],
    relays: [...relays],
    ...(expiresAt !== undefined ? { expiresAt } : {}),
  };
}

function safely<T>(f: () => T): T | undefined {
  try {
    return f();
  } catch {
    return undefined;
  }
}

/** The NIP-09 deletion for every key package in this install's slot(s). */
export function buildKeyPackageDeletion(
  owner: string,
  slots: string[],
  eventIds: string[],
  createdAt = Math.floor(Date.now() / 1000),
): EventTemplate {
  return {
    kind: 5,
    created_at: createdAt,
    content: '',
    tags: [
      ['k', String(KEY_PACKAGE_KIND)],
      ...eventIds.map((id) => ['e', id]),
      ...slots.map((d) => ['a', `${KEY_PACKAGE_KIND}:${owner}:${d}`]),
    ],
  };
}

export type RetireSigner = (template: EventTemplate) => Promise<NostrEvent>;

interface RetireFootprintOptions {
  owner: string;
  footprint: KeyPackageFootprint;
  sign: RetireSigner;
  /** Extra relays to send to (e.g. the account's current write relays). */
  relays?: string[];
  transport?: RetireTransport;
  /** Called once, right before the first signer request. */
  onBeforeSign?: () => void;
  /** Abandon (as 'failed') once this turns true — checked between steps. */
  cancelled?: () => boolean;
  /**
   * Before anything is signed: re-decide, from the slot versions relays hold
   * right now, what to retire — e.g. skip a slot another device refreshed
   * after the caller looked (#1236). Nothing left → 'nothing'.
   */
  recheck?: (onRelays: NostrEvent[]) => { slots: string[]; eventIds: string[] };
}

const slotOf = (e: NostrEvent) => e.tags.find((t) => t[0] === 'd')?.[1];

/**
 * Delete and replace the given key packages on relays. 'deleted' only when
 * every event reached some relay AND every relay our key packages were
 * published to took the deletion or the replacement — an unrelated relay
 * accepting it doesn't hide an original one still advertising the key.
 */
export async function retireFootprint(opts: RetireFootprintOptions): Promise<RetireOutcome> {
  const { owner, footprint } = opts;
  const source = opts.transport ?? poolTransport;
  const transport: RetireTransport = {
    query: (relays, filter) =>
      visitKeyPackageRelays(relays, (batch) => {
        if (opts.cancelled?.()) throw new Error('retirement cancelled');
        return source.query(batch, filter);
      }),
    publish: (relays, event) =>
      visitKeyPackageRelays(relays, (batch) => {
        if (opts.cancelled?.()) throw new Error('retirement cancelled');
        return source.publish(batch, event);
      }),
  };
  const abandoned = () => {
    if (opts.cancelled?.()) throw new Error('retirement cancelled');
  };
  let prompted = false;
  const sign = async (template: EventTemplate) => {
    abandoned();
    if (!prompted) opts.onBeforeSign?.();
    prompted = true;
    const event = await withTimeout(opts.sign(template), SIGN_TIMEOUT_MS);
    // An inactive NIP-46 identity may have no connected signer. Never let
    // the active account's signer retire a similarly named slot instead.
    if (
      event.pubkey !== owner ||
      !verifyEvent(event) ||
      event.kind !== template.kind ||
      event.content !== template.content ||
      event.created_at !== template.created_at ||
      JSON.stringify(event.tags) !== JSON.stringify(template.tags)
    ) {
      throw new Error('Invitation-key signer returned a different account or event');
    }
    await rememberKeyPackageTimestamp(event);
    return event;
  };
  if (footprint.slots.length === 0 && footprint.eventIds.length === 0) return 'nothing';
  try {
    await loadAppRelayPrefs(owner);
    const hints = footprint.relays.filter(isRelayUrl);
    const lookup = [
      ...new Set([
        ...(opts.relays ?? []),
        ...hints,
        ...enabledAppRelays('default', DEFAULT_RELAYS, owner),
      ]),
    ].filter(isRelayUrl);
    // Our key packages live on our NIP-65 write relays — send the deletion there too.
    const relayList = newestEvent(
      await transport.query(lookup, { kinds: [10002], authors: [owner], limit: 5 }),
    );
    const writeRelays = relayList
      ? relayListFromTags(relayList.tags)
          .filter((r) => r.write)
          .map((r) => r.url)
      : [];
    const targets = [...new Set([...writeRelays, ...lookup])];
    abandoned();
    // Also catch versions of our slot published by an earlier run of this install.
    const found =
      footprint.slots.length > 0
        ? await transport.query(targets, {
            kinds: [KEY_PACKAGE_KIND],
            authors: [owner],
            '#d': footprint.slots,
            limit: 50,
          })
        : [];
    abandoned();
    const { slots, eventIds } = opts.recheck?.(found) ?? footprint;
    if (slots.length === 0 && eventIds.length === 0) return 'nothing';
    const onRelays = found.filter((e) => slots.includes(slotOf(e) ?? ''));
    const ids = [...new Set([...eventIds, ...onRelays.map((e) => e.id)])];
    const deletion = await sign(buildKeyPackageDeletion(owner, slots, ids));
    const deletedOn = new Set(await transport.publish(targets, deletion));
    // Some relays ignore NIP-09. Replace each addressable slot as well so
    // their latest record no longer advertises usable invitation material.
    // One second beyond the latest known publication avoids a same-second
    // replacement losing Nostr's lower-event-id tie-break.
    const createdAt = Math.max(deletion.created_at, ...onRelays.map((e) => e.created_at)) + 1;
    const replacedOn: Set<string>[] = [];
    for (const slot of slots) {
      const replacement = await sign({
        kind: KEY_PACKAGE_KIND,
        created_at: createdAt,
        content: '',
        tags: [['d', slot]],
      });
      replacedOn.push(new Set(await transport.publish(targets, replacement)));
    }
    // A relay is clean if it took the deletion, or every slot's replacement.
    const covered = (relay: string) =>
      deletedOn.has(relay) || (replacedOn.length > 0 && replacedOn.every((s) => s.has(relay)));
    const complete =
      deletedOn.size > 0 && replacedOn.every((s) => s.size > 0) && hints.every(covered);
    return complete ? 'deleted' : 'failed';
  } catch (e) {
    if (__DEV__) console.warn('[Marmot] could not remove invitation keys from relays:', e);
    return 'failed';
  }
}

export interface RetireOptions {
  owner: string;
  /** Null when no signer for `owner` is available (e.g. an unpaired NIP-46 account). */
  sign: RetireSigner | null;
  relays?: string[];
  backend?: MarmotKvBackend;
  transport?: RetireTransport;
  onBeforeSign?: () => void;
}

/**
 * Sign-out: delete this install's key packages for `owner` from relays.
 * Call BEFORE the account's signer and local Marmot state are wiped.
 * 'nothing' when this install never published one (no signer prompt then).
 * On 'failed' the public footprint is kept for a retry at the next sign-in.
 */
export async function retireMarmotKeyPackages(opts: RetireOptions): Promise<RetireOutcome> {
  const backend = opts.backend ?? createSqliteMarmotBackend(opts.owner);
  let footprint: KeyPackageFootprint;
  try {
    footprint = await localKeyPackageFootprint(backend);
  } catch {
    return 'failed';
  }
  if (footprint.slots.length === 0 && footprint.eventIds.length === 0) return 'nothing';
  const outcome = opts.sign
    ? await retireFootprint({ ...opts, sign: opts.sign, footprint })
    : 'failed';
  if (outcome === 'failed') await savePendingRetirement(opts.owner, footprint);
  return outcome;
}

// --- pending retirements (public data only; survive the account wipe) -------

interface PendingRetirement extends KeyPackageFootprint {
  attempts: number;
}

const pendingKey = (owner: string) => `${PENDING_KEY_PREFIX}${owner}`;

async function loadPending(owner: string): Promise<PendingRetirement | null> {
  try {
    const raw = await AsyncStorage.getItem(pendingKey(owner));
    return raw ? (JSON.parse(raw) as PendingRetirement) : null;
  } catch {
    return null;
  }
}

/** Remember (merging with any earlier one) what still has to be retired. */
export async function savePendingRetirement(
  owner: string,
  footprint: KeyPackageFootprint,
): Promise<void> {
  const prev = await loadPending(owner);
  const union = (a: string[] = [], b: string[] = []) => [...new Set([...a, ...b])];
  const nowSecs = Math.floor(Date.now() / 1000);
  const record: PendingRetirement = {
    slots: union(prev?.slots, footprint.slots),
    eventIds: union(prev?.eventIds, footprint.eventIds),
    relays: union(prev?.relays, footprint.relays),
    expiresAt: Math.max(
      prev?.expiresAt ?? 0,
      footprint.expiresAt ?? nowSecs + MAX_KEY_PACKAGE_LIFETIME_SECS,
    ),
    attempts: prev?.attempts ?? 0,
  };
  await AsyncStorage.setItem(pendingKey(owner), JSON.stringify(record)).catch(() => undefined);
}

/**
 * Retry a sign-out cleanup that failed earlier, now that `owner`'s signer is
 * available again. Dropped once done, once every key package it covers has
 * expired, or after MAX_RETIREMENT_ATTEMPTS. `keepSlot` (the slot this
 * install publishes into now) is never retired.
 */
export async function retryPendingRetirement(opts: {
  owner: string;
  sign: RetireSigner;
  keepSlot?: string;
  cancelled?: () => boolean;
  transport?: RetireTransport;
}): Promise<RetireOutcome> {
  const pending = await loadPending(opts.owner);
  if (!pending) return 'nothing';
  const drop = () => AsyncStorage.removeItem(pendingKey(opts.owner)).catch(() => undefined);
  const nowSecs = Math.floor(Date.now() / 1000);
  if ((pending.expiresAt ?? 0) < nowSecs || pending.attempts >= MAX_RETIREMENT_ATTEMPTS) {
    await drop();
    return 'nothing';
  }
  const footprint = { ...pending, slots: pending.slots.filter((s) => s !== opts.keepSlot) };
  const outcome = await retireFootprint({ ...opts, footprint });
  if (outcome === 'failed') {
    if (opts.cancelled?.()) return outcome; // not a real attempt — and maybe wiped
    await AsyncStorage.setItem(
      pendingKey(opts.owner),
      JSON.stringify({ ...pending, attempts: pending.attempts + 1 }),
    ).catch(() => undefined);
  } else {
    await drop();
  }
  return outcome;
}
