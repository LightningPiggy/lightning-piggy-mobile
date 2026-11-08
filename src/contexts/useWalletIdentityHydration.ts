import {
  useCallback,
  useEffect,
  useRef,
  type Dispatch,
  type SetStateAction,
  type MutableRefObject,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as nwcService from '../services/nwcService';
import * as walletStorage from '../services/walletStorageService';
import type { WalletState, WalletTransaction } from '../types/wallet';
import { logWalletHydration } from './hydrateWalletStates';

interface WalletIdentityHydrationDeps {
  setLastIncomingPayment?: (value: null) => void;
  setIsLoading?: (value: boolean) => void;
  setIsOnboarded?: (value: boolean) => void;
  setWalletsHydrated?: (value: boolean) => void;
  walletsRef: MutableRefObject<WalletState[]>;
  lastTxsJsonRef: MutableRefObject<Map<string, string>>;
  hydrateSeenReceipts: (
    id: string,
    txs: readonly WalletTransaction[],
    isCurrent: () => boolean,
  ) => Promise<void>;
  setWallets: Dispatch<SetStateAction<WalletState[]>>;
  setActiveWalletId: Dispatch<SetStateAction<string | null>>;
}

/** Rehydrate on identity changes. Each switch invalidates all earlier reads
 * and connection callbacks, even A → B → A where pubkey equality alone fails.
 * The cold-start preferences/migration flow remains in WalletContext.
 */
export function useWalletIdentityHydration({
  setLastIncomingPayment,
  setIsLoading,
  setIsOnboarded,
  setWalletsHydrated,
  walletsRef,
  lastTxsJsonRef,
  hydrateSeenReceipts,
  setWallets,
  setActiveWalletId,
}: WalletIdentityHydrationDeps): () => () => boolean {
  const disposed = useRef(false);
  const generation = useRef(0);
  const captureIdentity = useCallback(() => {
    const ticket = generation.current;
    const pubkey = walletStorage.getActivePubkey();
    return () =>
      !disposed.current &&
      generation.current === ticket &&
      walletStorage.getActivePubkey() === pubkey;
  }, []);
  useEffect(() => {
    disposed.current = false;
    let lastSeenPubkey = walletStorage.getActivePubkey();
    const unsubscribe = walletStorage.subscribeActivePubkey((nextPubkey, change) => {
      if (nextPubkey === lastSeenPubkey) return;
      lastSeenPubkey = nextPubkey;
      // The publish that opens the cold-start gate is hydrated once by
      // useWalletStartup; loading it here too was the double hydration (#816).
      if (change?.startup) return;
      generation.current++;
      const isCurrent = captureIdentity();
      // Disconnect every current NWC connection so we don't leak the
      // previous identity's WebSockets / pay_invoice handlers.
      for (const w of walletsRef.current) {
        if (w.walletType === 'nwc') nwcService.disconnect(w.id);
      }
      // Clear in-memory wallet list and tx fingerprints so the UI reflects the
      // switch and nothing can act on the previous identity's wallets. Leave
      // `isLoading` alone: it gates the whole navigator (AppNavigator), so
      // raising it here would tear down and remount navigation on every
      // account switch / logout. `walletsHydrated=false` covers the reload.
      setWalletsHydrated?.(false);
      setWallets([]);
      setActiveWalletId(null);
      setLastIncomingPayment?.(null);
      lastTxsJsonRef.current.clear(); // drop stale fingerprints from the previous identity
      // Re-hydrate from per-account-keyed storage.
      (async () => {
        if (!isCurrent()) return;
        try {
          // A legacy single-wallet install's migration is deferred while no
          // identity is published; run it for this one before reading its list.
          if (nextPubkey) {
            await walletStorage
              .migrateLegacy(nextPubkey)
              .catch((e) => console.warn('[Wallet] legacy migration failed:', e));
            const onboarded = await walletStorage.isOnboarded();
            if (!isCurrent()) return;
            setIsOnboarded?.(onboarded);
          }
          const walletList = await walletStorage.getWalletList();
          if (!isCurrent()) return;
          const walletStates: WalletState[] = await Promise.all(
            walletList.map(async (w) => {
              let cachedTxs: WalletTransaction[] = [];
              try {
                const txJson = await AsyncStorage.getItem(`txs_${w.id}`);
                if (txJson) {
                  cachedTxs = JSON.parse(txJson);
                  // Same fingerprint seed as the startup hydration (#1014).
                  if (isCurrent()) lastTxsJsonRef.current.set(w.id, txJson);
                }
              } catch (err) {
                console.warn(`Corrupted cached txs for ${w.id}, clearing:`, err);
                await AsyncStorage.removeItem(`txs_${w.id}`);
              }
              // Hydrate cached balance from disk (matches the startup-
              // hydration path). Identity-switch is treated identically:
              // never run BDK init eagerly. Fresh balance comes lazily on
              // refresh / wallet-detail open.
              let cachedBalance: number | null = null;
              try {
                const bRaw = await AsyncStorage.getItem(`balance_${w.id}`);
                if (bRaw) {
                  const n = Number(bRaw);
                  if (Number.isFinite(n)) cachedBalance = n;
                }
              } catch {
                // Ignore corrupted cache.
              }
              // Seed the announced-receipts set before the detector runs (see
              // the startup-hydration path for the rationale).
              if (isCurrent()) await hydrateSeenReceipts(w.id, cachedTxs, isCurrent);
              return {
                ...w,
                isConnected: false,
                balance: cachedBalance,
                walletAlias: null,
                transactions: cachedTxs,
              };
            }),
          );
          if (!isCurrent()) return;
          setWallets(walletStates);
          logWalletHydration('account-change', nextPubkey, walletStates.length);
          setWalletsHydrated?.(true);
          // Only matters on cold start: the startup hydration bails when an
          // identity lands mid-boot, so this completion ends the boot spinner.
          setIsLoading?.(false);
          if (walletStates.length > 0) setActiveWalletId(walletStates[0].id);
          // Kick off NWC connects in parallel; same fire-and-forget
          // pattern as the startup hydration. Onchain wallets are NOT
          // fetched eagerly (BDK init costs ~9 s of JS-thread time on
          // a real fixture) — they hydrate from `balance_<id>` cache
          // above and refresh lazily on user action.
          void Promise.all(
            walletList.map(async (wallet) => {
              if (!isCurrent()) return;
              try {
                if (wallet.walletType === 'onchain') {
                  return;
                }
                const nwcUrl = await walletStorage.getNwcUrl(wallet.id);
                if (!nwcUrl || !isCurrent()) return;
                const result = await nwcService.connect(
                  wallet.id,
                  nwcUrl,
                  () => {
                    if (!isCurrent()) return;
                    setWallets((prev) =>
                      isCurrent()
                        ? prev.map((w) => (w.id === wallet.id ? { ...w, isConnected: true } : w))
                        : prev,
                    );
                  },
                  isCurrent,
                );
                if (!isCurrent()) return;
                if (result.success) {
                  setWallets((prev) =>
                    !isCurrent()
                      ? prev
                      : prev.map((w) =>
                          w.id === wallet.id
                            ? {
                                ...w,
                                isConnected: true,
                                balance: result.balance ?? w.balance ?? null,
                              }
                            : w,
                        ),
                  );
                }
              } catch (error) {
                console.warn(`[Wallet] re-hydrate connect failed for ${wallet.id}:`, error);
              }
            }),
          );
        } catch (e) {
          console.warn('[Wallet] re-hydrate failed:', e);
          if (isCurrent()) {
            setWalletsHydrated?.(true);
            setIsLoading?.(false);
          }
        }
      })();
    });
    return () => {
      disposed.current = true;
      generation.current++;
      unsubscribe();
    };
  }, [
    setLastIncomingPayment,
    setIsLoading,
    setIsOnboarded,
    setWalletsHydrated,
    walletsRef,
    lastTxsJsonRef,
    hydrateSeenReceipts,
    setWallets,
    setActiveWalletId,
    captureIdentity,
  ]);
  return captureIdentity;
}
