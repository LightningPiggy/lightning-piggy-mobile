// Bounding marmot-ts's group backfill (#perf rules).
//
// marmot-ts backfills a group with an UNBOUNDED `{kinds:[445], #h}` filter
// on every connect. Bound it without losing history:
//  - `since` = newest *ingested* event − slack, so app start doesn't
//    re-download a group's whole history;
//  - the backfill pages backwards in `limit`-sized pages, so a device that
//    was offline through > `limit` events still gets every commit it needs
//    to decrypt later epochs;
//  - the durable watermark only advances once that backfill is ingested.
//    GroupsManager.connect drains the backfill BEFORE opening the live
//    subscription, so a request's newest timestamp is held as pending and
//    committed when the subscription for that group opens.

import type { NostrNetworkInterface } from '@internet-privacy/marmot-ts';
import type { Event as NostrEvent, Filter } from 'nostr-tools';

const GROUP_EVENT_KIND = 445;
// Re-read this far behind the newest INGESTED kind-445 (honest clock drift
// between members). The watermark only advances after ingestion and ignores
// future-dated events, so a short margin loses nothing — and every second of
// margin is re-fetched and trial-decrypted on the JS thread at each app start
// (spec: `since` is a fetch hint — transports/nostr.md).
export const GROUP_BACKFILL_SLACK_SECS = 10 * 60;
const GROUP_BACKFILL_LIMIT = 500;
// Safety stop for the paged backfill (500 × 40 = 20k events per group).
const GROUP_BACKFILL_MAX_PAGES = 40;
// Relay `created_at` is sender-controlled: an event dated in the future
// (anyone can publish a kind-445 with a group's public `h` tag) must never
// push the durable since-watermark past real traffic.
const MAX_FUTURE_SKEW_SECS = 5 * 60;
const isPlausibleTimestamp = (createdAt: number) =>
  createdAt <= Math.floor(Date.now() / 1000) + MAX_FUTURE_SKEW_SECS;

export interface GroupBackfillWatermarks {
  /** Newest ingested kind-445 `created_at` per group `h` (read and updated). */
  watermarks: Map<string, number>;
  /** Persist an advanced watermark. */
  persist: (h: string, createdAt: number) => void;
  /** Backfill page size (default 500). */
  pageSize?: number;
  /** A group's backfill has drained and its live subscription opened. */
  onLive?: (h: string) => void;
}

/** `network`, with kind-445 group backfills bounded and paged (see above). */
export function boundGroupQueries(
  network: NostrNetworkInterface,
  { watermarks, persist, pageSize, onLive }: GroupBackfillWatermarks,
): NostrNetworkInterface {
  const groupH = (f: Filter) =>
    f.kinds?.includes(GROUP_EVENT_KIND) && f.since === undefined ? f['#h']?.[0] : undefined;
  const bound = (f: Filter): Filter => {
    const h = groupH(f);
    if (!h) return f;
    const seen = watermarks.get(h);
    return {
      ...f,
      limit: f.limit ?? pageSize ?? GROUP_BACKFILL_LIMIT,
      ...(seen ? { since: seen - GROUP_BACKFILL_SLACK_SECS } : {}),
    };
  };
  const pending = new Map<string, number>();
  const commit = (h: string, createdAt: number) => {
    if (!isPlausibleTimestamp(createdAt)) return;
    if (createdAt <= (watermarks.get(h) ?? 0)) return;
    watermarks.set(h, createdAt);
    persist(h, createdAt);
  };
  const hOf = (e: NostrEvent) => e.tags.find((t) => t[0] === 'h')?.[1];

  /** Page a bounded group filter backwards until a short page. */
  const backfill = async (relays: string[], f: Filter): Promise<NostrEvent[]> => {
    return pageGroupHistory(
      (urls, filter) => network.request(urls, filter) as Promise<NostrEvent[]>,
      relays,
      f,
    );
  };

  return {
    ...network,
    // `rest`: app-only request options (MarmotRequestOptions) pass through.
    request: async (relays, filters, ...rest: unknown[]) => {
      const list = (Array.isArray(filters) ? filters : [filters]) as Filter[];
      // Keep non-group filters together: Welcome ownership verification uses
      // an exact-id lookup plus a corroborating author filter in ONE REQ.
      const ordinary = list.filter((f) => !groupH(f));
      const batches = await Promise.all([
        ...list.filter((f) => groupH(f)).map((f) => backfill(relays, bound(f))),
        ...(ordinary.length
          ? [
              (network.request as (...args: unknown[]) => Promise<NostrEvent[]>).call(
                network,
                relays,
                ordinary.length === 1 ? ordinary[0] : ordinary,
                ...rest,
              ),
            ]
          : []),
      ]);
      const byId = new Map<string, NostrEvent>();
      for (const e of batches.flat()) byId.set(e.id, e);
      for (const e of byId.values()) {
        const h = e.kind === GROUP_EVENT_KIND ? hOf(e) : undefined;
        if (h && isPlausibleTimestamp(e.created_at) && e.created_at > (pending.get(h) ?? 0)) {
          pending.set(h, e.created_at);
        }
      }
      return [...byId.values()];
    },
    subscription: (relays, filters) => {
      const list = (Array.isArray(filters) ? filters : [filters]) as Filter[];
      const inner = network.subscription(relays, list.map(bound));
      return {
        subscribe: (observer) => {
          // Backfill for these groups has been ingested — commit it.
          for (const f of list) {
            const h = groupH(f);
            const ts = h ? pending.get(h) : undefined;
            if (h && ts) {
              commit(h, ts);
              pending.delete(h);
            }
            if (h) onLive?.(h);
          }
          return inner.subscribe({
            ...observer,
            next: (e) => {
              const ev = e as NostrEvent;
              const h = ev.kind === GROUP_EVENT_KIND ? hOf(ev) : undefined;
              if (h) commit(h, ev.created_at);
              observer.next?.(e);
            },
          });
        },
      };
    },
  };
}

