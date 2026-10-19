import { appRelayPrefsRevision, enabledAppRelays } from './appRelayPrefs';
import {
  isTestRelayLockdown,
  TEST_PUSH_DISABLED,
  TEST_RELAY_URL,
} from '../config/testRelayLockdown';
import { getCurrentUserPubkey } from './nostrActiveAccount';
// marmot-ts `NostrNetworkInterface` over the app's shared nostr-tools pool.
//
// Every relay call stays bounded (#perf rules): requests carry the library's
// own `limit`/`since`, and `request()` resolves on EOSE or `maxWait`.

import type { NostrNetworkInterface } from '@internet-privacy/marmot-ts';
import type { Event as NostrEvent, Filter } from 'nostr-tools';

import { createGroupSubscriptionMux } from './marmotGroupSubscriptions';
import { noteMarmotRelayReconnect } from './marmotRelayReconnect';
import { watchMarmotResume } from './marmotResume';
import { subscribeMarmotRelays } from './marmotSubscription';
import { requireRelayAcknowledgement } from '../utils/relayPublishResult';
import { dmInboxRelaysFromTags, isRelayUrl } from '../utils/relayListEvents';
import { isPublicRelayUrl } from '../utils/publicUrl';
import { pool, trackRelays } from './nostrPool';
import { selectHealthyRelays } from './relayHealth';
import { DEFAULT_RELAYS, MARMOT_PUSH_SERVER_RELAYS } from './nostrRelayDefaults';

const REQUEST_MAX_WAIT_MS = 6_000;
const PUBLISH_TIMEOUT_MS = 10_000;
const INBOX_CACHE_TTL_MS = 10 * 60_000;
/** A server whose 10050 wasn't found is asked again sooner — but not on
 * every message we send. */
const INBOX_MISS_TTL_MS = 60_000;

/** Most relays one push trigger is published to, and most taken from a push
 * server's 10050 inbox list. Bounded so a hostile record or list can't fan a
 * trigger out to arbitrarily many relays. */
export const MAX_PUSH_RELAYS = 8;
export const MAX_PUSH_INBOX_RELAYS = 5;

/**
 * Push-trigger destinations (#1338): relay hints come from other group
 * members' signed records and the inbox list from the push server's 10050,
 * and we connect to them automatically on every send. Only credential-free
 * public `wss://` relays survive (no `ws://`, no LAN / loopback / reserved
 * hosts — see utils/publicUrl), deduped and capped.
 */
export function cleanPushRelays(relays: readonly unknown[], max = MAX_PUSH_RELAYS): string[] {
  const out: string[] = [];
  for (const r of relays) {
    if (out.length >= max) break;
    if (isPublicRelayUrl(r) && !out.includes(r)) out.push(r);
  }
  return out;
}

/** Extra, app-only options on `request` (marmot-ts itself never passes any):
 * `requireAnswer` rejects an empty read that no relay completed. */
export interface MarmotRequestOptions {
  requireAnswer?: boolean;
}

const asArray = (f: Filter | Filter[]) => (Array.isArray(f) ? f : [f]);
const cleanRelays = (relays: string[]) => [...new Set(relays.filter(isRelayUrl))];
const withTimeout = <T>(p: Promise<T>, ms: number) =>
  Promise.race([
    p,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
  ]);
/** GroupsManager's live kind-445 routing: merged into one REQ per relay (#1399). */
const isGroupLive = (filters: Filter[]) =>
  filters.every((f) => f.kinds?.length === 1 && f.kinds[0] === 445 && f['#h']?.length);

