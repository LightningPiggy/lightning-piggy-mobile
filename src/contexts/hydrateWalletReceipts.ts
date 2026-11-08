import { useCallback, useRef } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { settledIncomingHashes } from '../utils/incomingReceipts';
import type { WalletTransaction } from '../types/wallet';

/** Gate the actual receipt mutation after I/O, not just its caller. */
export async function hydrateWalletReceipts(
  walletId: string,
  cachedTxs: readonly WalletTransaction[],
  seed: (id: string, hashes: Set<string>, persist?: boolean) => void,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  try {
    const raw = await AsyncStorage.getItem(`seenReceipts_${walletId}`);
    if (!isCurrent()) return;
    if (raw) seed(walletId, new Set<string>(JSON.parse(raw) as string[]), false);
    else seed(walletId, settledIncomingHashes(cachedTxs));
  } catch {
    if (isCurrent()) seed(walletId, settledIncomingHashes(cachedTxs));
  }
}

// Persist a wallet's announced-receipt hashes so a payment is announced once,
// EVER — not once per JS session. The in-memory set resets on every cold start
// / Metro re-eval, and the tx cache it seeds from can be stale (missing a
// just-arrived receive), so without this a payment re-announced on reload (#653).
export function persistSeenReceipts(walletId: string, seen: ReadonlySet<string>): void {
  AsyncStorage.setItem(`seenReceipts_${walletId}`, JSON.stringify([...seen])).catch(() => {});
}

/**
 * Per-wallet set of settled-incoming payment_hashes already announced.
 * Receives are detected by transaction identity (hash), not balance-diffing,
 * so a flapping/stale balance can't re-announce the same payment (#653).
 * Seeded silently from existing history on first sight (no launch re-announce).
 */
export function useSeenReceipts() {
  const seenReceiptsRef = useRef<Map<string, Set<string>>>(new Map());
  // Record a wallet's announced-receipt baseline in memory and (optionally) on
  // disk — shared by the launch-hydration, identity-switch, and first-fetch
  // baseline sites. `persist` is false only when the set was just read back
  // from disk (no need to re-write).
  const seedSeenReceipts = useCallback(
    (walletId: string, seeded: Set<string>, persist = true): void => {
      seenReceiptsRef.current.set(walletId, seeded);
      if (persist) persistSeenReceipts(walletId, seeded);
    },
    [],
  );
  // Seed a wallet's announced-receipts set BEFORE the detector runs, on launch
  // hydration / identity switch: prefer the persisted set, else baseline from
  // cached history (a corrupt persisted value falls back to a fresh baseline).
  // The in-memory set alone reset on every JS re-eval and re-announced a payment
  // whose hash wasn't in the (possibly stale) tx cache (#653 follow-up).
  const hydrateSeenReceipts = useCallback(
    (walletId: string, cachedTxs: readonly WalletTransaction[], isCurrent?: () => boolean) =>
      hydrateWalletReceipts(walletId, cachedTxs, seedSeenReceipts, isCurrent),
    [seedSeenReceipts],
  );
  return { seenReceiptsRef, seedSeenReceipts, hydrateSeenReceipts };
}
