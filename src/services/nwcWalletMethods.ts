// In-memory cache of each NWC wallet's granted NIP-47 methods (`get_info`),
// so the seller's invoice-wallet pickers can tell "can make invoices" from
// "pay-only connection" without asking the wallet on every render. A failed
// lookup is NOT cached as "no": it stays unknown and can be retried.
import { getWalletMethods } from './nwcService';

const methodsByWallet = new Map<string, readonly string[]>();
const inFlight = new Map<string, Promise<readonly string[] | null>>();
const listeners = new Set<() => void>();

/** Cached methods for `walletId`, or undefined when not (successfully) asked yet. */
export function cachedWalletMethods(walletId: string): readonly string[] | undefined {
  return methodsByWallet.get(walletId);
}

/** Ask the wallet once (concurrent callers share the request). */
export function fetchWalletMethods(walletId: string): Promise<readonly string[] | null> {
  const pending = inFlight.get(walletId);
  if (pending) return pending;
  const request = getWalletMethods(walletId)
    .then((methods) => {
      if (methods) {
        methodsByWallet.set(walletId, methods);
        listeners.forEach((listener) => listener());
      }
      return methods;
    })
    .catch(() => null)
    .finally(() => inFlight.delete(walletId));
  inFlight.set(walletId, request);
  return request;
}

/** Drop a wallet's cached methods (removed / reconnected wallet). */
export function forgetWalletMethods(walletId: string): void {
  if (methodsByWallet.delete(walletId)) listeners.forEach((listener) => listener());
}

export function subscribeWalletMethods(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Test-only reset. */
export function __resetWalletMethodsForTests(): void {
  methodsByWallet.clear();
  inFlight.clear();
}
