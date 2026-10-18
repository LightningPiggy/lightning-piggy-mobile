import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useWallet } from '../contexts/WalletContext';
import * as nwcService from '../services/nwcService';
import * as bolt11SettlementCache from '../services/bolt11SettlementCache';
import { extractInvoice } from '../utils/messageContent';

export interface TrackedMessage {
  text: string;
  fromMe: boolean;
  createdAt: number;
}

const POLL_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Base cadence for the issuer-side lookupInvoice poll. A chat invoice tile
// doesn't need sub-30 s freshness; the old 15 s fixed retry hammered our
// own NWC relay hard enough to get the IP temp-banned (#684).
const POLL_INTERVAL_MS = 30_000;
// Backoff ceiling when the relay stops answering (unreachable / temp-
// banned / slow). The delay doubles 30 s → 60 s → … → 5 min so we stop
// hammering a relay that isn't responding — which is what kept the ban
// alive and janked the UI — and recover to the base cadence the moment it
// answers again.
const POLL_BACKOFF_MAX_MS = 5 * 60 * 1000;

// Tracks bolt11 settlement state across all three sources, for both
// the issuer (`fromMe: true`) and the payer (`fromMe: false`):
//
//   1. Wallet tx history — incoming tx with matching payment_hash means
//      an invoice we issued got paid; outgoing tx with matching hash
//      means an invoice we received got paid by us.
//   2. NWC `lookupInvoice` poll — fast issuer-side fallback (15 s) for
//      cases where the wallet tx-sync hasn't caught up yet.
//   3. Persistent settlement cache — survives cold start; populated
//      from sources (1) and (2) so re-opening a thread renders Paid
//      immediately without waiting for either to re-run.
//
// Used by both 1:1 ConversationScreen and GroupConversationScreen so
// payer + receiver see "Paid" symmetrically.
export function usePaidInvoiceTracker(messages: TrackedMessage[]): {
  isInvoicePaid: (paymentHash: string, fromMe: boolean) => boolean;
} {
  const { wallets, activeWalletId, activeWallet } = useWallet();
  const [paidHashes, setPaidHashes] = useState<Set<string>>(() => new Set());

  // Hashes settled per wallet-tx history (both directions).
  const { paidOutgoingHashes, paidIncomingHashes } = useMemo(() => {
    const out = new Set<string>();
    const inc = new Set<string>();
    for (const w of wallets) {
      for (const tx of w.transactions) {
        if (!tx.paymentHash) continue;
        if (tx.type === 'incoming') out.add(tx.paymentHash);
        else if (tx.type === 'outgoing') inc.add(tx.paymentHash);
      }
    }
    return { paidOutgoingHashes: out, paidIncomingHashes: inc };
  }, [wallets]);

  // Persist any wallet-tx-derived hashes so they survive cold starts.
  // Settled is terminal — fire-and-forget the write; failures are
  // recoverable on the next sync.
  const persistedHashesRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const fresh: string[] = [];
    for (const h of paidOutgoingHashes) if (!persistedHashesRef.current.has(h)) fresh.push(h);
    for (const h of paidIncomingHashes) if (!persistedHashesRef.current.has(h)) fresh.push(h);
    if (fresh.length === 0) return;
    for (const h of fresh) {
      persistedHashesRef.current.add(h);
      bolt11SettlementCache.record(h, true).catch(() => {});
    }
  }, [paidOutgoingHashes, paidIncomingHashes]);

  // Invoices we issued that are still plausibly payable — the poll
  // targets. We don't poll for incoming invoices: NIP-47 lookupInvoice
  // semantics are about invoices *this* wallet generated, so a payer
  // looking up someone else's hash will get a not-found response from
  // most NWC implementations. Wallet tx sync covers the payer side.
  const outgoingOpenHashes = useMemo(() => {
    const now = Date.now();
    const cutoff = now - POLL_MAX_AGE_MS;
    const hashes: string[] = [];
    for (const m of messages) {
      if (!m.fromMe) continue;
      if (m.createdAt * 1000 < cutoff) continue;
      const inv = extractInvoice(m.text);
      if (!inv?.paymentHash) continue;
      if (paidOutgoingHashes.has(inv.paymentHash)) continue;
      if (paidHashes.has(inv.paymentHash)) continue;
      if (inv.expiresAt !== null && inv.expiresAt * 1000 < now) continue;
      hashes.push(inv.paymentHash);
    }
    return hashes;
  }, [messages, paidOutgoingHashes, paidHashes]);

  useEffect(() => {
    if (!activeWalletId || activeWallet?.walletType === 'onchain') return;
    if (outgoingOpenHashes.length === 0) return;
    let cancelled = false;
    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    let running = false;
    // Current backoff delay — grows when the relay isn't answering and
    // resets to the base cadence as soon as it responds again (#684).
    let delay = POLL_INTERVAL_MS;
    const poll = async () => {
      let gotResult = false;
      for (const hash of outgoingOpenHashes) {
        if (cancelled) return;
        let result: Awaited<ReturnType<typeof nwcService.lookupInvoice>> = null;
        try {
          result = await nwcService.lookupInvoice(activeWalletId, hash);
        } catch (e) {
          // Timeout / temp-ban / transport error — including a throw
          // before lookupInvoice's own logging (e.g. ensureConnected
          // failing during a reconnect). Treat as "no answer" so the
          // backoff engages instead of a tight retry storm; log in dev so
          // an unexpected throw stays diagnosable (#686 review).
          if (__DEV__)
            console.log(`[invoice-poll] lookupInvoice threw: ${(e as Error)?.message ?? e}`);
          result = null;
        }
        if (cancelled) return;
        if (result && result.paid !== null) {
          gotResult = true;
          if (result.paid) {
            setPaidHashes((prev) => {
              if (prev.has(hash)) return prev;
              const next = new Set(prev);
              next.add(hash);
              return next;
            });
            bolt11SettlementCache.record(hash, true).catch(() => {});
          } else {
            bolt11SettlementCache.record(hash, false).catch(() => {});
          }
        }
      }
      // Got at least one non-null lookupInvoice result (paid or unpaid) →
      // the relay is answering, so stay at the base cadence. Got nothing
      // back from any hash (every call timed out / threw / returned null —
      // i.e. unreachable or temp-banned) → double up to the ceiling so we
      // stop hammering it. Note: a terminal NOT_FOUND that surfaces as null
      // also counts as "no answer" here, which is fine — there's no point
      // fast-polling a hash the relay can't find either.
      delay = gotResult ? POLL_INTERVAL_MS : Math.min(delay * 2, POLL_BACKOFF_MAX_MS);
    };
    const scheduleNext = () => {
      if (cancelled || !running) return;
      timeoutId = setTimeout(async () => {
        await poll();
        scheduleNext();
      }, delay);
    };
    const start = () => {
      if (running) return;
      running = true;
      delay = POLL_INTERVAL_MS;
      // Immediate first check, then self-reschedule on the (possibly
      // backed-off) delay. setTimeout, not setInterval, so the cadence can
      // stretch when the relay goes quiet.
      poll().then(scheduleNext);
    };
    const stop = () => {
      running = false;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
    };
    if (AppState.currentState === 'active') start();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') start();
      else stop();
    });
    return () => {
      cancelled = true;
      stop();
      sub.remove();
    };
  }, [activeWalletId, activeWallet?.walletType, outgoingOpenHashes]);

  // Cold-start hydration from the persistent cache. Settled is terminal
  // so we only ever add hashes here, never remove them.
  useEffect(() => {
    let cancelled = false;
    const hashes: string[] = [];
    for (const m of messages) {
      const inv = extractInvoice(m.text);
      if (inv?.paymentHash) hashes.push(inv.paymentHash);
    }
    if (hashes.length === 0) return;
    bolt11SettlementCache
      .getMany(hashes)
      .then((entries) => {
        if (cancelled) return;
        const settled: string[] = [];
        for (const [h, e] of entries) if (e.settled) settled.push(h);
        if (settled.length === 0) return;
        setPaidHashes((prev) => {
          let mutated = false;
          const next = new Set(prev);
          for (const h of settled) {
            if (!next.has(h)) {
              next.add(h);
              mutated = true;
            }
          }
          return mutated ? next : prev;
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [messages]);

  // Both branches consult `paidHashes` so cold-start hydration covers
  // the payer too — the cache stores hashes regardless of direction.
  const isInvoicePaid = useCallback(
    (paymentHash: string, fromMe: boolean): boolean => {
      if (paidHashes.has(paymentHash)) return true;
      if (fromMe) return paidOutgoingHashes.has(paymentHash);
      return paidIncomingHashes.has(paymentHash);
    },
    [paidOutgoingHashes, paidIncomingHashes, paidHashes],
  );

  return { isInvoicePaid };
}
