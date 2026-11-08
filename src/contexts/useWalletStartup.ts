import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import * as nwcService from '../services/nwcService';
import * as swapRecoveryService from '../services/swapRecoveryService';
import * as walletStorage from '../services/walletStorageService';
import { readWalletOwnerHint } from '../services/walletOwnerHint';
import type { WalletState, WalletTransaction } from '../types/wallet';
import { parseNwcLud16 } from '../utils/nwcLud16';
import { perfLog } from '../utils/perfLog';
import { hydrateWalletStates, logWalletHydration } from './hydrateWalletStates';
import { prefetchWalletStates, takeWalletPrefetch } from './walletStartupPrefetch';

// Captured at module-evaluation time, which is the closest proxy we have to "JS bundle started executing after app launch". Used by the [Perf] wallet-connect marker so perf scripts can report time-from-launch-to-first-NWC-connect without needing a separate launch timestamp source.
const WALLET_MODULE_LOAD_T0 = Date.now();
let firstWalletConnectLogged = false;
let walletProviderHydratedLogged = false;

interface WalletStartupDeps {
  captureWalletIdentity: () => () => boolean;
  lastTxsJsonRef: MutableRefObject<Map<string, string>>;
  hydrateSeenReceipts: (
    id: string,
    txs: readonly WalletTransaction[],
    isCurrent: () => boolean,
  ) => Promise<void>;
  setIsOnboarded: (value: boolean) => void;
  setIsLoading: (value: boolean) => void;
  setWalletsHydrated: (value: boolean) => void;
  setWallets: Dispatch<SetStateAction<WalletState[]>>;
  setActiveWalletId: Dispatch<SetStateAction<string | null>>;
}

/**
 * Cold start: load prefs, migrate, hydrate the real owner's cached wallets
 * once, end the boot spinner, then reconnect NWC wallets in the background.
 * Later account changes are `useWalletIdentityHydration`'s job.
 */
