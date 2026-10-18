// AsyncStorage-backed cache of bolt11 invoice settlement status, keyed
// by payment hash. Mirrors the shape of zapCounterpartyStorage.
//
// Why persist this rather than re-polling lookupInvoice on every mount?
// Settled is a terminal state — once an invoice is paid it can't flip
// back, so caching the positive result lets cold starts render the
// "Paid" badge immediately without an NWC round-trip.
//
// Negative (`settled: false`) entries are still recorded with a TTL,
// for two reasons: (1) future poll-suppression (read paths could
// short-circuit re-polling within the TTL window — `get()` already
// returns them) and (2) bookkeeping for debug. Today's only consumer,
// `usePaidInvoiceTracker.ts`, hydrates *settled-only* via `getMany`;
// the negatives sit unused in storage. Wire them into the polling
// decision when the perf cost of re-polling matters; not yet.
import AsyncStorage from '@react-native-async-storage/async-storage';

// v1 positives could originate from LNbits expired-invoice lookup responses.
// Re-poll through the verified settlement path instead of retaining those badges.
const STORAGE_KEY = 'bolt11_settlement_v2';
// Cap on entries — invoices are short-lived so we don't need a deep
// history. LRU-evict by checkedAt once we're over the cap.
const MAX_ENTRIES = 1000;
// How long an unsettled (`settled: false`) lookup is trusted before the
// caller should re-poll. Settled entries are honoured indefinitely
// (terminal state). 24 h is generous enough that a user re-opening the
// same conversation within a day doesn't trigger re-lookups for
// invoices that were unpaid yesterday and have likely expired.
const UNSETTLED_TTL_MS = 24 * 60 * 60 * 1000;

export interface SettlementEntry {
  settled: boolean;
  checkedAt: number;
}

type CacheShape = Record<string, SettlementEntry>;

let memoryCache: CacheShape | null = null;
// Concurrent callers (e.g. several `record()` fired in quick succession
// while memoryCache is still null) would each await AsyncStorage and
// race to assign `memoryCache` — a later resolver could overwrite an
// already-mutated cache and effectively drop earlier writes until the
// next persist. Memoise the in-flight load so all racers wait on the
// same promise.
let loadPromise: Promise<CacheShape> | null = null;

async function load(): Promise<CacheShape> {
  if (memoryCache) return memoryCache;
  if (loadPromise) return loadPromise;
  loadPromise = (async () => {
    try {
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      memoryCache = raw ? (JSON.parse(raw) as CacheShape) : {};
    } catch {
      memoryCache = {};
    }
    return memoryCache;
  })();
  try {
    return await loadPromise;
  } finally {
    loadPromise = null;
  }
}

async function persist(cache: CacheShape): Promise<void> {
  try {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // Storage failure is non-fatal — we just miss the cached settlement
    // on next app launch and re-poll lookupInvoice. Don't bubble.
  }
}

// Record a fresh settlement result. Once an entry is `settled: true`
// further `record(..., false)` calls are ignored — terminal state wins.
export async function record(paymentHash: string, settled: boolean): Promise<void> {
  if (!paymentHash) return;
  const cache = await load();
  const existing = cache[paymentHash];
  if (existing?.settled && !settled) return;
  cache[paymentHash] = { settled, checkedAt: Date.now() };

  const keys = Object.keys(cache);
  if (keys.length > MAX_ENTRIES) {
    const sorted = keys.map((k) => [k, cache[k].checkedAt] as const).sort((a, b) => a[1] - b[1]);
    const drop = sorted.slice(0, keys.length - MAX_ENTRIES);
    for (const [k] of drop) delete cache[k];
  }

  await persist(cache);
}

// Look up a single payment hash. Returns:
//  - `{ settled: true, checkedAt }` for known-settled (always honoured)
//  - `{ settled: false, checkedAt }` for unsettled within TTL
//  - `null` for absent or stale-unsettled (caller should re-poll)
export async function get(paymentHash: string): Promise<SettlementEntry | null> {
  if (!paymentHash) return null;
  const cache = await load();
  const entry = cache[paymentHash];
  if (!entry) return null;
  if (entry.settled) return entry;
  if (Date.now() - entry.checkedAt > UNSETTLED_TTL_MS) return null;
  return entry;
}

// Bulk read — used by ConversationScreen to hydrate the paidHashes set
// on mount before the NWC poll has run its first round. Stale unsettled
// entries are filtered out so the caller re-polls them.
export async function getMany(paymentHashes: string[]): Promise<Map<string, SettlementEntry>> {
  const out = new Map<string, SettlementEntry>();
  if (paymentHashes.length === 0) return out;
  const cache = await load();
  const now = Date.now();
  for (const h of paymentHashes) {
    const entry = cache[h];
    if (!entry) continue;
    if (!entry.settled && now - entry.checkedAt > UNSETTLED_TTL_MS) continue;
    out.set(h, entry);
  }
  return out;
}

// Test-only: wipe the in-memory cache so reloads re-read from storage.
export function __resetForTests(): void {
  memoryCache = null;
}
