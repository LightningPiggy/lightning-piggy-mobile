import {
  useCallback,
  useEffect,
  useState,
  type Dispatch,
  type MutableRefObject,
  type SetStateAction,
} from 'react';
import { hasMigratedToPerAccountStorage } from '../services/migrateToPerAccountStorage';
import * as nwcService from '../services/nwcService';
import { scheduleStartupTask, STARTUP_SLOTS } from '../services/startupTasks';
import * as swapRecoveryService from '../services/swapRecoveryService';
import * as walletStorage from '../services/walletStorageService';
import { readWalletOwnerHint } from '../services/walletOwnerHint';
import type { WalletState, WalletTransaction } from '../types/wallet';
import { parseNwcLud16 } from '../utils/nwcLud16';
import { perfLog } from '../utils/perfLog';
import {
  hydrateWalletStates,
  logWalletHydration,
  type WalletHydrationSource,
} from './hydrateWalletStates';
import {
  prefetchWalletStates,
  takeWalletPrefetch,
  type WalletPrefetch,
} from './walletStartupPrefetch';
import { createWalletLoadRetry, useWalletLoadRetryOnResume } from './walletStartupRetry';

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

type LoadedWallets = NonNullable<Awaited<ReturnType<typeof loadOwnerWallets>>>;

/**
 * Migrate, then read the current owner's wallet list and cached state. Null
 * when the identity changed meanwhile; throws on a storage error.
 */
async function loadOwnerWallets(
  { lastTxsJsonRef, hydrateSeenReceipts, setIsOnboarded }: WalletStartupDeps,
  isCurrent: () => boolean,
  usablePrefetch: WalletPrefetch | null,
  onboarded: boolean,
) {
  // Migrate legacy single-wallet data. A no-op while the identity is
  // null; useWalletIdentityHydration retries once a pubkey lands.
  await walletStorage.migrateLegacy();

  // Re-check onboarding after migration (migration sets it). The
  // onboarding flag isn't per-account, so this runs even if the
  // identity changed while migrating.
  if (!onboarded) {
    setIsOnboarded(await walletStorage.isOnboarded().catch(() => onboarded));
  }
  if (!isCurrent()) return null;

  const owner = walletStorage.getActivePubkey();
  perfLog('WalletProvider startup: getWalletList begin');
  const walletList = await walletStorage.getWalletList(owner);
  perfLog(`WalletProvider startup: getWalletList -> ${walletList.length} wallets`);
  const prefetched = await takeWalletPrefetch(
    usablePrefetch,
    owner,
    walletList,
    lastTxsJsonRef,
    hydrateSeenReceipts,
    isCurrent,
  );
  const walletStates =
    prefetched ??
    (await hydrateWalletStates(walletList, lastTxsJsonRef, hydrateSeenReceipts, isCurrent));
  return { owner, walletList, walletStates, fromPrefetch: prefetched !== null };
}

