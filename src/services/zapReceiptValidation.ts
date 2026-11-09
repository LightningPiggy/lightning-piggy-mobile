import { decode as bolt11Decode } from 'light-bolt11-decoder';
import type { Event as NostrEvent } from 'nostr-tools/pure';
import { verifyEventCached } from './nostrVerifyCache';

/**
 * NIP-57 Appendix F receipt validation (#1780).
 *
 * Anyone can publish a kind-9735 that `p`-tags a user and embeds a made-up
 * zap request naming a trusted contact. A receipt only proves who paid when:
 *  - its author is the recipient LNURL server's `nostrPubkey` (the receipt's
 *    own signature is already checked by `pool.verifyEvent`, which fully
 *    verifies kind 9735 on ingest);
 *  - the embedded `description` is a validly signed kind-9734 zap request
 *    that targets the same recipient (and the same event, when scoped);
 *  - the amounts agree: a zap request `amount` must equal the invoice amount.
 *
 * Callers must match a receipt to a payment first and validate only that
 * one — the 9734 signature check is the only crypto here, and it goes
 * through the shared verified-event cache.
 */

/** The fields of a kind-9735 event this module reads. */
export interface ZapReceiptEvent {
  pubkey?: string;
  tags: string[][];
}

export interface ValidatedZap {
  /** Zap request author, or null for an anonymous zap. */
  senderPubkey: string | null;
  comment: string;
  anonymous: boolean;
  /** Amount from the receipt's invoice (or the zap request when the invoice has none). */
  amountMsats: number | null;
}

const tagValue = (tags: unknown, name: string): string | undefined => {
  if (!Array.isArray(tags)) return undefined;
  const tag = tags.find((t) => Array.isArray(t) && t[0] === name);
  return typeof tag?.[1] === 'string' ? tag[1] : undefined;
};

/** Millisatoshi amount of a bolt11 invoice; null when amount-less or unparseable. */
export function bolt11AmountMsats(bolt11: string): number | null {
  try {
    const decoded = bolt11Decode(bolt11) as { sections: { name: string; value?: unknown }[] };
    const raw = decoded.sections.find((s) => s.name === 'amount')?.value;
    const msats = Number(raw);
    return raw !== undefined && Number.isSafeInteger(msats) && msats > 0 ? msats : null;
  } catch {
    return null;
  }
}

/**
 * Validate a matched zap receipt. Returns the sender + comment only when the
 * receipt passes every NIP-57 check against one of `providerPubkeys`; null
 * otherwise. An empty provider list (unknown / unreachable LNURL server)
 * always fails: an unverifiable sender is never shown as a verified one.
 *
 * `expectedAmountMsats`, when given, must equal the receipt's amount — used
 * when the receipt was paired with a payment by amount rather than bolt11.
 */
export function validateZapReceipt(
  receipt: ZapReceiptEvent,
  providerPubkeys: Iterable<string>,
  opts: { expectedAmountMsats?: number } = {},
): ValidatedZap | null {
  const author = receipt.pubkey?.toLowerCase();
  if (!author) return null;
  let trusted = false;
  for (const pk of providerPubkeys) if (pk && pk.toLowerCase() === author) trusted = true;
  if (!trusted) return null;

  const description = tagValue(receipt.tags, 'description');
  if (!description) return null;
  let request: NostrEvent;
  try {
    request = JSON.parse(description) as NostrEvent;
  } catch {
    return null;
  }
  if (!request || typeof request !== 'object' || request.kind !== 9734) return null;
  if (!Array.isArray(request.tags)) return null;

  // Exactly one recipient, and it is the one the receipt was issued to.
  const requestP = request.tags.filter((t) => Array.isArray(t) && t[0] === 'p');
  const receiptP = tagValue(receipt.tags, 'p');
  if (requestP.length !== 1 || !receiptP || requestP[0][1] !== receiptP) return null;
  // A receipt scoped to an event must come from a request scoped to it.
  const receiptE = tagValue(receipt.tags, 'e');
  if (receiptE !== undefined && tagValue(request.tags, 'e') !== receiptE) return null;

  const bolt11 = tagValue(receipt.tags, 'bolt11');
  const invoiceMsats = bolt11 ? bolt11AmountMsats(bolt11) : null;
  const requestAmount = tagValue(request.tags, 'amount');
  let requestMsats: number | null = null;
  if (requestAmount !== undefined) {
    requestMsats = Number(requestAmount);
    if (!Number.isSafeInteger(requestMsats) || requestMsats <= 0) return null;
    if (invoiceMsats !== null && invoiceMsats !== requestMsats) return null;
  }
  const amountMsats = invoiceMsats ?? requestMsats;
  if (opts.expectedAmountMsats !== undefined && amountMsats !== opts.expectedAmountMsats) {
    return null;
  }

  // Signature last: only receipts that passed every cheap check pay for it.
  if (!verifyEventCached(request)) return null;

  const anonymous = request.tags.some((t) => Array.isArray(t) && t[0] === 'anon');
  return {
    senderPubkey: anonymous ? null : request.pubkey,
    comment: typeof request.content === 'string' ? request.content : '',
    anonymous,
    amountMsats,
  };
}