/** Most events one group's history may hold in memory before ingestion. */
export const GROUP_BACKFILL_MAX_EVENTS = GROUP_BACKFILL_LIMIT * GROUP_BACKFILL_MAX_PAGES;

/** Shared bounded paging; short pages may be relay-clamped rather than exhausted. */
export async function pageGroupHistory(
  request: (relays: string[], filter: Filter) => Promise<NostrEvent[]>,
  relays: string[],
  f: Filter,
  continueShortPages = false,
  signal?: AbortSignal,
  yieldPage?: () => Promise<void>,
): Promise<NostrEvent[]> {
  const { events } = await pageGroupHistoryStatus(
    request,
    relays,
    f,
    continueShortPages,
    signal,
    yieldPage,
  );
  return events;
}

/**
 * `pageGroupHistory`, also reporting whether the range was exhausted. A relay
 * that clamps pages below `limit` can run into the page cap with older events
 * still unread; `exhausted: false` tells the caller to continue below the
 * oldest event rather than treating the newest pages as the whole range.
 */
export async function pageGroupHistoryStatus(
  request: (relays: string[], filter: Filter) => Promise<NostrEvent[]>,
  relays: string[],
  f: Filter,
  continueShortPages = false,
  signal?: AbortSignal,
  yieldPage?: () => Promise<void>,
): Promise<{ events: NostrEvent[]; exhausted: boolean; saturated: boolean }> {
  const limit = f.limit ?? GROUP_BACKFILL_LIMIT;
  const byId = new Map<string, NostrEvent>();
  let until = f.until;
  let exhausted = false;
  let saturated = false;
  let largest = 0;
  for (let page = 0; page < GROUP_BACKFILL_MAX_PAGES && !signal?.aborted; page++) {
    const events = (await request(relays, {
      ...f,
      ...(until !== undefined ? { until } : {}),
    })) as NostrEvent[];
    const before = byId.size;
    for (const e of events) byId.set(e.id, e);
    if (!continueShortPages && events.length < limit) {
      exhausted = true;
      break;
    }
    if (byId.size === before) {
      // Only duplicates at `until`. When that page is as full as any this
      // relay has served, more events share the second than one page holds
      // and `until` can never reach the rest: step past the second so the
      // older history is still read, and report the gap, rather than claim
      // the range was exhausted after one page.
      if (until !== undefined && events.length >= Math.max(largest, SATURATION_MIN_PAGE)) {
        saturated = true;
        until -= 1;
        await yieldPage?.();
        continue;
      }
      exhausted = true;
      break;
    }
    largest = Math.max(largest, events.length);
    await yieldPage?.();
    until = Math.min(...events.map((e) => e.created_at));
  }
  // Collect EVERY page before ingestion: processing the newest page first
  // discards older sender ratchet keys (ts-mls retains only 10 generations).
  // MLS epochs are encrypted, so the adapter cannot sort on them. Marmot's
  // engine peels the current epoch, processes its applications before commits,
  // then retries later epochs. Preserve timestamp/id order within each epoch.
  return { events: [...byId.values()].sort(byTimeThenId), exhausted, saturated };
}

// A duplicate-only page this small is a tiny group whose events share one
// second, not a relay clamp (relays clamp in the hundreds), so it is exhausted.
const SATURATION_MIN_PAGE = 10;

export const byTimeThenId = (a: NostrEvent, b: NostrEvent) =>
  a.created_at - b.created_at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
