import { hasInvoiceSettlementProof } from './nwcInvoiceSettlement';
import { isSellerAccountForgotten } from './sellerEventStore';
// Per-account record of the invoices a seller sent for Gamma orders: which
// wallet made each one (so payment is checked on THAT wallet, not whichever
// is active), its payment hash, and when the wallet reported it paid.
// Device-local (AsyncStorage) — the payment request itself is in the
// encrypted DM store; this only adds what the wallet side needs.
import AsyncStorage from '@react-native-async-storage/async-storage';

export interface SellerInvoiceRecord {
  orderId: string;
  buyerPubkey: string;
  /** Wallet the invoice was created on. */
  walletId: string;
  paymentHash: string;
  bolt11: string;
  amountSats: number;
  sentAt: number;
  /** Original self-copy that this durable replacement supersedes. */
  replacesBolt11?: string;
  /** Version of the fail-closed wallet settlement verification. */
  settlementVersion?: number;
  /** Persisted before publishing; retries reuse this invoice until delivery completes. */
  deliveryPending?: boolean;
  /** When the wallet reported the invoice settled (ms). */
  paidAt?: number;
  /** Positive wallet proof retained with the local paid marker. */
  settledAt?: number;
  preimage?: string;
  /** When the `confirmed` status update went to the buyer (ms). */
  confirmedAt?: number;
}

const MAX_RECORDS = 300;
export const sellerInvoiceKey = (buyer: string, orderId: string) =>
  `${buyer.toLowerCase()}:${orderId}`;
const key = (pubkey: string) => `market-seller-invoices:${pubkey}`;
const listeners = new Set<() => void>();
let writeChain: Promise<unknown> = Promise.resolve();

function isRecord(v: unknown): v is SellerInvoiceRecord {
  const r = v as SellerInvoiceRecord;
  return (
    !!r &&
    typeof r.orderId === 'string' &&
    typeof r.buyerPubkey === 'string' &&
    /^[0-9a-f]{64}$/i.test(r.buyerPubkey) &&
    typeof r.walletId === 'string' &&
    typeof r.paymentHash === 'string' &&
    typeof r.bolt11 === 'string' &&
    Number.isSafeInteger(r.amountSats)
  );
}

async function readSellerInvoices(pubkey: string): Promise<{
  records: Record<string, SellerInvoiceRecord>;
  repaired: boolean;
}> {
  const raw = await AsyncStorage.getItem(key(pubkey));
  const parsed: unknown = raw ? JSON.parse(raw) : {};
  const out: Record<string, SellerInvoiceRecord> = {};
  let repaired = false;
  if (parsed && typeof parsed === 'object') {
    for (const value of Object.values(parsed as Record<string, unknown>)) {
      if (isRecord(value)) {
        const record = { ...value };
        if (
          record.paidAt &&
          (record.settlementVersion !== 2 || !hasInvoiceSettlementProof(record, record.paymentHash))
        ) {
          repaired = true;
          delete record.paidAt;
          delete record.confirmedAt;
          delete record.settledAt;
          delete record.preimage;
        }
        out[sellerInvoiceKey(record.buyerPubkey, record.orderId)] = record;
      }
    }
  }
  return { records: out, repaired };
}

/** Repair legacy false-paid records under the same lock as invoice writes. */
export function loadSellerInvoices(pubkey: string): Promise<Record<string, SellerInvoiceRecord>> {
  const run = writeChain.then(async () => {
    const { records, repaired } = await readSellerInvoices(pubkey);
    if (repaired && !isSellerAccountForgotten(pubkey))
      await AsyncStorage.setItem(key(pubkey), JSON.stringify(records));
    return records;
  });
  writeChain = run.catch(() => undefined);
  return run;
}

/** Serialised read-modify-write so concurrent cards can't clobber each other. */
function update(
  pubkey: string,
  mutate: (records: Record<string, SellerInvoiceRecord>) => void,
): Promise<void> {
  const run = writeChain.then(async () => {
    if (isSellerAccountForgotten(pubkey)) return;
    const { records } = await readSellerInvoices(pubkey);
    if (isSellerAccountForgotten(pubkey)) return;
    mutate(records);
    const sorted = Object.values(records).sort((a, b) => b.sentAt - a.sentAt);
    // Wallet bindings and retries must survive until settlement AND confirmation.
    const active = sorted.filter((r) => r.deliveryPending || !r.paidAt || !r.confirmedAt);
    if (active.length > MAX_RECORDS) throw new Error('Seller invoice capacity reached');
    const completed = sorted.filter((r) => !r.deliveryPending && r.paidAt && r.confirmedAt);
    const kept = [...active, ...completed.slice(0, MAX_RECORDS - active.length)];
    await AsyncStorage.setItem(
      key(pubkey),
      JSON.stringify(
        Object.fromEntries(kept.map((r) => [sellerInvoiceKey(r.buyerPubkey, r.orderId), r])),
      ),
    );
  });
  writeChain = run.catch(() => undefined);
  return run.then(() => listeners.forEach((listener) => listener()));
}

/** Persist a validated invoice before delivery (replaces an earlier one for the order). */
export function recordSellerInvoice(pubkey: string, record: SellerInvoiceRecord): Promise<void> {
  return update(pubkey, (records) => {
    records[sellerInvoiceKey(record.buyerPubkey, record.orderId)] = record;
  });
}

export function patchSellerInvoice(
  pubkey: string,
  orderId: string,
  buyerPubkey: string,
  patch: Partial<
    Pick<
      SellerInvoiceRecord,
      'paidAt' | 'settledAt' | 'preimage' | 'confirmedAt' | 'deliveryPending' | 'settlementVersion'
    >
  >,
): Promise<void> {
  return update(pubkey, (records) => {
    const id = sellerInvoiceKey(buyerPubkey, orderId);
    const existing = records[id];
    if (existing) records[id] = { ...existing, ...patch };
  });
}

export function subscribeSellerInvoices(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export async function drainSellerInvoiceWrites(): Promise<void> {
  await writeChain;
}