/** Commit a loaded list, end the boot spinner, then reconnect NWC wallets. */
function commitOwnerWallets(
  { setIsLoading, setWalletsHydrated, setWallets, setActiveWalletId }: WalletStartupDeps,
  { owner, walletList, walletStates }: LoadedWallets,
  isCurrent: () => boolean,
  source: WalletHydrationSource,
): void {
  setWallets(walletStates);
  logWalletHydration(source, owner, walletStates.length);
  if (!walletProviderHydratedLogged) {
    walletProviderHydratedLogged = true;
    perfLog(`WalletProvider hydrated ${walletStates.length} wallets`);
  }
  // Only the current identity may publish hydration completion.
  setWalletsHydrated(true);

  if (walletStates.length > 0) setActiveWalletId(walletStates[0].id);

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
  // The owner's list is loaded: drop the legacy shared list if it is only a
  // stale copy of it (a single AsyncStorage read once it is gone).
  if (owner) {
    void walletStorage.pruneMigratedLegacyWalletList(owner).catch((e) => {
      console.warn('[Wallet] legacy wallet list cleanup failed:', e);
    });
  }
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
        if (!nwcUrl || !isCurrent()) return;

        const result = await nwcService.connect(
          wallet.id,
          nwcUrl,
          () => {
            if (!isCurrent()) return;
            setWallets((prev) =>
              !isCurrent()
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
          isCurrent,
        );
        if (result.success && isCurrent()) {
          let info: Awaited<ReturnType<typeof nwcService.getInfo>> | null = null;
          try {
            info = await nwcService.getInfo(wallet.id);
          } catch (e) {
            if (__DEV__) console.warn(`[NWC] getInfo failed for ${wallet.id.slice(0, 8)}`, e);
          }
          if (!isCurrent()) return;
          const lud16 = parseNwcLud16(nwcUrl);

          setWallets((prev) =>
            !isCurrent()
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
}

/** The owner is confirmed, or this install predates per-account storage. */
async function isOwnerReadable(): Promise<boolean> {
  if (walletStorage.isWalletOwnerGateOpen()) return true;
  return !(await hasMigratedToPerAccountStorage().catch(() => true));
}

/**
 * Whether startup may read the wallet list. After a gate timeout the owner
 * is unknown and `getWalletList` would read the legacy shared `wallet_list`,
 * which on a per-account install may hold another account's wallets (#1746).
 * Only a pre-migration install reads it then (it is that one account's only
 * copy). Otherwise the boot spinner ends with Home neutral and startup waits
 * for the real owner: false when a signed-in one lands (that publish is an
 * ordinary account change, so the identity hydration loads it), true when
 * auto-login confirms signed-out.
 */
async function awaitConfirmedOwner(
  setIsLoading: (value: boolean) => void,
  onWait: () => void,
): Promise<boolean> {
  if (await isOwnerReadable()) return true;
  perfLog('wallet gate timed out on a per-account install: waiting for the owner');
  setIsLoading(false);
  onWait();
  await walletStorage.awaitWalletOwnerGateOpen();
  return walletStorage.getActivePubkey() === null;
}

/**
 * Cold start: load prefs, migrate, hydrate the real owner's cached wallets
 * once, end the boot spinner, then reconnect NWC wallets in the background.
 * Later account changes are `useWalletIdentityHydration`'s job.
 *
 * If every startup attempt fails, the load is retried in-session on a
 * staggered app resume (backing off) and via the returned pull-to-refresh
 * callback, until one succeeds or the identity changes (#1746).
 */
export function useWalletStartup(deps: WalletStartupDeps): () => Promise<void> {
  // Deps are stable refs / useCallbacks / state setters (see the effect below).
  const [retry] = useState(() =>
    createWalletLoadRetry(async () => {
      // While startup waits on an unconfirmed owner, a load would read the
      // legacy shared list. Fail fast instead (never hang a pull-to-refresh).
      if (!(await isOwnerReadable())) throw new Error('wallet owner not confirmed yet');
      const isCurrent = deps.captureWalletIdentity();
      const loaded = await loadOwnerWallets(deps, isCurrent, null, false);
      if (loaded && isCurrent()) commitOwnerWallets(deps, loaded, isCurrent, 'startup-retry');
    }),
  );
  useWalletLoadRetryOnResume(retry);

  useEffect(() => {
    const { captureWalletIdentity, setIsOnboarded, setIsLoading } = deps;
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
        // full (#816). The 2 s timeout keeps a wedged NostrContext from
        // holding the boot spinner; awaitConfirmedOwner decides what follows.
        await walletStorage.awaitActivePubkeyHydrated();
        // Waiting on the owner arms the retry too, so pull-to-refresh can
        // load once the owner is confirmed even if startup's wait never ends.
        if (!(await awaitConfirmedOwner(setIsLoading, () => retry.arm(captureWalletIdentity())))) {
          return;
        }
        isStartupCurrent = captureWalletIdentity();

        // Nothing else retries this load straight away: the identity
        // hydration skips the gate-opening publish. So a transient storage
        // error gets one more attempt before startup hands over to the
        // in-session retry (see the catch below).
        const loaded = await loadOwnerWallets(deps, isStartupCurrent, prefetch, onboarded).catch(
          (error: unknown) => {
            console.warn('[Wallet] startup hydration failed, retrying once:', error);
            return isStartupCurrent()
              ? loadOwnerWallets(deps, isStartupCurrent, null, onboarded)
              : null;
          },
        );
        if (!loaded || !isStartupCurrent()) return;
        commitOwnerWallets(
          deps,
          loaded,
          isStartupCurrent,
          loaded.fromPrefetch ? 'startup-prefetch' : 'startup',
        );
        // Loaded: a retry armed while waiting on the owner has nothing left to do.
        retry.disarm();
      } catch (error) {
        console.warn('Wallet startup failed:', error);
        if (!isStartupCurrent()) return;
        // End the boot spinner but leave `walletsHydrated` false: the load
        // failed, so `wallets=[]` is not a confirmed empty list. Home stays
        // neutral instead of showing a signed-in user the new-user welcome,
        // and WatcherPushBridge won't publish an empty NWC wallet set (which
        // could unregister the payment watcher). Arm the in-session retry
        // (resume / pull-to-refresh); an account change hydrates anyway.
        setIsLoading(false);
        retry.arm(isStartupCurrent);
      } finally {
        // Attempt to recover any pending Boltz swaps (e.g. reverse swap
        // claims that were interrupted by pay_invoice timeout or app crash).
        // Runs in background so it doesn't block UI. The swap index is global,
        // not per identity, so this must run even when an identity switch
        // (e.g. auto-login landing mid-startup) cut the hydration above short.
        // Its own startup-queue slot: a claim / refund has hours of slack, so
        // it needn't land on the same frames as the NWC connects above.
        scheduleStartupTask({
          name: 'swapRecovery',
          slotMs: STARTUP_SLOTS.swapRecovery,
          run: () =>
            swapRecoveryService.recoverPendingSwaps().catch((e) => {
              console.warn('[SwapRecovery] Background recovery failed:', e);
            }),
        });
      }
    })();
    // Mount-once startup. The deps are stable refs / useCallbacks / state
    // setters; re-running would (wrongly) repeat the whole startup hydration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return useCallback(() => retry.attempt('refresh'), [retry]);
}
