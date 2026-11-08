import type { VerifiedEvent } from 'nostr-tools/pure';
import { lockRelays } from '../config/testRelayLockdown';
import { perfLog, perfOwnerTag } from '../utils/perfLog';
import { normalizeRelayUrl } from '../utils/relayListKey';
import { DM_PUBLISH_TIMEOUT_MS } from './nostrDmPublish';
import { pool, pooledRelayUrls, releaseNewIdleRelays, trackRelays } from './nostrPool';
import {
  getManyPeerRelayLists,
  peekPeerRelayLists,
  type PeerRelayListResult,
} from './peerRelayLists';

// Outbox-model delivery for DMs (#1570): besides the sender's usual set
// (write relays ∪ defaults, kept for backward compatibility), each signed
// event also goes to where ITS recipient reads — the kind-10050 inbox for a
// NIP-17 gift wrap (the self-copy goes to the sender's own 10050), the NIP-65
// read relays for a NIP-04 kind 4.
//
// Never adds send latency and never re-signs: callers publish to their usual
// set as before and start this alongside it. Cached lists are used at once;
// otherwise the lookup gets `PEER_LOOKUP_TIMEOUT_MS`, then the SAME signed
// events go to the extra relays (a lookup that finishes later still fills the
// cache for the next send). It is best-effort and reported separately — it
// never changes the send's result or its delivery tick, so a dead or hostile
// inbox relay can't turn a delivered message into a failed one.
//
// Bounded: peer lists are sanitised and capped per peer (utils/peerRelayUrls),
// at most MAX_EXTRA_RELAYS_PER_SEND extra sockets per send (shared fairly
// across a group's members), and the sockets this opened are released once
// idle. Test accounts stay on the LAN test relay: extras are locked by the
// sender, like the rest of the send, before anything is published.

/** Which of the recipient's lists an event is delivered to. */
export type PeerRelayRole = 'inbox' | 'read';

/** Opt-in options a send threads through to the outbox routing. */
export interface PeerRoutingOptions {
  /** The sender's read relays, asked for the recipients' lists. */
  lookupRelays?: readonly string[];
}

export const PEER_LOOKUP_TIMEOUT_MS = 2_500;
/** Most extra relays (sockets) one send fans out to, across all recipients. */
export const MAX_EXTRA_RELAYS_PER_SEND = 12;

const HEX_PUBKEY = /^[0-9a-f]{64}$/;

export interface PeerRoute {
  event: VerifiedEvent;
  recipient: string;
  relays: string[];
}

export interface PeerDeliveryReport {
  /** Distinct extra relays published to. */
  relays: string[];
  /** Extra relays that accepted at least one event. */
  accepted: string[];
  /** Recipients whose lists came from the cache without waiting. */
  cacheHits: number;
}

/** The recipient an event is addressed to: its first `p` tag. */
export function eventRecipient(event: { tags: string[][] }): string | undefined {
  const value = event.tags.find((tag) => tag[0] === 'p')?.[1]?.toLowerCase();
  return value && HEX_PUBKEY.test(value) ? value : undefined;
}

export function peerRelaysFor(
  result: PeerRelayListResult | undefined,
  role: PeerRelayRole,
): readonly string[] {
  if (result?.status !== 'ok') return [];
  return (role === 'inbox' ? result.lists.inbox : result.lists.read) ?? [];
}

/**
 * Per event, the recipient's relays that aren't already in `baseRelays`,
 * capped at `maxExtra` distinct relays per send. Allocation is round-robin
 * (every recipient's first relay before anyone's second) so one member with a
 * long list can't crowd out the rest of a group. Pure.
 */
export function planPeerRoutes(
  events: readonly VerifiedEvent[],
  relaysFor: (recipient: string) => readonly string[],
  baseRelays: readonly string[],
  maxExtra: number = MAX_EXTRA_RELAYS_PER_SEND,
): PeerRoute[] {
  const base = new Set(baseRelays.map(normalizeRelayUrl));
  const candidates = events.flatMap((event) => {
    const recipient = eventRecipient(event);
    if (!recipient) return [];
    const relays = relaysFor(recipient).filter((url) => !base.has(normalizeRelayUrl(url)));
    return relays.length ? [{ event, recipient, relays }] : [];
  });
  const chosen = new Set<string>();
  const routes = candidates.map(({ event, recipient }) => ({
    event,
    recipient,
    relays: [] as string[],
  }));
  const longest = Math.max(0, ...candidates.map((c) => c.relays.length));
  for (let round = 0; round < longest; round++) {
    candidates.forEach((candidate, i) => {
      const url = candidate.relays[round];
      if (url === undefined) return;
      const key = normalizeRelayUrl(url);
      if (!chosen.has(key)) {
        if (chosen.size >= maxExtra) return;
        chosen.add(key);
      }
      if (!routes[i].relays.some((r) => normalizeRelayUrl(r) === key)) routes[i].relays.push(url);
    });
  }
  return routes.filter((route) => route.relays.length > 0);
}

