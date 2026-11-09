import type { WalletTransaction } from '../types/wallet';
import { paymentHashFromBolt11 } from '../utils/bolt11';
import { validateZapReceipt, type ZapReceiptEvent } from './zapReceiptValidation';

export interface IncomingZapMatch {
  tx: WalletTransaction;
  senderPubkey: string | null;
  comment: string;
  anonymous: boolean;
}

export interface IncomingZapMatchResult {
  matches: IncomingZapMatch[];
  /** Txs with a bolt11 and no valid receipt — a definitive miss to negative-cache. */
  misses: WalletTransaction[];
}

const TIME_WINDOW_S = 5 * 60;

const tagValue = (tags: string[][], name: string): string | undefined =>
  tags.find((t) => t[0] === name)?.[1];

/**
 * Pair incoming payments with NIP-57 zap receipts and keep only receipts
 * that validate against the wallet's LNURL server key (#1780).
 *
 * A receipt is pinned to a payment by the payment itself, never guessed:
 *  - a tx with a payment hash matches only a receipt whose invoice carries
 *    that hash (NIP-47 may omit `invoice`, but sends `payment_hash`);
 *  - a tx with only a bolt11 matches that exact invoice (case-insensitive);
 *  - an on-chain tx (`txid`) is never a zap and never matches;
 *  - only a legacy row with neither falls back to (amount, ±5 min).
 * Without the hash rule, a provider-signed receipt for someone else's
 * payment (e.g. a replayed old zap request paid to another address on the
 * same custodial server) could label an unrelated same-amount payment.
 *
 * Receipts by any other author are dropped before matching (a string
 * compare), and only the one receipt matched to each tx pays for checks.
 */
export function matchIncomingZapReceipts<R extends ZapReceiptEvent & { created_at: number }>(
  txs: readonly WalletTransaction[],
  receipts: readonly R[],
  providerPubkeys: readonly string[],
): IncomingZapMatchResult {
  const providers = new Set(providerPubkeys.filter(Boolean).map((pk) => pk.toLowerCase()));
  const trusted: R[] = [];
  // Invoices that only have receipts by OTHER authors. Such a payment may
  // still be a genuine zap through a different LNURL address paying into
  // this wallet, so it is left unresolved rather than recorded as a miss.
  const untrustedBolt11 = new Set<string>();
  const byBolt11 = new Map<string, R>();
  for (const r of receipts) {
    // BOLT11 is case-insensitive: compare invoices lower-cased.
    const bolt11 = tagValue(r.tags, 'bolt11')?.toLowerCase();
    if (r.pubkey && providers.has(r.pubkey.toLowerCase())) {
      trusted.push(r);
      if (bolt11) byBolt11.set(bolt11, r);
    } else if (bolt11) untrustedBolt11.add(bolt11);
  }

  // Decoded lazily, once per pass, and only for trusted receipts.
  const hashes = new Map<R, string | null>();
  const hashOf = (r: R): string | null => {
    if (!hashes.has(r)) {
      const bolt11 = tagValue(r.tags, 'bolt11');
      hashes.set(r, bolt11 ? (paymentHashFromBolt11(bolt11)?.toLowerCase() ?? null) : null);
    }
    return hashes.get(r) ?? null;
  };
  let byHash: Map<string, R> | null = null;
  const findByHash = (hash: string): R | null => {
    if (!byHash) {
      byHash = new Map();
      for (const r of trusted) {
        const h = hashOf(r);
        if (h) byHash.set(h, r);
      }
    }
    return byHash.get(hash) ?? null;
  };

  // The (amount, time) index is only needed for legacy rows.
  let byAmountTime: { amountSats: number; ts: number; receipt: R }[] | null = null;
  const amountIndex = () => {
    if (byAmountTime) return byAmountTime;
    byAmountTime = [];
    for (const r of trusted) {
      const description = tagValue(r.tags, 'description');
      if (!description) continue;
      try {
        const zr = JSON.parse(description) as { tags?: string[][] };
        const msats = parseInt(zr.tags?.find((t) => t[0] === 'amount')?.[1] ?? '', 10);
        if (Number.isFinite(msats)) {
          byAmountTime.push({ amountSats: Math.round(msats / 1000), ts: r.created_at, receipt: r });
        }
      } catch {}
    }
    return byAmountTime;
  };

  const findByAmountTime = (tx: WalletTransaction): R | null => {
    const txTs = tx.settled_at ?? tx.created_at ?? null;
    if (txTs == null) return null;
    const txSats = Math.abs(tx.amount);
    let best: { receipt: R; dt: number } | null = null;
    for (const entry of amountIndex()) {
      if (entry.amountSats !== txSats) continue;
      const dt = Math.abs(entry.ts - txTs);
      if (dt > TIME_WINDOW_S) continue;
      if (!best || dt < best.dt) best = { receipt: entry.receipt, dt };
    }
    return best?.receipt ?? null;
  };

  const findReceipt = (tx: WalletTransaction): R | null => {
    // An on-chain deposit is never a zap; it must not pair by amount + time.
    if (tx.txid) return null;
    const hash = tx.paymentHash?.toLowerCase();
    if (tx.bolt11) {
      const r = byBolt11.get(tx.bolt11.toLowerCase()) ?? null;
      return r && (!hash || hashOf(r) === hash) ? r : null;
    }
    if (hash) return findByHash(hash);
    return findByAmountTime(tx);
  };

  const result: IncomingZapMatchResult = { matches: [], misses: [] };
  for (const tx of txs) {
    const receipt = findReceipt(tx);
    const legacy = !tx.bolt11 && !tx.paymentHash;
    const zap = receipt
      ? validateZapReceipt(
          receipt,
          providers,
          // Invoice / hash matches pin the amount; an amount match must agree.
          legacy ? { expectedAmountMsats: Math.abs(tx.amount) * 1000 } : {},
        )
      : null;
    if (zap) {
      result.matches.push({
        tx,
        senderPubkey: zap.senderPubkey,
        comment: zap.comment,
        anonymous: zap.anonymous,
      });
    } else if (tx.bolt11 && (receipt || !untrustedBolt11.has(tx.bolt11.toLowerCase()))) {
      // Definitive miss: no receipt at all, or a trusted one that failed a
      // hard check (signature, recipient, amount). A receipt whose only
      // fault is its author leaves the tx unresolved (no sender shown).
      result.misses.push(tx);
    }
  }
  return result;
}
