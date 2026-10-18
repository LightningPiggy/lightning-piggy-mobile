import { enabledAppRelays } from './appRelayPrefs';
import type { Event as NostrEvent, Filter } from 'nostr-tools';
import { decode as bolt11Decode } from 'light-bolt11-decoder';
import { DEFAULT_RELAYS, pool } from './nostrService';

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

/**
 * Subscribe to NIP-57 zap receipts (kind 9735) referencing any of the
 * given kind-7516 find-log ids via their `#e` tag. The callback fires
 * once per matched receipt; the caller is expected to dedupe by
 * `receiptId` because the same receipt can arrive from multiple
 * relays. Empty `logIds` short-circuits — relays choke on empty
 * filter arrays.
 *
 * `#e` is one of the NIP-01 base-indexed tags so this works on damus,
 * primal, relay.snort, and the rest of the mainstream set; unlike the
 * `#bolt11` filter (which most relays reject as unindexed) we don't
 * need a fallback path.
 */
export const subscribeFindLogZaps = (
  logIds: string[],
  onZap: (zap: FindLogZap) => void,
  relays: string[] = enabledAppRelays('default', DEFAULT_RELAYS),
): (() => void) => {
  if (logIds.length === 0) return () => {};
  const filter: Filter = { kinds: [9735], '#e': logIds };
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
      if (!eTag || !logIds.includes(eTag)) return;
      onZap({ receiptId: event.id, logId: eTag, sats });
    },
  });
  return () => sub.close();
};