export function createMarmotNetwork(
  getFallbackRelays: () => string[],
  onReconnect?: () => void,
  ownerPubkey: string | null = getCurrentUserPubkey(),
): NostrNetworkInterface {
  // Anonymous group events and Welcomes belong to this session, not their outer author.
  const locked = isTestRelayLockdown(ownerPubkey);
  let recovering = false;
  const attempts = new Map<string, number>();
  const liveSubscriptions = new Map<object, string[]>();
  let resetting: Promise<void> | undefined;
  const resetTransport = () => {
    resetting ??= pool
      .resetTransports([...new Set([...liveSubscriptions.values()].flat())])
      .finally(() => {
        resetting = undefined;
      });
    return resetting;
  };
  const reconnect = onReconnect
    ? () => {
        recovering = true;
        onReconnect();
      }
    : undefined;
  const relaysOr = (relays: string[]) => {
    const cleaned = cleanRelays(relays);
    return locked
      ? [TEST_RELAY_URL]
      : cleaned.length > 0
        ? cleaned
        : cleanRelays([
            ...getFallbackRelays(),
            ...enabledAppRelays('default', DEFAULT_RELAYS, ownerPubkey),
          ]);
  };
  const groupSubscribe = createGroupSubscriptionMux(
    (url, filters, next, onReqOpen, onClose) =>
      pool.subscribeMap(
        filters.map((filter) => ({ url, filter })),
        { onevent: next, onReqOpen, onclose: onClose },
      ),
    (urls, filter, signal) =>
      pool.querySyncFilters(urls, [filter], REQUEST_MAX_WAIT_MS, {
        abort: signal,
        requireEose: true,
      }),
    // A relay came back and its groups caught up: pending Welcomes retry.
    noteMarmotRelayReconnect,
  );
  // Merged group REQs have no per-route AppState handling (unlike
  // subscribeMarmotRelays). One watcher per network replaces transports after
  // the resume stagger — Doze can leave a socket OPEN but silently dead — then
  // reconnects the session so GroupsManager collects every backfill page and
  // drains one MLS batch before subscribing live, exactly as per-relay routes do.
  const groupOwners = new Set<object>();
  let groupResume: (() => void) | undefined;
  let resumeGeneration = 0;
  const watchGroupResume = () =>
    watchMarmotResume(async () => {
      const generation = ++resumeGeneration;
      await resetTransport();
      // Unsubscribed meanwhile (e.g. a sibling route already reconnected).
      if (generation !== resumeGeneration || groupOwners.size === 0) return;
      reconnect?.();
    });
  const inboxCache = new Map<string, { relays: string[]; at: number; revision: number }>();

  return {
    async publish(relays, event) {
      const requested = relaysOr(relays);
      const targets = [443, 30443, 10051].includes(event.kind)
        ? selectHealthyRelays(requested)
        : requested;
      trackRelays(targets);
      const settled = await Promise.allSettled(
        pool
          .publish(targets, event as NostrEvent)
          .map((p) => withTimeout(p.then(requireRelayAcknowledgement), PUBLISH_TIMEOUT_MS)),
      );
      return Object.fromEntries(
        targets.map((url, i) => {
          const r = settled[i];
          return [
            url,
            r.status === 'fulfilled'
              ? { from: url, ok: true, message: r.value }
              : { from: url, ok: false, message: String(r.reason) },
          ];
        }),
      );
    },

    // App callers may add `{ requireAnswer }` (see MarmotRequestOptions).
    async request(relays, filters, opts?: MarmotRequestOptions) {
      const targets = relaysOr(relays);
      trackRelays(targets);
      return pool.querySyncFilters(
        targets,
        asArray(filters as Filter | Filter[]),
        REQUEST_MAX_WAIT_MS,
        ...(opts?.requireAnswer ? [{ requireAnswer: true }] : []),
      );
    },

    subscription(relays, filters) {
      return {
        subscribe(observer) {
          const targets = relaysOr(relays);
          trackRelays(targets);
          const token = {};
          liveSubscriptions.set(token, targets);
          const list = asArray(filters as Filter | Filter[]);
          if (isGroupLive(list)) {
            const sub = groupSubscribe(targets, list, observer);
            groupOwners.add(token);
            groupResume ??= watchGroupResume();
            return {
              unsubscribe: () => {
                liveSubscriptions.delete(token);
                if (!groupOwners.delete(token)) return;
                resumeGeneration++;
                if (groupOwners.size === 0) {
                  groupResume?.();
                  groupResume = undefined;
                }
                sub.unsubscribe();
              },
            };
          }
          const sub = subscribeMarmotRelays(
            targets,
            list,
            (e) => observer.next?.(e),
            reconnect
              ? { reconnect, resetTransport, notifyInitial: recovering, attempts }
              : undefined,
          );
          return {
            unsubscribe: () => {
              liveSubscriptions.delete(token);
              sub.unsubscribe();
            },
          };
        },
      };
    },

    async getUserInboxRelays(pubkey) {
      const cached = inboxCache.get(pubkey);
      if (
        cached?.revision === appRelayPrefsRevision() &&
        Date.now() - cached.at < INBOX_CACHE_TTL_MS
      )
        return cached.relays;
      const revision = appRelayPrefsRevision();
      const lookup = relaysOr(getFallbackRelays());
      const events = await pool.querySync(
        lookup,
        { kinds: [10050], authors: [pubkey], limit: 1 },
        { maxWait: REQUEST_MAX_WAIT_MS },
      );
      const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
      const relays = relaysOr(latest ? dmInboxRelaysFromTags(latest.tags) : []);
      inboxCache.set(pubkey, { relays, at: Date.now(), revision });
      return relays;
    },
  };
}

