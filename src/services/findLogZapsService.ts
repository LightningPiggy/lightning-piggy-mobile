import { enabledAppRelays } from './appRelayPrefs';
import type { Event as NostrEvent, Filter } from 'nostr-tools';
import { decode as bolt11Decode } from 'light-bolt11-decoder';
import { DEFAULT_RELAYS, fetchProfile, pool } from './nostrService';
import { resolveLightningAddress } from './lnurlService';
import { validateZapReceipt } from './zapReceiptValidation';

/**
 * Pull the satoshi amount out of a bolt11 invoice. Returns null when
 * the invoice is unparseable, amount-less, or non-positive — callers
 * skip those rather than try to fudge a zero. Mirrors the extraction
 * pattern in SendSheet so a future move to a shared bolt11 helper
 * touches one fewer site.
 */
export const parseBolt11Sats = (bolt11: string): number | null => {
  try {
    const decoded = bolt11Decode(bolt11) as { sections: { name: string; value?: unknown }[] };
    const amt = decoded.sections.find((s) => s.name === 'amount');
    if (!amt || typeof amt.value === 'undefined') return null;
    const sats = Math.round(Number(amt.value) / 1000);
    return Number.isFinite(sats) && sats > 0 ? sats : null;
  } catch {
    return null;
  }
};

export interface FindLogZap {
  /** Kind-9735 receipt id — used by the caller for cross-relay dedupe. */
  receiptId: string;
  /** Kind-7516 find-log id this zap landed on (the `e` tag). */
  logId: string;
  /** Satoshi amount extracted from the bolt11 invoice on the receipt. */
  sats: number;
}

// A finder's LNURL server key: the only key their zap receipts may be signed
// with (NIP-57). Resolved once per finder; a miss (no lightning address, no
// zap support, offline) is retried after a while, and never trusted.
const PROVIDER_MISS_TTL_MS = 5 * 60 * 1000;
const providerKeys = new Map<string, { key: Promise<string | null>; at: number }>();

export function resolveZapProviderPubkey(pubkey: string): Promise<string | null> {
  const hit = providerKeys.get(pubkey);
  if (hit && Date.now() - hit.at < PROVIDER_MISS_TTL_MS) return hit.key;
  const key = (async () => {
    try {
      // fetchProfile fully verifies the kind-0 before trusting its lud16.
      const profile = await fetchProfile(pubkey, enabledAppRelays('default', DEFAULT_RELAYS));
      if (!profile?.lud16) return null;
      const params = await resolveLightningAddress(profile.lud16.trim().toLowerCase());
      return params.allowsNostr && params.nostrPubkey ? params.nostrPubkey : null;
    } catch {
      return null;
    }
  })();
  const entry = { key, at: Date.now() };
  providerKeys.set(pubkey, entry);
  // Keep a found key for the session; let a miss age out and be retried.
  void key.then((k) => {
    if (k) entry.at = Infinity;
  });
  return key;
}

/** Test seam: forget resolved finder keys. */
export const __resetZapProviderKeys = (): void => providerKeys.clear();

/**
 * Subscribe to NIP-57 zap receipts (kind 9735) referencing any of the
 * given kind-7516 find-logs (log id -> finder pubkey) via their `#e` tag.
 * The callback fires once per matched, VALID receipt; the caller is
 * expected to dedupe by `receiptId` because the same receipt can arrive
 * from multiple relays. An empty map short-circuits — relays choke on
 * empty filter arrays.
 *
 * A receipt only counts when it is issued to the log's finder, signed by
 * the finder's LNURL server and carries a valid signed zap request
 * (#1780) — otherwise anyone could publish receipts to inflate totals.
 *
 * `#e` is one of the NIP-01 base-indexed tags so this works on damus,
 * primal, relay.snort, and the rest of the mainstream set; unlike the
 * `#bolt11` filter (which most relays reject as unindexed) we don't
 * need a fallback path.
 *
 * `limit` caps the backfill (newest first) so a cache with a huge zap
 * history can't stream all of it into the client to be decoded one bolt11
 * at a time (#1789). No `since`: the row totals are all-time sums, so a time
 * window would under-count them.
 *
 * Known limitation: this is ONE limit shared by every log id in the filter,
 * and relays clamp it to their own `max_limit` (damus and nos.lol advertise
 * 500). On a Piglet whose recent logs carry hundreds of zaps, older logs'
 * receipts can fall outside the window and show 0 sats. Not paged here.
 */
export const FIND_LOG_ZAP_LIMIT = 1000;

export const subscribeFindLogZaps = (
  logAuthors: ReadonlyMap<string, string>,
  onZap: (zap: FindLogZap) => void,
  relays: string[] = enabledAppRelays('default', DEFAULT_RELAYS),
  resolveProvider: (pubkey: string) => Promise<string | null> = resolveZapProviderPubkey,
  limit: number = FIND_LOG_ZAP_LIMIT,
): (() => void) => {
  if (logAuthors.size === 0) return () => {};
  let closed = false;
  const filter: Filter = { kinds: [9735], '#e': [...logAuthors.keys()], limit };
  const sub = pool.subscribeMany(relays, filter, {
    onevent: (event: NostrEvent) => {
      const bolt11 = event.tags.find((t) => t[0] === 'bolt11')?.[1];
      if (!bolt11) return;
      const sats = parseBolt11Sats(bolt11);
      if (sats === null) return;
      // NIP-57: when a receipt zaps a specific event the `e` tag
      // carries that event id. We only emit when the tag matches one
      // of the ids the caller asked about — otherwise a stray receipt
      // referencing an unrelated event could leak into the totals.
      const eTag = event.tags.find((t) => t[0] === 'e')?.[1];
      const finder = eTag ? logAuthors.get(eTag) : undefined;
      if (!eTag || !finder) return;
      // Cheap check first: the receipt must be issued to the log's finder.
      if (event.tags.find((t) => t[0] === 'p')?.[1] !== finder) return;
      void resolveProvider(finder).then((provider) => {
        if (closed || !provider || !validateZapReceipt(event, [provider])) return;
        onZap({ receiptId: event.id, logId: eTag, sats });
      });
    },
  });
  return () => {
    closed = true;
    sub.close();
  };
};
