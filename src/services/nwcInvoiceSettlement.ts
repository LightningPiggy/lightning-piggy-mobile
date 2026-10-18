import { paymentHashFromBolt11 } from '../utils/bolt11';
import { matchesPaymentHash } from '../utils/paymentCompletion';

export interface InvoiceSettlement {
  /** null explicitly means history could not resolve an ambiguous lookup. */
  paid: boolean | null;
  invoice?: string;
  preimage?: string;
  /** Wallet settlement timestamp, in Unix seconds. */
  settledAt?: number;
}

export function hasInvoiceSettlementProof(
  proof: { settledAt?: number; preimage?: string },
  paymentHash: string,
): boolean {
  return (
    typeof proof.settledAt === 'number' &&
    Number.isSafeInteger(proof.settledAt) &&
    proof.settledAt > 0 &&
    matchesPaymentHash(proof.preimage, paymentHash)
  );
}

/** LNbits can label expired invoices settled and reuse their creation timestamp. */
export function needsInvoiceHistoryConfirmation(result: {
  state?: unknown;
  created_at?: unknown;
  settled_at?: unknown;
  expires_at?: unknown;
}): boolean {
  return (
    (result.state === undefined ||
      (result.settled_at !== undefined && result.settled_at === result.created_at)) &&
    !(
      typeof result.expires_at === 'number' &&
      Number.isSafeInteger(result.expires_at) &&
      Date.now() < result.expires_at * 1000
    )
  );
}

/** Fail closed on malformed, contradictory or unrelated wallet responses. */
export function parseInvoiceSettlement(
  value: unknown,
  paymentHash: string,
): InvoiceSettlement | null {
  return parseSettlement(value, paymentHash, false);
}

function parseSettlement(
  value: unknown,
  paymentHash: string,
  historyConfirmed: boolean,
): InvoiceSettlement | null {
  if (!value || typeof value !== 'object') return null;
  const result = value as Record<string, unknown>;
  if (result.error != null) return null;
  if (
    typeof result.payment_hash !== 'string' ||
    result.payment_hash.toLowerCase() !== paymentHash.toLowerCase()
  )
    return null;
  const invoice = typeof result.invoice === 'string' ? result.invoice : undefined;
  if (
    result.invoice !== undefined &&
    (!invoice || paymentHashFromBolt11(invoice)?.toLowerCase() !== paymentHash.toLowerCase())
  )
    return null;
  const proof = {
    settledAt: typeof result.settled_at === 'number' ? result.settled_at : undefined,
    preimage: typeof result.preimage === 'string' ? result.preimage : undefined,
  };
  // A preimage, timestamp and even settled state can describe an expired LNbits invoice.
  if (!historyConfirmed && needsInvoiceHistoryConfirmation(result)) return null;
  const paid =
    (result.state === 'settled' || result.state === undefined) &&
    hasInvoiceSettlementProof(proof, paymentHash);
  // Contradictory settlement claims are unknown, so they cannot authorize
  // replacing the invoice either.
  if (!paid && (result.state === 'settled' || result.settled_at)) return null;
  return paid ? { paid, invoice, ...proof } : { paid: false, invoice };
}

/** Confirm an ambiguous lookup against successful history of the same direction.
 * Absence from a bounded page cannot prove unpaid; keep replacement fail-closed. */
export function confirmListedInvoiceSettlement(
  lookup: unknown,
  transactions: unknown,
  paymentHash: string,
): InvoiceSettlement | null {
  if (!lookup || typeof lookup !== 'object' || !Array.isArray(transactions)) return null;
  const raw = lookup as Record<string, unknown>;
  if ((raw.type !== 'incoming' && raw.type !== 'outgoing') || raw.error != null) return null;
  if (raw.state !== undefined && raw.state !== 'settled') return null;
  for (const value of transactions) {
    if (!value || typeof value !== 'object') continue;
    const tx = value as Record<string, unknown>;
    if (tx.type !== raw.type || (tx.state !== undefined && tx.state !== 'settled')) continue;
    const listed = parseSettlement(
      { ...tx, preimage: tx.preimage ?? raw.preimage, state: 'settled' },
      paymentHash,
      true,
    );
    if (!listed?.paid) continue;
    // Validate lookup hash/invoice/proof as well, using the confirmed timestamp.
    return parseSettlement(
      { ...raw, state: 'settled', settled_at: listed.settledAt },
      paymentHash,
      true,
    );
  }
  return null;
}