/**
 * Strict relay access for MIP-05 push triggers: publish ONLY to the given
 * relays and read a server's inbox list without falling back to defaults —
 * triggers go to the records' relay hints and the server's own 10050 inbox;
 * anywhere else would just leak the trigger.
 * Locked test initiators skip both lookup and publication: public push
 * servers cannot receive a trigger on the LAN test relay.
 */
export interface PushTransport {
  publish(relays: string[], event: NostrEvent): Promise<void | typeof TEST_PUSH_DISABLED>;
  inboxRelays(pubkey: string): Promise<string[]>;
}

export function createPushTransport(
  getLookupRelays: () => string[],
  /** Account-owned transports retain their initiator across signing/lookup waits. */
  initiatingPubkey?: string,
): PushTransport {
  // Per server: its 10050 relays (cached, so a busy chat doesn't re-query on
  // every send) and any lookup in flight (concurrent triggers share it).
  const cache = new Map<string, { relays: string[]; at: number }>();
  const inFlight = new Map<string, Promise<string[]>>();
  const lookup = async (pubkey: string): Promise<string[]> => {
    // Our push servers' own relays first: that's where their 10050 lives.
    // Bounded by maxWait; the pool skips relays known to be down.
    const relays = cleanRelays([
      ...MARMOT_PUSH_SERVER_RELAYS,
      ...getLookupRelays(),
      ...enabledAppRelays('default', DEFAULT_RELAYS, initiatingPubkey),
    ]);
    trackRelays(relays); // closed on sign-out like every other relay we open
    const events = await pool.querySync(
      relays,
      { kinds: [10050], authors: [pubkey], limit: 1 },
      { maxWait: REQUEST_MAX_WAIT_MS },
    );
    const latest = events.sort((a, b) => b.created_at - a.created_at)[0];
    return latest ? cleanPushRelays(dmInboxRelaysFromTags(latest.tags), MAX_PUSH_INBOX_RELAYS) : [];
  };
  return {
    async publish(relays, event) {
      // Gift wraps have ephemeral authors: decide before author-based pool routing.
      if (isTestRelayLockdown(initiatingPubkey ?? getCurrentUserPubkey())) {
        return TEST_PUSH_DISABLED;
      }
      const targets = cleanPushRelays(relays);
      if (targets.length === 0) return;
      trackRelays(targets);
      await Promise.allSettled(
        pool.publish(targets, event).map((p) => withTimeout(p, PUBLISH_TIMEOUT_MS)),
      );
    },
    inboxRelays(pubkey) {
      if (isTestRelayLockdown(initiatingPubkey ?? getCurrentUserPubkey())) {
        return Promise.resolve([]);
      }
      const hit = cache.get(pubkey);
      const ttl = hit?.relays.length ? INBOX_CACHE_TTL_MS : INBOX_MISS_TTL_MS;
      if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.relays);
      const pending = inFlight.get(pubkey);
      if (pending) return pending;
      const run = lookup(pubkey)
        .then((relays) => {
          cache.set(pubkey, { relays, at: Date.now() });
          return relays;
        })
        .finally(() => inFlight.delete(pubkey));
      inFlight.set(pubkey, run);
      return run;
    },
  };
}
