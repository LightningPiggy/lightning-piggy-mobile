import type { MutableRefObject } from 'react';
import * as walletStorage from '../services/walletStorageService';
import type { WalletState, WalletTransaction } from '../types/wallet';
import { perfLog, perfOwnerTag } from '../utils/perfLog';
import { hydrateWalletStates } from './hydrateWalletStates';

/** Cached wallets read for the hinted owner before auto-login confirmed it. */
export interface WalletPrefetch {
  owner: string;
  result: Promise<{
    listJson: string;
    states: WalletState[];
    fingerprints: Map<string, string>;
  } | null>;
}

const skipReceiptSeeding = async () => {};

/**
 * Read the hinted account's wallet list and per-wallet caches (the costly
 * part of hydration: tx cache read + JSON.parse, #606) while NostrContext is
 * still reading SecureStore. Strictly read-only, because the hint may name
 * another account: a corrupt tx cache fails the prefetch rather than being
 * deleted here (the confirmed owner's hydration then runs and clears it), and
 * the tx fingerprints and announced-receipt seeding are applied only if
 * `takeWalletPrefetch` accepts the result for the confirmed owner.
 */
export function prefetchWalletStates(owner: string): WalletPrefetch {
  const result = (async () => {
    const list = await walletStorage.getWalletList(owner);
    const fingerprints = { current: new Map<string, string>() };
    const states = await hydrateWalletStates(list, fingerprints, skipReceiptSeeding, () => true, {
      readOnly: true,
    });
    return { listJson: JSON.stringify(list), states, fingerprints: fingerprints.current };
  })().catch(() => null);
  return { owner, result };
}

/**
 * The prefetched wallet states, or null to hydrate from scratch. Accepted
 * only when the confirmed owner is the hinted one AND the owner's wallet list
 * is unchanged since the prefetch (legacy/per-account migrations may have
 * rewritten it) — so another account's wallets can never be committed.
 */
export async function takeWalletPrefetch(
  prefetch: WalletPrefetch | null,
  owner: string | null,
  walletList: readonly unknown[],
  lastTxsJsonRef: MutableRefObject<Map<string, string>>,
  hydrateSeenReceipts: (
    id: string,
    txs: readonly WalletTransaction[],
    isCurrent: () => boolean,
  ) => Promise<void>,
  isCurrent: () => boolean,
): Promise<WalletState[] | null> {
  if (!prefetch) return null;
  if (prefetch.owner !== owner) {
    perfLog(
      `wallet owner hint mismatch hint=${perfOwnerTag(prefetch.owner)} owner=${perfOwnerTag(owner)}: prefetch discarded`,
    );
    return null;
  }
  const prefetched = await prefetch.result;
  if (!prefetched || prefetched.listJson !== JSON.stringify(walletList)) {
    perfLog('wallet prefetch stale (list changed or read failed): hydrating again');
    return null;
  }
  if (!isCurrent()) return null;
  for (const [id, json] of prefetched.fingerprints) lastTxsJsonRef.current.set(id, json);
  await Promise.all(
    prefetched.states.map((w) => hydrateSeenReceipts(w.id, w.transactions, isCurrent)),
  );
  return prefetched.states;
}
