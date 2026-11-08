import AsyncStorage from '@react-native-async-storage/async-storage';
import type { MutableRefObject } from 'react';
import type { WalletMetadata, WalletState, WalletTransaction } from '../types/wallet';
import { readCachedWalletBalance } from '../services/walletBalanceCache';
import { perfLog, perfOwnerTag } from '../utils/perfLog';

export type WalletHydrationSource = 'startup' | 'startup-prefetch' | 'account-change';
let hydrationCount = 0;
/** [Perf] marker per committed wallet-list hydration; cold start should log #1 only. */
export function logWalletHydration(
  source: WalletHydrationSource,
  owner: string | null,
  wallets: number,
): void {
  hydrationCount += 1;
  perfLog(
    `wallet hydration #${hydrationCount} source=${source} owner=${perfOwnerTag(owner)} wallets=${wallets}`,
  );
}

/** Hydrate cached wallet data without initialising BDK or connecting to relays. */
export async function hydrateWalletStates(
  walletList: WalletMetadata[],
  lastTxsJsonRef: MutableRefObject<Map<string, string>>,
  hydrateSeenReceipts: (
    id: string,
    txs: readonly WalletTransaction[],
    isCurrent: () => boolean,
  ) => Promise<void>,
  isCurrent: () => boolean,
): Promise<WalletState[]> {
  return Promise.all(
    walletList.map(async (w) => {
      // Load cached transactions from AsyncStorage
      let cachedTxs: WalletTransaction[] = [];
      try {
        const tTxRead = Date.now();
        const txJson = await AsyncStorage.getItem(`txs_${w.id}`);
        perfLog(
          `WalletProvider: txs_${w.id.slice(0, 8)} read ${Date.now() - tTxRead}ms (${txJson?.length ?? 0}B)`,
        );
        if (txJson) {
          const tTxParse = Date.now();
          cachedTxs = JSON.parse(txJson);
          // Seed the unchanged-poll fingerprint from the persisted JSON
          // so the first poll after cold start can skip too when the
          // server list matches what we hydrated (#1014).
          if (isCurrent()) lastTxsJsonRef.current.set(w.id, txJson);
          perfLog(
            `WalletProvider: txs_${w.id.slice(0, 8)} parse ${Date.now() - tTxParse}ms (${cachedTxs.length} txs)`,
          );
        }
      } catch (err) {
        console.warn(`Corrupted cached txs for ${w.id}, clearing:`, err);
        await AsyncStorage.removeItem(`txs_${w.id}`);
      }
      // Hydrate cached balance from disk so the wallet card shows
      // a number on cold start instead of `---` while we hold off
      // the BDK `Wallet.create() + Electrum.sync()` work (~9 s of
      // JS-thread time per onchain wallet) until the user actually
      // asks for fresh data (pull-to-refresh, open wallet detail,
      // open Send sheet for that wallet). Closes the cold-start
      // "Send button feels frozen for 12 s" symptom: BDK is the
      // dominant blocker, and BDK isn't needed to paint Home.
      const cachedBalance = await readCachedWalletBalance(w.id);
      // Seed the announced-receipts set BEFORE the detector runs.
      await hydrateSeenReceipts(w.id, cachedTxs, isCurrent);
      return {
        ...w,
        isConnected: false,
        balance: cachedBalance,
        walletAlias: null,
        transactions: cachedTxs,
      };
    }),
  );
}