const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('timed out')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};

/** Wait at most `ms` for the lookups; whatever finished by then is in the cache. */
async function listsWithin(
  recipients: string[],
  senderPubkey: string,
  lookupRelays: readonly string[] | undefined,
  ms: number,
): Promise<Map<string, PeerRelayListResult | undefined>> {
  const lookup = getManyPeerRelayLists(recipients, { viewerPubkey: senderPubkey, lookupRelays });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), ms);
  });
  const settled = await Promise.race([lookup, timedOut]).finally(() => clearTimeout(timer));
  if (settled) return settled;
  return new Map(recipients.map((pk) => [pk, peekPeerRelayLists(pk, senderPubkey)]));
}

/**
 * Publish each already-signed event to its recipient's `role` relays beyond
 * `baseRelays` (see the module comment). Never rejects.
 */
export async function deliverToPeerRelays(input: {
  events: readonly VerifiedEvent[];
  /** The send's author: binds lockdown and the lookup. */
  senderPubkey: string;
  /** Where the send already goes (sender-locked). */
  baseRelays: readonly string[];
  role: PeerRelayRole;
  lookupRelays?: readonly string[];
  lookupTimeoutMs?: number;
  publishTimeoutMs?: number;
}): Promise<PeerDeliveryReport> {
  const empty: PeerDeliveryReport = { relays: [], accepted: [], cacheHits: 0 };
  try {
    const sender = input.senderPubkey.toLowerCase();
    const recipients = [
      ...new Set(input.events.map(eventRecipient).filter((pk): pk is string => !!pk)),
    ];
    if (recipients.length === 0) return empty;
    const cacheHits = recipients.filter((pk) => peekPeerRelayLists(pk, sender)).length;
    const started = Date.now();
    const lists = await listsWithin(
      recipients,
      sender,
      input.lookupRelays,
      input.lookupTimeoutMs ?? PEER_LOOKUP_TIMEOUT_MS,
    );
    const lookupMs = Date.now() - started;
    // Lock BEFORE publishing: gift wraps carry ephemeral authors, so the pool's
    // author-based routing can't see that a test account sent them.
    const base = new Set(
      [...lockRelays([...input.baseRelays], sender)].map((url) => normalizeRelayUrl(url)),
    );
    const routes = planPeerRoutes(input.events, (pk) => peerRelaysFor(lists.get(pk), input.role), [
      ...base,
    ])
      .map((route) => ({
        ...route,
        relays: [...lockRelays(route.relays, sender)].filter(
          (url) => !base.has(normalizeRelayUrl(url)),
        ),
      }))
      .filter((route) => route.relays.length > 0);
    const relays = [...new Set(routes.flatMap((route) => route.relays))];
    if (relays.length === 0) {
      perfLog(
        `peerOutbox ${input.role} owner=${perfOwnerTag(sender)} recipients=${recipients.length} ` +
          `hits=${cacheHits} lookup=${lookupMs}ms extras=0`,
      );
      return { ...empty, cacheHits };
    }

    const before = pooledRelayUrls();
    trackRelays(relays);
    const timeoutMs = input.publishTimeoutMs ?? DM_PUBLISH_TIMEOUT_MS;
    const accepted = new Set<string>();
    const raw: Promise<unknown>[] = [];
    const attempts = routes.flatMap((route) =>
      pool.publish(route.relays, route.event).map((attempt, i) => {
        raw.push(attempt);
        return withTimeout(attempt, timeoutMs).then(() => {
          accepted.add(route.relays[i]);
        });
      }),
    );
    // Release this send's one-off sockets once every attempt has finished
    // (sockets still in use, or pooled before, are left alone).
    void Promise.allSettled(raw).then(() => {
      try {
        releaseNewIdleRelays(relays, before);
      } catch {
        // Releasing is best-effort.
      }
    });
    await Promise.allSettled(attempts);
    perfLog(
      `peerOutbox ${input.role} owner=${perfOwnerTag(sender)} recipients=${recipients.length} ` +
        `hits=${cacheHits} lookup=${lookupMs}ms extras=${relays.length} ok=${accepted.size}`,
    );
    return { relays, accepted: relays.filter((url) => accepted.has(url)), cacheHits };
  } catch {
    return empty;
  }
}