export function useWalletStartup({
  captureWalletIdentity,
  lastTxsJsonRef,
  hydrateSeenReceipts,
  setIsOnboarded,
  setIsLoading,
  setWalletsHydrated,
  setWallets,
  setActiveWalletId,
}: WalletStartupDeps): void {
  useEffect(() => {
    let isStartupCurrent = captureWalletIdentity();
    (async () => {
      try {
        // Onboarding status (not per-account) and the last owner hint don't
        // depend on the identity, so read them while NostrContext is still
        // reading SecureStore. Neither may abort startup before the gate:
        // the identity hydration skips the gate-opening publish because this
        // path owns that load. A failed onboarding read is re-checked below.
        const [onboarded, hint] = await Promise.all([
          walletStorage.isOnboarded().catch(() => false),
          readWalletOwnerHint(),
        ]);
        setIsOnboarded(onboarded);
        // Head start: read the hinted account's cached wallets now. Only
        // committed if auto-login confirms that owner (takeWalletPrefetch).
        const prefetch =
          hint && !walletStorage.isWalletOwnerGateOpen() ? prefetchWalletStates(hint) : null;

        // Wait for NostrContext's auto-login to settle the real owner BEFORE
        // any wallet-list read or write. `migrateLegacy`, `getWalletList`,
        // `saveWalletList` and `initialiseSendThresholdForNewInstall` all key
        // off `walletStorageService._activePubkey` — running them for the
        // wrong owner would read / write the wrong `wallet_list` key (#442
        // Copilot review), and hydrating twice made Home render empty then
        // full (#816). 2 s timeout means a wedged NostrContext still falls
        // through to legacy-key behaviour matching pre-#288 installs.
        await walletStorage.awaitActivePubkeyHydrated();
        isStartupCurrent = captureWalletIdentity();

        // Migrate legacy single-wallet data. A no-op while the identity is
        // null; useWalletIdentityHydration retries once a pubkey lands.
        await walletStorage.migrateLegacy();

        // Re-check onboarding after migration (migration sets it). The
        // onboarding flag isn't per-account, so this runs even if the
        // identity changed while migrating.
        if (!onboarded) {
          const onboardedAfterMigration = await walletStorage.isOnboarded();
          setIsOnboarded(onboardedAfterMigration);
        }
        if (!isStartupCurrent()) return;

        // Load and reconnect all wallets
        const owner = walletStorage.getActivePubkey();
        perfLog('WalletProvider startup: getWalletList begin');
        const walletList = await walletStorage.getWalletList(owner);
        perfLog(`WalletProvider startup: getWalletList -> ${walletList.length} wallets`);
        const prefetched = await takeWalletPrefetch(
          prefetch,
          owner,
          walletList,
          lastTxsJsonRef,
          hydrateSeenReceipts,
          isStartupCurrent,
        );
        const walletStates =
          prefetched ??
          (await hydrateWalletStates(
            walletList,
            lastTxsJsonRef,
            hydrateSeenReceipts,
            isStartupCurrent,
          ));
        if (!isStartupCurrent()) return;
        setWallets(walletStates);
        logWalletHydration(prefetched ? 'startup-prefetch' : 'startup', owner, walletStates.length);
        if (!walletProviderHydratedLogged) {
          walletProviderHydratedLogged = true;
          perfLog(`WalletProvider hydrated ${walletStates.length} wallets`);
        }
        // Only the current identity may publish hydration completion.
        setWalletsHydrated(true);

        if (isStartupCurrent() && walletStates.length > 0) {
          setActiveWalletId(walletStates[0].id);
        }

        // Wallets are usable immediately with cached balance + tx
        // history from AsyncStorage, so we can flip the app into
        // "loaded" state BEFORE the (slow) NWC connect handshakes
        // finish. Each handshake does `provider.enable()` with up to
        // 3 retries × 2 s backoff + a 500 ms stabilise wait = 2-14 s
        // per wallet. Serialising them behind the UI boot meant a
        // user with 2 NWC wallets waited 10+ s on a pink screen.
        // Kick connects off in parallel but DON'T await — state
        // updates inside each `.then` patch the wallet individually
        // as it comes online, and any `pay / makeInvoice / getBalance`
        // call will auto-await the connect because `nwcService.connect`
        // is idempotent and provider-map-keyed.
        setIsLoading(false);
        // No eager onchain `getBalance` at boot. Each call does
        // `BDK.Wallet.create() + Electrum.sync()` — ~9 s of JS-thread
        // time even for ONE wallet (measured on Big Piggy's AVD fixture
        // with 230 NIP-17 wraps in the inbox). That 9 s landed inside
        // the cold-start window where the user is most likely to tap
        // Send, and tap events queued behind it — root cause of the
        // "Send button feels frozen for 12 s" symptom. Cached balances
        // from the previous session are hydrated above; fresh balances
        // arrive on pull-to-refresh / wallet detail open / explicit
        // `refreshBalanceForWallet` calls and useOnchainIncomingPoll's
        // first sweep (30 s after launch, #1725), all of which lazily init
        // BDK on demand (`bdkWallets` in onchainService memoises per id).
        void Promise.all(
          walletList.map(async (wallet) => {
            try {
              if (wallet.walletType === 'onchain') {
                return;
              }

              // NWC wallet: connect via Nostr
              const nwcUrl = await walletStorage.getNwcUrl(wallet.id);
              if (!nwcUrl || !isStartupCurrent()) return;

              const result = await nwcService.connect(
                wallet.id,
                nwcUrl,
                () => {
                  if (!isStartupCurrent()) return;
                  setWallets((prev) =>
                    !isStartupCurrent()
                      ? prev
                      : prev.map((w) => (w.id === wallet.id ? { ...w, isConnected: true } : w)),
                  );
                  if (!firstWalletConnectLogged) {
                    firstWalletConnectLogged = true;
                    console.log(
                      `[Perf] wallet connected: ${wallet.id.slice(0, 8)} in ${Date.now() - WALLET_MODULE_LOAD_T0}ms from JS bundle load`,
                    );
                  }
                },
                isStartupCurrent,
              );
              if (result.success && isStartupCurrent()) {
                let info: Awaited<ReturnType<typeof nwcService.getInfo>> | null = null;
                try {
                  info = await nwcService.getInfo(wallet.id);
                } catch (e) {
                  if (__DEV__) console.warn(`[NWC] getInfo failed for ${wallet.id.slice(0, 8)}`, e);
                }
                if (!isStartupCurrent()) return;
                const lud16 = parseNwcLud16(nwcUrl);

                setWallets((prev) =>
                  !isStartupCurrent()
                    ? prev
                    : prev.map((w) =>
                        w.id === wallet.id
                          ? {
                              ...w,
                              isConnected: true,
                              balance: result.balance ?? w.balance ?? null,
                              walletAlias: info?.alias || w.walletAlias || null,
                              lightningAddress: w.lightningAddress || lud16 || info?.lud16 || null,
                            }
                          : w,
                      ),
                );
              }
            } catch (error) {
              console.warn(`Failed to connect wallet ${wallet.alias} (${wallet.id}):`, error);
            }
          }),
        );
      } catch (error) {
        console.warn('Wallet startup failed:', error);
        if (!isStartupCurrent()) return;
        // Order matches the success path: flip `walletsHydrated` first so consumers observing the loading-state change can already trust hydration is complete; only then unblock the UI via `setIsLoading(false)`. Idempotent; React bails on no-op state sets.
        setWalletsHydrated(true);
        setIsLoading(false);
      } finally {
        // Attempt to recover any pending Boltz swaps (e.g. reverse swap
        // claims that were interrupted by pay_invoice timeout or app crash).
        // Runs in background so it doesn't block UI. The swap index is global,
        // not per identity, so this must run even when an identity switch
        // (e.g. auto-login landing mid-startup) cut the hydration above short.
        swapRecoveryService.recoverPendingSwaps().catch((e) => {
          console.warn('[SwapRecovery] Background recovery failed:', e);
        });
      }
    })();
    // Mount-once startup. The deps are stable refs / useCallbacks / state
    // setters; re-running would (wrongly) repeat the whole startup hydration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
