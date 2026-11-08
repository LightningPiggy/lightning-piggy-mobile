// Failed-lookup LRU for NWC `lookup_invoice`, extracted from nwcService
// (#1768) so the service stays under the file-size cap. One concern:
// remembering payment hashes the backend has terminally refused.

// Per-session cache of payment hashes the NWC backend has *terminally*
// refused (e.g. NIP-47 NOT_FOUND, or the SDK's "Missing/invalid
// payment_hash" input rejection). Skipping these on subsequent calls
// avoids flooding the Metro log every refresh and burning NWC request
// budget (#98). Transient errors (relay disconnects, timeouts,
// INTERNAL / RATE_LIMITED) are intentionally NOT cached so paid-status
// polling (ConversationScreen) and expectPayment detection
// (WalletContext) still settle when conditions recover.
// Per-wallet bounded LRU. Without a cap the cache grows monotonically
// for the JS-runtime lifetime — one user opening many tx-detail
// sheets, or a noisy backend returning many distinct terminal misses,
// could leak unbounded memory and permanently suppress lookups for
// those hashes until app restart. Per-wallet cap keeps total worst-
// case memory bounded by N_wallets × FAILED_LOOKUP_CAP entries.
const FAILED_LOOKUP_CAP = 500;
// Map iteration order is insertion order in JS, so we evict the
// oldest entry by deleting + re-inserting on access (LRU touch).
const failedLookupCache = new Map<string, Map<string, true>>();

export function hasFailedLookup(walletId: string, paymentHash: string): boolean {
  const cache = failedLookupCache.get(walletId);
  if (!cache) return false;
  if (!cache.has(paymentHash)) return false;
  // LRU touch: re-insert so this entry moves to the tail.
  cache.delete(paymentHash);
  cache.set(paymentHash, true);
  return true;
}

export function recordFailedLookup(walletId: string, paymentHash: string): void {
  let cache = failedLookupCache.get(walletId);
  if (!cache) {
    cache = new Map();
    failedLookupCache.set(walletId, cache);
  }
  // If already present, refresh its position (LRU touch).
  if (cache.has(paymentHash)) cache.delete(paymentHash);
  cache.set(paymentHash, true);
  // Evict oldest while over cap. Map.keys() yields in insertion order
  // so the first key is the oldest.
  while (cache.size > FAILED_LOOKUP_CAP) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Drop the cache entry for a wallet — call from disconnect / wallet
 * removal so cache memory follows wallet lifecycle. */
export function clearFailedLookupCache(walletId: string): void {
  failedLookupCache.delete(walletId);
}

// Errors that mean "this hash isn't coming back from this backend".
// Anything else is treated as transient — caching transient failures
// would permanently silence valid paid-status polling once a single
// relay timeout slipped through.
export function isTerminalLookupError(error: unknown): boolean {
  if (!error) return false;
  const message = error instanceof Error ? error.message : String(error);
  if (/missing payment_hash|invalid payment_hash|not[ _]?found/i.test(message)) {
    return true;
  }
  // NIP-47 error responses surface a `code` on the thrown error object.
  const code = (error as { code?: unknown })?.code;
  if (typeof code === 'string' && code.toUpperCase() === 'NOT_FOUND') {
    return true;
  }
  return false;
}
