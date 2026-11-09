import type { WalletTransaction } from '../types/wallet';
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
 * Primary match is the receipt's bolt11. A tx with no bolt11 (cached before
 * bolt11 capture) falls back to (amount, ±5 min) — never a tx that HAS a
 * bolt11, since a different invoice is by definition a different payment.
 * Receipts by any other author are dropped before matching (a string compare),
 * and only the one receipt matched to each tx pays for signature checks.
 */
export function matchIncomingZapReceipts<R extends ZapReceiptEvent & { created_at: number }>(
  txs: readonly WalletTransaction[],
  receipts: readonly R[],
  providerPubkeys: readonly string[],
): IncomingZapMatchResult {
  const providers = new Set(providerPubkeys.filter(Boolean).map((pk) => pk.toLowerCase()));
  const trusted = receipts.filter((r) => !!r.pubkey && providers.has(r.pubkey.toLowerCase()));

  const byBolt11 = new Map<string, R>();
  for (const r of trusted) {
    const bolt11 = tagValue(r.tags, 'bolt11');
    if (bolt11) byBolt11.set(bolt11, r);
  }

  // The (amount, time) index is only needed for bolt11-less txs.
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

  const result: IncomingZapMatchResult = { matches: [], misses: [] };
  for (const tx of txs) {
    const receipt = tx.bolt11 ? (byBolt11.get(tx.bolt11) ?? null) : findByAmountTime(tx);
    const zap = receipt
      ? validateZapReceipt(
          receipt,
          providers,
          // A bolt11 match already pins the amount; an amount match must agree.
          tx.bolt11 ? {} : { expectedAmountMsats: Math.abs(tx.amount) * 1000 },
        )
      : null;
    if (zap) {
      result.matches.push({
        tx,
        senderPubkey: zap.senderPubkey,
        comment: zap.comment,
        anonymous: zap.anonymous,
      });
    } else if (tx.bolt11) {
      // Negative cache only when we had a bolt11 to match with. Otherwise
      // leave it unresolved so a later refresh can retry.
      result.misses.push(tx);
    }
  }
  return result;
}
