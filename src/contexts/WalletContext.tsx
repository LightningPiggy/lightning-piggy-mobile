import { perfLog } from '../utils/perfLog';
import { useNwcConnectionWatchdog } from './useNwcConnectionWatchdog';
import { appReadRelays } from '../services/appReadRelays';
import { useWalletMetadataActions } from './useWalletMetadataActions';
import { hydrateWalletStates } from './hydrateWalletStates';
import { useLegacyOnchainMigration } from './useLegacyOnchainMigration';
import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useMemo,
  useRef,
} from 'react';
import { AppState } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as nwcService from '../services/nwcService';
import * as nostrService from '../services/nostrService';
import * as lnurlService from '../services/lnurlService';
import * as zapCounterpartyStorage from '../services/zapCounterpartyStorage';
import * as zapSenderProfileStorage from '../services/zapSenderProfileStorage';
import * as zapResolverFingerprintStorage from '../services/zapResolverFingerprintStorage';
import { computePendingHash, shouldSkipResolve } from '../utils/zapResolverGuard';
import { singleFlight } from '../utils/singleFlight';
import * as swapRecoveryService from '../services/swapRecoveryService';
import * as onchainService from '../services/onchainService';
import * as walletStorage from '../services/walletStorageService';
import { useAccountCurrency } from './useAccountCurrency';
import { rearmBackgroundWatchAfterNwcWalletAdded } from '../services/backgroundDmService';
import { FiatCurrency } from '../services/fiatService';
import { WalletLiveContext } from './WalletLiveContext';
import { useOnchainIncomingPoll } from './useOnchainIncomingPoll';
import { useWalletIdentityHydration } from './useWalletIdentityHydration';
import { useDeferredSwapRefresh } from './useDeferredSwapRefresh';
import { hydrateWalletReceipts, persistSeenReceipts } from './hydrateWalletReceipts';
import { useIncomingReceiveAnnouncer } from './useIncomingReceiveAnnouncer';
import { useWalletTransactionsFetch } from './useWalletTransactionsFetch';
import type { IncomingPayment } from './incomingPayment';
import {
  CardTheme,
  WalletMetadata,
  WalletState,
  WalletTransaction,
  ZapCounterpartyInfo,
} from '../types/wallet';
import { deferPostPaymentRefresh } from '../utils/deferPostPaymentRefresh';
import { applyResolverResults, mergeWalletUpdate } from '../utils/walletStateMerge';
import { addNwcWalletForIdentity } from '../services/addNwcWalletForIdentity';
import { parseNwcLud16 } from '../utils/nwcLud16';
import { collectZapRecipientPubkeys } from '../utils/zapRecipients';
import { upsertPendingWalletTransaction } from '../utils/pendingWalletTransaction';

// Captured at module-evaluation time, which is the closest proxy we have to "JS bundle started executing after app launch". Used by the [Perf] wallet-connect marker so perf scripts can report time-from-launch-to-first-NWC-connect without needing a separate launch timestamp source.
const WALLET_MODULE_LOAD_T0 = Date.now();
let firstWalletConnectLogged = false;
perfLog('WalletContext module-eval');
let __walletProviderFirstRenderLogged = false;
let __walletProviderHydratedLogged = false;

export type { IncomingPayment } from './incomingPayment';

// The #P-tagged outgoing zap-receipt relay fetch is expensive (500-event
// filter). With local-storage attribution being the common path, this
// rate limit keeps unmatched-outgoing refreshes from hammering relays.
const OUTGOING_RECEIPT_FETCH_TTL_MS = 5 * 60 * 1000;
const lastOutgoingReceiptFetch = new Map<string, number>();

// In-flight zap-resolver AbortControllers, keyed by walletId. A fresh
// `resolveZapSendersForWallet` call for a wallet aborts the previous
// (now-stale) run for that same wallet so two passes don't compete for
// the JS thread (#526). Cleared when a run finishes.
const zapResolverControllers = new Map<string, AbortController>();

interface WalletContextType {
  // Multi-wallet state
  wallets: WalletState[];
  activeWalletId: string | null;
  activeWallet: WalletState | null;
  hasWallets: boolean;

  // App state
  isOnboarded: boolean;
  isLoading: boolean;
  // True once the initial AsyncStorage wallet read has completed (regardless
  // of whether any wallets were found). Consumers use this to distinguish
  // "wallets is empty because none exist" from "wallets is empty because we
  // haven't loaded them yet" — important for cold-start UI gating where the
  // disabled-style flicker contradicts the buttons' actual interactivity.
  // See #201.
  walletsHydrated: boolean;

  // User prefs
  currency: FiatCurrency;
  setCurrency: (currency: FiatCurrency) => Promise<void>;

  // Wallet actions
  addNwcWallet: (
    nwcUrl: string,
    alias: string,
    theme: CardTheme,
  ) => Promise<{ success: boolean; error?: string; walletId?: string }>;
  addOnchainWallet: (
    xpub: string,
    alias: string,
    theme: CardTheme,
    electrumServer?: string,
  ) => Promise<{ success: boolean; error?: string }>;
  addHotWallet: (
    mnemonic: string,
    alias: string,
    theme: CardTheme,
  ) => Promise<{ success: boolean; error?: string }>;
  removeWallet: (walletId: string) => Promise<void>;
  updateWalletSettings: (
    walletId: string,
    settings: {
      alias?: string;
      theme?: CardTheme;
      hideBalance?: boolean;
      lightningAddress?: string | null;
    },
  ) => Promise<void>;
  reorderWallet: (walletId: string, direction: 'up' | 'down') => Promise<void>;
  setActiveWallet: (walletId: string | null) => void;
  refreshActiveBalance: () => Promise<void>;
  completeOnboarding: () => Promise<void>;

  // Payment actions (operate on active wallet)
  makeInvoice: (amount: number, memo?: string) => Promise<string>;
  payInvoice: (
    bolt11: string,
    signalOrOptions?: AbortSignal | nwcService.PayInvoiceOptions,
  ) => Promise<{ preimage: string }>;

  // Payment actions with explicit wallet ID (for sheets)
  makeInvoiceForWallet: (walletId: string, amount: number, memo?: string) => Promise<string>;
  payInvoiceForWallet: (
    walletId: string,
    bolt11: string,
    signalOrOptions?: AbortSignal | nwcService.PayInvoiceOptions,
  ) => Promise<{ preimage: string }>;
  refreshBalanceForWallet: (walletId: string) => Promise<void>;
  deferSwapRefresh: (refresh: () => Promise<unknown>) => void;
  /** Resolves `true` when a fresh list was committed, `false` on failure (never rejects). */
  fetchTransactionsForWallet: (walletId: string, opts?: { force?: boolean }) => Promise<boolean>;

  // Transaction helpers
  addPendingTransaction: (walletId: string, tx: WalletTransaction) => void;

  // On-chain actions
  getReceiveAddress: (walletId: string) => Promise<string>;

  /**
   * Kick off aggressive 1 s polling for a specific NWC invoice for up
   * to `durationMs` (default 3 min). Called by ReceiveSheet when an
   * invoice is generated — the poll lives in the context so it survives
   * the sheet closing (user can generate an invoice, close the sheet,
   * wander into Friends, and still get the confetti pop).
   *
   * **Replacement semantics:** subsequent calls replace any in-flight
   * expectation (only one tracked at a time). This is safe because the
   * balance-diff detector still runs independently — so if invoice A's
   * expectation is replaced by invoice B before A settles, A's eventual
   * balance increment will *still* fire the overlay via the diff path,
   * just with worst-case 30 s latency (baseline poll) instead of 1 s.
   *
   * When `expectedAmountSats` is provided and the lookup reports
   * `paid: true`, the overlay uses that exact amount rather than the
   * balance-delta heuristic. This matters when two invoices settle
   * between polls: the delta would report the combined total, the
   * explicit amount reports what *this* invoice was for.
   *
   * Stops early on detected settlement or after the duration elapses.
   */
  expectPayment: (
    walletId: string,
    paymentHash: string,
    expectedAmountSats?: number,
    durationMs?: number,
  ) => void;

  /**
   * Demand-counted gate on the 30 s background `getBalance` poll. The
   * poll runs only while at least one caller has an outstanding request
   * — typical pattern is a balance-displaying screen calling
   * `requestBalancePoll()` inside `useFocusEffect` and using the
   * returned unsubscribe in the cleanup. When the demand count drops to
   * zero the interval is torn down, saving the ~700-1300 ms NWC round
   * trip + the cascading WalletCarousel/TransactionList re-render that
   * fires on every poll. See #569 + #560 for the perf rationale. The
   * `expectPayment` 1 s tick is independent and unaffected — it's a
   * separate per-invoice poller. Returns an unsubscribe fn; safe to
   * call the unsubscribe multiple times (idempotent past zero).
   */
  requestBalancePoll: () => () => void;

  // Legacy compatibility
  isConnected: boolean;
  balance: number | null;
  walletAlias: string | null;
}

const WalletContext = createContext<WalletContextType | undefined>(undefined);

// Live price/receive slices (#801) live in their own module; re-export the
// consumer hook so the public surface stays at one path, like `useWallet`.
export { useWalletLive } from './WalletLiveContext';

export const WalletProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  if (!__walletProviderFirstRenderLogged) {
    __walletProviderFirstRenderLogged = true;
    perfLog('WalletProvider first render');
  }
  const [wallets, setWallets] = useState<WalletState[]>([]);
  const [activeWalletId, setActiveWalletId] = useState<string | null>(null);
  const [isOnboarded, setIsOnboarded] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [walletsHydrated, setWalletsHydrated] = useState(false);
  const { currency, setCurrency, btcPrice } = useAccountCurrency();
  const deferSwapRefresh = useDeferredSwapRefresh();
  const [lastIncomingPayment, setLastIncomingPayment] = useState<IncomingPayment | null>(null);
  // Per-wallet last-seen balance. NOT used to detect/attribute receives any
  // more (that's done by transaction hash — see seenReceiptsRef); it's only a
  // trigger: a balance *increase* means something settled, so we refresh the
  // transaction list and let the receive detector announce it (#653).
  const paymentBaselinesRef = useRef<Map<string, number>>(new Map());
  // Per-wallet set of settled-incoming payment_hashes we've already announced.
  // Receives are detected by transaction identity (hash), not balance-diffing,
  // so a flapping/stale balance can't re-announce the same payment (#653).
  // Seeded silently from existing history on first sight (no launch re-announce).
  const seenReceiptsRef = useRef<Map<string, Set<string>>>(new Map());
  // Wallet ids whose initial transaction fetch has already been kicked off, so
  // the initial-fetch effect runs once per wallet rather than on every render
  // that touches `wallets` (#725).
  const initiallyFetchedRef = useRef<Set<string>>(new Set());

  // Record a wallet's announced-receipt baseline in memory and (optionally) on
  // disk — the "set the ref + persistSeenReceipts" pattern shared by the launch-
  // hydration, identity-switch, and first-fetch baseline sites. `persist` is
  // false only when the set was just read back from disk (no need to re-write).
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

  useLegacyOnchainMigration(wallets, walletsHydrated, setWallets);

  // Derived state
  const activeWallet = wallets.find((w) => w.id === activeWalletId) ?? null;
  const hasWallets = wallets.length > 0;

  // Legacy compatibility — on-chain wallets are always "available"
  const isConnected =
    activeWallet?.walletType === 'onchain' ? true : (activeWallet?.isConnected ?? false);
  const balance = activeWallet?.balance ?? null;
  const walletAlias = activeWallet?.walletAlias ?? activeWallet?.alias ?? null;

  const updateWalletInState = useCallback((walletId: string, updates: Partial<WalletState>) => {
    // No-op bail-out (unchanged poll → same `wallets` identity) lives in mergeWalletUpdate.
    setWallets((prev) => mergeWalletUpdate(prev, walletId, updates));
    // Persist fresh balance to disk so the next cold start can hydrate
    // it instantly (vs paying ~9 s BDK.Wallet.create + Electrum.sync to
    // re-derive it). Fire-and-forget; failure mode is "next boot shows
    // stale-or-null balance, refreshes lazily" — same as before.
    if (typeof updates.balance === 'number') {
      AsyncStorage.setItem(`balance_${walletId}`, String(updates.balance)).catch(() => {});
    }
  }, []);

  // Forward-declared so `fetchTransactionsForWallet` can call into it without
  // pulling the resolver's dependencies into its useCallback deps list.
  const resolveZapSendersRef = useRef<
    | ((walletId: string, opts?: { force?: boolean; isCurrent?: () => boolean }) => Promise<void>)
    | null
  >(null);

  // In-memory cache for `lightning_address -> LNURL server nostrPubkey`.
  // NIP-57 zap receipts tag `#p` with the recipient pubkey *as advertised by
  // the LNURL server* — which for self-hosted LNbits is usually the server's
  // own Nostr identity, not the wallet owner's. Without resolving this we
  // can't find receipts for the user's incoming zaps.
  const lud16PubkeyCacheRef = useRef<Map<string, string | null>>(new Map());
  const resolveLud16ToNostrPubkey = useCallback(async (lud16: string): Promise<string | null> => {
    // Lightning addresses are effectively case-insensitive and often carry
    // incidental whitespace (copy/paste). Normalize before cache lookup
    // and resolution so `Alice@Foo.com` and `alice@foo.com` don't round-
    // trip twice.
    const normalized = lud16.trim().toLowerCase();
    if (!normalized || !normalized.includes('@')) return null;
    const cache = lud16PubkeyCacheRef.current;
    if (cache.has(normalized)) return cache.get(normalized) ?? null;
    try {
      const params = await lnurlService.resolveLightningAddress(normalized);
      const pk = params.allowsNostr && params.nostrPubkey ? params.nostrPubkey : null;
      cache.set(normalized, pk);
      return pk;
    } catch {
      cache.set(normalized, null);
      return null;
    }
  }, []);

  // Last transactions-JSON we committed per wallet — state write AND the
  // `txs_${walletId}` persist. `fetchTransactionsForWallet` compares a fresh
  // poll's JSON (which it already computes for AsyncStorage) against this and,
  // when identical, keeps the OLD array identity instead of committing a
  // rebuilt-but-equal one. The mappers rebuild unconditionally, so before this
  // every 30 s balance/tx poll churned `wallet.transactions` and re-rendered
  // every visible TransactionList row for no visible change — measured at
  // 111 ms of every 140 ms HomeScreen update commit (#1014).
  const lastTxsJsonRef = useRef(new Map<string, string>());

  const addPendingTransaction = useCallback((walletId: string, tx: WalletTransaction) => {
    // Invalidate the persisted fingerprint for an insert or attribution update.
    lastTxsJsonRef.current.delete(walletId);
    setWallets((prev) => upsertPendingWalletTransaction(prev, walletId, tx));
  }, []);

  // Startup: load prefs, migrate, reconnect all wallets
  useEffect(() => {
    let isStartupCurrent = captureWalletIdentity();
    (async () => {
      try {
        // Check onboarding status (independent of wallet-list key —
        // ONBOARDING_KEY isn't per-account namespaced).
        const onboarded = await walletStorage.isOnboarded();
        setIsOnboarded(onboarded);

        // Wait for NostrContext to hydrate its identity BEFORE any
        // wallet-list read or write. `migrateLegacy`, `getWalletList`,
        // `saveWalletList` and `initialiseSendThresholdForNewInstall`
        // all key off `walletStorageService._activePubkey` — running
        // them while `_activePubkey` is still null would migrate /
        // read / write against the legacy unsuffixed `wallet_list`
        // key and then the per-account `wallet_list_${pubkey}` read
        // below would see different data (#442 Copilot review).
        // 2 s timeout means a wedged NostrContext still falls
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
        perfLog('WalletProvider startup: getWalletList begin');
        const walletList = await walletStorage.getWalletList();
        perfLog(`WalletProvider startup: getWalletList -> ${walletList.length} wallets`);
        const walletStates = await hydrateWalletStates(
          walletList,
          lastTxsJsonRef,
          hydrateSeenReceipts,
          isStartupCurrent,
        );
        if (!isStartupCurrent()) return;
        setWallets(walletStates);
        if (!__walletProviderHydratedLogged) {
          __walletProviderHydratedLogged = true;
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
        // `refreshBalanceForWallet` calls, all of which lazily init
        // BDK on demand (the `bdkWallets` cache in onchainService
        // already memoises per walletId).
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
    // Mount-once startup. `hydrateSeenReceipts` is a stable useCallback; adding
    // it would (wrongly) re-run the whole startup hydration.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hold the latest wallets in a ref for consumers (the NWC watchdog, the
  // fire-and-forget tx fetch) that must read fresh state without re-keying
  // their effects on the constantly-churning wallets array.
  const walletsRef = useRef(wallets);
  useEffect(() => {
    walletsRef.current = wallets;
  }, [wallets]);
  const captureWalletIdentity = useWalletIdentityHydration({
    walletsRef,
    lastTxsJsonRef,
    hydrateSeenReceipts,
    setIsLoading,
    setIsOnboarded,
    setWalletsHydrated,
    setWallets,
    setActiveWalletId,
    setLastIncomingPayment,
  });

  // NWC connection watchdog: 30 s WebSocket-health check + reconnect —
  // extracted per-responsibility hook (see useNwcConnectionWatchdog).
  useNwcConnectionWatchdog(walletsRef, updateWalletInState, captureWalletIdentity);

  const addNwcWallet = useCallback(
    async (nwcUrl: string, alias: string, theme: CardTheme) => {
      const isCurrent = captureWalletIdentity();
      const result = await addNwcWalletForIdentity(
        nwcUrl,
        alias,
        theme,
        walletsRef.current,
        isCurrent,
      );
      if (!isCurrent()) {
        if (result.state) nwcService.disconnect(result.state.id);
        return { success: false, error: 'Wallet identity changed. Please try again.' };
      }
      if (!result.success || !result.state) return result;
      const state = result.state;
      const owner = walletStorage.getActivePubkey();
      void rearmBackgroundWatchAfterNwcWalletAdded(owner).catch((e) => {
        console.warn('[WalletContext] background watch re-arm failed:', e);
      });
      setWallets((prev) => (isCurrent() ? [...prev, state] : prev));
      setActiveWalletId((prev) => (isCurrent() ? (prev ?? state.id) : prev));
      return { success: true, walletId: state.id };
    },
    [captureWalletIdentity],
  );

  const addOnchainWallet = useCallback(
    async (xpub: string, alias: string, theme: CardTheme, electrumServer?: string) => {
      // Check for duplicate on-chain wallet (same xpub)
      const trimmedXpub = xpub.trim();
      for (const w of wallets.filter((ww) => ww.walletType === 'onchain')) {
        const storedXpub = await walletStorage.getXpub(w.id);
        if (storedXpub?.trim() === trimmedXpub) {
          return { success: false, error: 'This wallet has already been imported' };
        }
      }

      const validationError = onchainService.validateOnchainImport(trimmedXpub);
      if (validationError) {
        return { success: false, error: validationError };
      }

      const id = walletStorage.generateWalletId();

      const metadata: WalletMetadata = {
        id,
        alias,
        theme,
        order: wallets.length,
        walletType: 'onchain',
        lightningAddress: null,
        onchainImportMethod: 'xpub',
        electrumServer,
      };

      // Persist xpub securely
      await walletStorage.saveXpub(id, trimmedXpub);
      await walletStorage.updateWalletList((list) => [...list, metadata]);

      // Fetch initial balance
      const bal = await onchainService.getBalance(id);

      const state: WalletState = {
        ...metadata,
        isConnected: false,
        balance: bal,
        walletAlias: null,
        transactions: [],
      };

      setWallets((prev) => [...prev, state]);
      if (!activeWalletId) {
        setActiveWalletId(id);
      }

      return { success: true };
    },
    // Same reasoning as addWallet — depend on the count, not the array.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [wallets.length, activeWalletId],
  );

  const addHotWallet = useCallback(
    async (mnemonic: string, alias: string, theme: CardTheme) => {
      // Normalize mnemonic: strip numbers, colons, extra whitespace
      const normalized = mnemonic
        .replace(/[0-9.:;,]/g, '')
        .replace(/[\r\n\t]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

      // Validate
      try {
        const bip39 = await import('bip39');
        if (!bip39.validateMnemonic(normalized)) {
          return { success: false, error: 'Invalid mnemonic phrase' };
        }
      } catch {
        return { success: false, error: 'Failed to validate mnemonic' };
      }

      const id = walletStorage.generateWalletId();

      const metadata: WalletMetadata = {
        id,
        alias,
        theme,
        order: wallets.length,
        walletType: 'onchain',
        lightningAddress: null,
        onchainImportMethod: 'mnemonic',
      };

      // Store mnemonic securely
      await walletStorage.saveMnemonic(id, normalized);
      await walletStorage.updateWalletList((list) => [...list, metadata]);

      // Fetch initial balance via BDK
      const bal = await onchainService.getBalance(id);

      const state: WalletState = {
        ...metadata,
        isConnected: false,
        balance: bal,
        walletAlias: null,
        transactions: [],
      };

      setWallets((prev) => [...prev, state]);
      if (!activeWalletId) setActiveWalletId(id);

      return { success: true };
    },
    [wallets.length, activeWalletId],
  );

  const removeWallet = useCallback(
    async (walletId: string) => {
      const wallet = wallets.find((w) => w.id === walletId);

      if (wallet?.walletType === 'onchain') {
        await walletStorage.deleteXpub(walletId);
        await walletStorage.deleteMnemonic(walletId);
        await onchainService.removeWallet(walletId);
      } else {
        nwcService.disconnect(walletId);
        await walletStorage.deleteNwcUrl(walletId);
        // CoinOS-provisioned NWC wallets carry recovery info in
        // SecureStore — drop it with the wallet so the per-walletId
        // namespace stays tidy. No-op for NWC wallets imported by URL.
        await walletStorage.deleteCoinosRecovery(walletId);
      }

      await walletStorage.deleteWalletCaches(walletId); // before metadata removal: no orphaned cache residue if we crash mid-op
      lastTxsJsonRef.current.delete(walletId); // drop stale fingerprint so a future wallet with the same id starts fresh
      await walletStorage.updateWalletList((list) => list.filter((w) => w.id !== walletId));

      setWallets((prev) => {
        const remaining = prev.filter((w) => w.id !== walletId);
        if (activeWalletId === walletId) {
          setActiveWalletId(remaining.length > 0 ? remaining[0].id : null);
        }
        return remaining;
      });
    },
    [activeWalletId, wallets],
  );

  const { updateWalletSettings, reorderWallet } = useWalletMetadataActions(setWallets);

  const setActiveWallet = useCallback((walletId: string | null) => {
    setActiveWalletId(walletId);
  }, []);

  const refreshBalanceForWallet = useCallback(
    async (walletId: string) => {
      // Pin the identity generation: after B → C → B the same wallet id is back
      // in state, so only the generation stops a late read overwriting the
      // re-hydrated balance (state and its `balance_` cache).
      const isCurrent = captureWalletIdentity();
      const wallet = wallets.find((w) => w.id === walletId);
      const b =
        wallet?.walletType === 'onchain'
          ? await onchainService.getBalance(walletId)
          : await nwcService.getBalance(walletId);
      if (b !== null && isCurrent()) updateWalletInState(walletId, { balance: b });
    },
    [wallets, updateWalletInState, captureWalletIdentity],
  );

  const refreshActiveBalance = useCallback(async () => {
    if (activeWalletId) await refreshBalanceForWallet(activeWalletId);
  }, [activeWalletId, refreshBalanceForWallet]);

  // Fetch + commit + persist one wallet's tx list; resolves whether it succeeded.
  const fetchTransactionsForWallet = useWalletTransactionsFetch({
    walletsRef,
    lastTxsJsonRef,
    seenReceiptsRef,
    resolveZapSendersRef,
    updateWalletInState,
    seedSeenReceipts,
    captureWalletIdentity,
  });

  /**
   * Walk the current transactions for `walletId` and, for each incoming tx
   * that hasn't been attributed yet, try to find a NIP-57 zap receipt (kind
   * 9735) that pairs with it and resolve the sender's Nostr profile.
   *
   * Runs in the background after every transaction list refresh. The result
   * is attached to the in-memory + AsyncStorage-cached transaction so the UI
   * updates without refetching relays on every render.
   */
  const mergeResolverResults = useCallback(
    (
      walletId: string,
      resultsByTransaction: Map<WalletTransaction, ZapCounterpartyInfo | null>,
      isCurrent: () => boolean,
    ) => {
      // A returning identity can reuse the same wallet id in a new generation.
      if (resultsByTransaction.size === 0 || !isCurrent()) return;
      let nextTxs: WalletTransaction[] | null = null;
      setWallets((prev) =>
        !isCurrent()
          ? prev
          : prev.map((w) => {
              if (w.id !== walletId) return w;
              const updated = applyResolverResults(w.transactions, resultsByTransaction);
              if (!updated) return w; // keep array identity on a no-op (#1014)
              nextTxs = updated;
              return { ...w, transactions: updated };
            }),
      );
      if (nextTxs) {
        // Fingerprint updated in .then() so a failed write doesn't freeze
        // future polls as "unchanged" (#1014).
        const json = JSON.stringify(nextTxs);
        AsyncStorage.setItem(`txs_${walletId}`, json)
          .then(() => {
            if (isCurrent()) lastTxsJsonRef.current.set(walletId, json);
          })
          .catch(() => {});
      }
    },
    [],
  );

  const resolveZapSendersForWallet = useCallback(
    async (walletId: string, opts?: { force?: boolean; isCurrent?: () => boolean }) => {
      const force = opts?.force ?? false;
      // A deferred pass inherits its triggering fetch's identity generation.
      const isCurrent = opts?.isCurrent ?? captureWalletIdentity();
      if (!isCurrent()) return;
      const __zapResolveStart = Date.now();
      perfLog(`resolveZapSenders[${walletId.slice(0, 8)}]: start`);

      // Supersede any in-flight run for this wallet — a newer refresh
      // makes the old pass stale, and two passes competing for the JS
      // thread is exactly the contention we're trying to kill (#526).
      zapResolverControllers.get(walletId)?.abort();
      const abortController = new AbortController();
      zapResolverControllers.set(walletId, abortController);
      const { signal } = abortController;
      const isStale = () => signal.aborted || !isCurrent();
      // Only clear the map slot if it still points at *our* controller —
      // a later run may have already replaced it.
      const releaseController = (): void => {
        if (zapResolverControllers.get(walletId) === abortController) {
          zapResolverControllers.delete(walletId);
        }
      };

      // Read the latest committed wallet snapshot directly. A state updater
      // is deferred by React and cannot be used as a synchronous getter.
      const current = walletsRef.current.find((w) => w.id === walletId);
      const walletAlias = current?.alias ?? '';
      const pending = (current?.transactions ?? [])
        .map((tx, idx) => ({ tx, idx }))
        .filter(({ tx }) => {
          if (tx.zapCounterparty && typeof tx.zapCounterparty === 'object') return false;
          // Incoming null is a definitive receipt miss. Outgoing null can
          // acquire an attribution later, so retain it for another pass.
          return !(tx.zapCounterparty === null && tx.bolt11 && tx.type === 'incoming');
        });
      if (pending.length === 0) {
        releaseController();
        return;
      }

      // Fingerprint-based short-circuit: if the same pending set was
      // already attempted at the same storage version, nothing has
      // changed since the last run — skip the work and the re-render.
      // The fingerprint is persisted to disk (not just in-memory) so
      // this skip also covers an unchanged *cold start*; a `force` run
      // (explicit pull-to-refresh) ignores it and always does a full
      // pass. See `utils/zapResolverGuard` + `zapResolverFingerprintStorage`.
      const currentFingerprint = {
        pendingHash: computePendingHash(pending),
        storageVersion: zapCounterpartyStorage.getWriteVersion(),
      };
      const persistedFingerprint = await zapResolverFingerprintStorage.get(walletId);
      if (
        shouldSkipResolve({ current: currentFingerprint, persisted: persistedFingerprint, force })
      ) {
        if (__DEV__) console.log(`[Zap/${walletAlias}] skip: fingerprint unchanged`);
        releaseController();
        return;
      }

      // Persist the fingerprint only once the pass *completes* — a run
      // that crashes or is superseded must not "claim" this pending set,
      // or the next launch would wrongly skip it. Called at each
      // success-return path below.
      const commitFingerprint = (): void => {
        if (isCurrent()) void zapResolverFingerprintStorage.set(walletId, currentFingerprint);
        releaseController();
      };

      // Recipient pubkeys for the `#p` filter — resolved AFTER the pending/
      // fingerprint short-circuits so the common no-op balance tick never pays
      // the resolveLud16ToNostrPubkey round-trip. userPubkey reused below.
      const userPubkey = nostrService.getCurrentUserPubkey();
      const recipients = await collectZapRecipientPubkeys(
        userPubkey,
        walletsRef.current.find((w) => w.id === walletId)?.lightningAddress,
        resolveLud16ToNostrPubkey,
      );
      if (recipients.length === 0 || isStale()) {
        releaseController();
        return;
      }

      const incomingPending = pending.filter(({ tx }) => tx.type === 'incoming');
      const outgoingPending = pending.filter(({ tx }) => tx.type === 'outgoing');

      // Capture each resolved transaction, never its moving array index.
      const resultsByTransaction = new Map<WalletTransaction, ZapCounterpartyInfo | null>();

      const queryRelays = appReadRelays();

      // ─── Outgoing ──────────────────────────────────────────────────────
      // Primary: local storage populated by SendSheet at pay-time (fast,
      // always works on the device that sent).
      // Fallback: receipts where the LNURL server tagged `#P: [userPubkey]`
      // — cross-device path for zaps sent from another device, only works
      // when the server includes the optional uppercase-P tag.
      if (outgoingPending.length > 0) {
        const hashes = outgoingPending
          .map(({ tx }) => tx.paymentHash)
          .filter((h): h is string => !!h);
        // Storage hits include fresh negative cache entries (info === null):
        // those mean an earlier launch already ran the relay scan and found
        // nothing — keep skipping until the negative TTL expires (issue #127).
        const byHash = await zapCounterpartyStorage.getMany(hashes);

        const unmatched = outgoingPending.filter(
          ({ tx }) => tx.paymentHash && !byHash.has(tx.paymentHash),
        );

        const lastFetch = lastOutgoingReceiptFetch.get(walletId) ?? 0;
        const fetchAllowed = Date.now() - lastFetch > OUTGOING_RECEIPT_FETCH_TTL_MS;
        if (userPubkey && unmatched.length > 0 && fetchAllowed) {
          lastOutgoingReceiptFetch.set(walletId, Date.now());
          const sentReceipts = await nostrService.fetchZapReceiptsForSender(
            userPubkey,
            queryRelays,
            { limit: 500 },
          );
          const byBolt11Outgoing = new Map<string, (typeof sentReceipts)[number]>();
          for (const r of sentReceipts) {
            const b = r.tags.find((t) => t[0] === 'bolt11')?.[1];
            if (b) byBolt11Outgoing.set(b, r);
          }
          // Two-phase resolution so profile fetches batch into ONE
          // relay round-trip instead of N sequential ones. The old
          // per-tx `await fetchProfile` loop was the dominant
          // cold-start freeze: with ~50 unmatched outgoing zaps and
          // no cached recipient profiles, each ~500-2000 ms relay
          // round-trip serialised → 7-15 s of JS-thread
          // contention exactly when the user is most likely to tap
          // Send. Now: collect every recipient pubkey, `getMany`
          // from disk, single batched `fetchProfiles` for misses.
          // Mirrors the incoming branch below.
          type OutgoingEntry = {
            tx: WalletTransaction;
            receipt: (typeof sentReceipts)[number];
            recipientPubkey: string | null;
            comment: { comment: string; anonymous: boolean } | null;
          };
          const outgoingEntries: OutgoingEntry[] = [];
          const outgoingPubkeys = new Set<string>();
          for (const { tx } of unmatched) {
            if (!tx.bolt11) continue;
            const r = byBolt11Outgoing.get(tx.bolt11);
            if (!r) continue;
            const recipientPubkey = r.tags.find((t) => t[0] === 'p')?.[1] ?? null;
            const commentTag = nostrService.parseZapReceipt(r);
            outgoingEntries.push({ tx, receipt: r, recipientPubkey, comment: commentTag });
            if (recipientPubkey) outgoingPubkeys.add(recipientPubkey);
          }
          // Phase 1: persistent cache hits for all recipients in one read.
          const outgoingCached =
            outgoingPubkeys.size > 0
              ? await zapSenderProfileStorage.getMany([...outgoingPubkeys])
              : new Map<string, zapSenderProfileStorage.CachedZapSenderProfile>();
          // Phase 2: single batched relay round-trip for whatever the cache missed.
          const outgoingStillToFetch = [...outgoingPubkeys].filter((pk) => !outgoingCached.has(pk));
          const outgoingProfileMap =
            outgoingStillToFetch.length > 0
              ? await nostrService.fetchProfiles(outgoingStillToFetch, queryRelays)
              : undefined;
          // Write-through any newly-resolved profiles for next cold start.
          if (outgoingProfileMap && outgoingProfileMap.size > 0) {
            const toPersist = new Map<string, zapSenderProfileStorage.CachedZapSenderProfile>();
            for (const [pk, p] of outgoingProfileMap) {
              toPersist.set(pk, {
                npub: p.npub,
                name: p.name,
                displayName: p.displayName,
                picture: p.picture,
                nip05: p.nip05,
              });
            }
            void zapSenderProfileStorage.setMany(toPersist);
          }
          for (const e of outgoingEntries) {
            let profile: ZapCounterpartyInfo['profile'] = null;
            if (e.recipientPubkey) {
              const hit = outgoingCached.get(e.recipientPubkey);
              if (hit) {
                profile = hit;
              } else {
                const p = outgoingProfileMap?.get(e.recipientPubkey);
                if (p) {
                  profile = {
                    npub: p.npub,
                    name: p.name,
                    displayName: p.displayName,
                    picture: p.picture,
                    nip05: p.nip05,
                  };
                }
              }
            }
            byHash.set(e.tx.paymentHash!, {
              pubkey: e.recipientPubkey,
              profile,
              comment: e.comment?.comment ?? '',
              anonymous: e.comment?.anonymous ?? false,
            });
          }
          // Persist negative attributions for any tx that survived the relay
          // scan still unmatched. Without this we'd re-run the 500-event
          // filter on every cold start (issue #127). Only safe to write the
          // negative when we actually consulted relays — a no-bolt11 tx or a
          // rate-limit-skipped run is "didn't try" and must not poison cache.
          for (const { tx } of unmatched) {
            if (!tx.paymentHash || !tx.bolt11 || !isCurrent()) continue;
            if (byHash.has(tx.paymentHash)) continue;
            await zapCounterpartyStorage.recordOutgoingMiss(tx.paymentHash, () => !isStale());
            // Mirror the freshly-persisted negative into the in-memory map so the resolver loop below treats this tx as resolved this pass instead of leaving it `undefined` until the next refresh — closes the "one extra attribution pass per miss" gap Copilot flagged.
            byHash.set(tx.paymentHash, null);
          }
        }

        for (const { tx } of outgoingPending) {
          if (!tx.paymentHash) continue;
          if (!byHash.has(tx.paymentHash)) continue;
          // Hit may be a positive attribution OR a fresh negative cache
          // (null) — both should propagate so the in-memory tx records
          // the result and we don't keep retrying mid-session.
          resultsByTransaction.set(tx, byHash.get(tx.paymentHash) ?? null);
        }
        if (__DEV__) {
          let storageHits = 0;
          let storageMisses = 0;
          for (const { tx } of outgoingPending) {
            if (!tx.paymentHash || !byHash.has(tx.paymentHash)) continue;
            if (byHash.get(tx.paymentHash) === null) storageMisses++;
            else storageHits++;
          }
          console.log(
            `[Zap/${walletAlias}] outgoing: storage hit ${storageHits}/${outgoingPending.length} (negative-cached ${storageMisses})`,
          );
        }
      }

      // A newer refresh or identity change superseded us during the outgoing
      // relay/profile awaits — bail before the index-based merge + fingerprint
      // commit below, exactly as the incoming path does after its fetch.
      if (isStale()) {
        releaseController();
        return;
      }

      if (incomingPending.length === 0) {
        // Nothing to fetch from relays — commit the outgoing results and bail.
        if (__DEV__ && resultsByTransaction.size > 0) {
          const attributed = [...resultsByTransaction.values()].filter((v) => v !== null).length;
          console.log(
            `[Zap/${walletAlias}] outgoing-only: attributed ${attributed}/${outgoingPending.length}`,
          );
        }
        mergeResolverResults(walletId, resultsByTransaction, isCurrent);
        commitFingerprint();
        return;
      }

      // ─── Incoming: fetch receipts from relays and match ────────────────
      // `#p` is universally indexed across relays; `#bolt11` is not (damus,
      // primal and others reject it with `bad req: unindexed tag filter`).
      // We also intentionally omit `since` — narrow filters have been seen
      // to return empty from relays that happily serve the wider query.
      const receipts = await nostrService.fetchZapReceiptsForRecipient(recipients, queryRelays, {
        limit: 500,
      });
      // A newer refresh (or identity) superseded us mid-fetch — drop the stale
      // results instead of merging them + persisting a fingerprint.
      if (isStale()) {
        releaseController();
        return;
      }
      if (__DEV__)
        console.log(
          `[Zap/${walletAlias}] incoming=${incomingPending.length} outgoing=${outgoingPending.length} recipients=${recipients.length} receipts=${receipts.length}`,
        );
      if (receipts.length === 0) {
        mergeResolverResults(walletId, resultsByTransaction, isCurrent);
        commitFingerprint();
        return;
      }

      // Primary match: bolt11. Secondary: (amount_sats, created_at) with a
      // 5-minute window, which handles cached txs that predate bolt11 capture.
      type Receipt = (typeof receipts)[number];
      const byBolt11 = new Map<string, Receipt>();
      const byAmountTime: { amountSats: number; ts: number; receipt: Receipt }[] = [];
      for (const r of receipts) {
        const bolt11Tag = r.tags.find((t) => t[0] === 'bolt11');
        if (bolt11Tag?.[1]) byBolt11.set(bolt11Tag[1], r);

        // The zap request embedded in `description` carries the authoritative
        // amount (msats) — fall back to it for the (amount, time) index.
        const descTag = r.tags.find((t) => t[0] === 'description');
        let amountSats: number | null = null;
        if (descTag?.[1]) {
          try {
            const zr = JSON.parse(descTag[1]) as { tags?: string[][] };
            const amtTag = zr.tags?.find((t) => t[0] === 'amount');
            if (amtTag?.[1]) {
              const msats = parseInt(amtTag[1], 10);
              if (Number.isFinite(msats)) amountSats = Math.round(msats / 1000);
            }
          } catch {}
        }
        if (amountSats != null) byAmountTime.push({ amountSats, ts: r.created_at, receipt: r });
      }

      const TIME_WINDOW_S = 5 * 60;
      const findReceipt = (tx: WalletTransaction): Receipt | null => {
        if (tx.bolt11) {
          const hit = byBolt11.get(tx.bolt11);
          if (hit) return hit;
        }
        const txTs = tx.settled_at ?? tx.created_at ?? null;
        if (txTs == null) return null;
        const txSats = Math.abs(tx.amount);
        let best: { receipt: Receipt; dt: number } | null = null;
        for (const entry of byAmountTime) {
          if (entry.amountSats !== txSats) continue;
          const dt = Math.abs(entry.ts - txTs);
          if (dt > TIME_WINDOW_S) continue;
          if (!best || dt < best.dt) best = { receipt: entry.receipt, dt };
        }
        return best?.receipt ?? null;
      };

      // First pass: parse every receipt + collect the unique sender
      // pubkeys so we can batch-fetch their profiles in one relay round
      // trip instead of a serial per-tx `fetchProfile`.
      type ParsedEntry = {
        tx: WalletTransaction;
        senderPubkey: string | null;
        comment: string;
        anonymous: boolean;
      };
      const parsedEntries: ParsedEntry[] = [];
      const pubkeysToFetch = new Set<string>();

      for (const { tx } of incomingPending) {
        const receipt = findReceipt(tx);
        if (!receipt) {
          // Negative cache only when we had bolt11 to match with (definitive
          // miss). Otherwise leave undefined so future refreshes retry once
          // the tx has bolt11 / more receipts arrive.
          if (tx.bolt11) resultsByTransaction.set(tx, null);
          continue;
        }
        const parsed = nostrService.parseZapReceipt(receipt);
        if (!parsed) {
          if (tx.bolt11) resultsByTransaction.set(tx, null);
          continue;
        }
        parsedEntries.push({
          tx,
          senderPubkey: parsed.senderPubkey,
          comment: parsed.comment,
          anonymous: parsed.anonymous,
        });
        if (parsed.senderPubkey && !parsed.anonymous) pubkeysToFetch.add(parsed.senderPubkey);
      }

      // Persistent cache hit first — strangers' kind-0 events change
      // infrequently and the relay round-trip is the slow part of the
      // first cold-start render of TransactionList (#95). Anything served
      // from AsyncStorage skips the relay query entirely.
      const cached =
        pubkeysToFetch.size > 0
          ? await zapSenderProfileStorage.getMany([...pubkeysToFetch])
          : new Map<string, zapSenderProfileStorage.CachedZapSenderProfile>();
      const stillToFetch = [...pubkeysToFetch].filter((pk) => !cached.has(pk));

      // Batch profile fetch (relays). Returns a Map keyed by pubkey.
      const profileMap =
        stillToFetch.length > 0
          ? await nostrService.fetchProfiles(stillToFetch, queryRelays)
          : undefined;

      // Superseded mid-fetch — bail before merging stale results.
      if (isStale()) {
        releaseController();
        return;
      }

      // Write-through any newly-resolved profiles so the next cold start
      // serves them from disk.
      if (profileMap && profileMap.size > 0) {
        const toPersist = new Map<string, zapSenderProfileStorage.CachedZapSenderProfile>();
        for (const [pk, p] of profileMap) {
          toPersist.set(pk, {
            npub: p.npub,
            name: p.name,
            displayName: p.displayName,
            picture: p.picture,
            nip05: p.nip05,
          });
        }
        // Fire-and-forget — don't block UI updates on the AsyncStorage write.
        void zapSenderProfileStorage.setMany(toPersist);
      }

      const toCounterpartyProfile = (pk: string): ZapCounterpartyInfo['profile'] => {
        const hit = cached.get(pk);
        if (hit) return hit;
        const p = profileMap?.get(pk);
        if (!p) return null;
        return {
          npub: p.npub,
          name: p.name,
          displayName: p.displayName,
          picture: p.picture,
          nip05: p.nip05,
        };
      };

      for (const entry of parsedEntries) {
        resultsByTransaction.set(entry.tx, {
          pubkey: entry.senderPubkey,
          profile: entry.senderPubkey ? toCounterpartyProfile(entry.senderPubkey) : null,
          comment: entry.comment,
          anonymous: entry.anonymous,
        });
      }

      if (__DEV__) {
        const attributed = [...resultsByTransaction.values()].filter((v) => v !== null).length;
        console.log(
          `[Zap/${walletAlias}] attributed ${attributed}/${pending.length} pending tx(s)`,
        );
      }
      mergeResolverResults(walletId, resultsByTransaction, isCurrent);
      commitFingerprint();
      perfLog(
        `resolveZapSenders[${walletId.slice(0, 8)}]: done ${Date.now() - __zapResolveStart}ms (merged ${resultsByTransaction.size})`,
      );
    },
    [resolveLud16ToNostrPubkey, mergeResolverResults, captureWalletIdentity],
  );

  useEffect(() => {
    resolveZapSendersRef.current = resolveZapSendersForWallet;
  }, [resolveZapSendersForWallet]);

  // When the user's Nostr pubkey becomes available (via NostrContext
  // auto-login), run zap attribution against every wallet's cached txs.
  // This matters because `list_transactions` can be flaky on some NWC
  // relays — we shouldn't make sender attribution depend on a successful
  // refresh having happened first.
  useEffect(() => {
    const run = async () => {
      const pk = nostrService.getCurrentUserPubkey();
      if (!pk) return;
      const isCurrent = captureWalletIdentity();
      // Serialize across wallets. Running concurrent querySync calls over
      // the same nostr-tools pool races on shared subscriptions — one
      // request often comes back empty — so resolve one wallet at a time.
      for (const w of walletsRef.current) {
        if (!isCurrent()) return;
        try {
          await resolveZapSendersRef.current?.(w.id, { isCurrent });
        } catch (e) {
          console.warn(`resolveZapSenders (on-pubkey) failed for ${w.id}:`, e);
        }
      }
    };
    run();
    return nostrService.onCurrentUserPubkeyChange(run);
  }, [captureWalletIdentity]);

  const completeOnboarding = useCallback(async () => {
    await walletStorage.setOnboarded();
    setIsOnboarded(true);
  }, []);

  const makeInvoice = useCallback(
    async (amount: number, memo?: string) => {
      if (!activeWalletId) throw new Error('No active wallet');
      return nwcService.makeInvoice(activeWalletId, amount, memo);
    },
    [activeWalletId],
  );

  const payInvoice = useCallback(
    async (bolt11: string, signalOrOptions?: AbortSignal | nwcService.PayInvoiceOptions) => {
      if (!activeWalletId) throw new Error('No active wallet');
      return nwcService.payInvoice(activeWalletId, bolt11, signalOrOptions);
    },
    [activeWalletId],
  );

  const makeInvoiceForWallet = useCallback(
    async (walletId: string, amount: number, memo?: string) => {
      return nwcService.makeInvoice(walletId, amount, memo);
    },
    [],
  );

  const payInvoiceForWallet = useCallback(
    async (
      walletId: string,
      bolt11: string,
      signalOrOptions?: AbortSignal | nwcService.PayInvoiceOptions,
    ) => {
      return nwcService.payInvoice(walletId, bolt11, signalOrOptions);
    },
    [],
  );

  const getReceiveAddress = useCallback(async (walletId: string) => {
    return onchainService.getNextReceiveAddress(walletId);
  }, []);

  const clearLastIncomingPayment = useCallback(() => setLastIncomingPayment(null), []);

  // In-flight "I'm expecting a payment on this invoice" poll state.
  // Only one at a time — a new expectPayment() replaces the previous.
  // The balance-diff detector still runs independently, so even if this
  // poll is replaced before the first invoice settles, the eventual
  // balance increment will still fire the overlay.
  const expectedPaymentRef = useRef<{
    walletId: string;
    paymentHash: string;
    expectedAmountSats: number | null;
    interval: ReturnType<typeof setInterval>;
    timeout: ReturnType<typeof setTimeout>;
    // Guards against pile-up on slow backends: if tick N hasn't
    // completed by the time tick N+1 fires, we skip N+1.
    inFlight: boolean;
  } | null>(null);

  const stopExpectedPayment = useCallback(() => {
    const current = expectedPaymentRef.current;
    if (!current) return;
    clearInterval(current.interval);
    clearTimeout(current.timeout);
    expectedPaymentRef.current = null;
  }, []);

  const expectPayment = useCallback(
    (
      walletId: string,
      paymentHash: string,
      expectedAmountSats?: number,
      durationMs: number = 3 * 60 * 1000,
    ) => {
      // Replace any previous expectation — we only track one at a time.
      // The balance-diff detector still catches the displaced invoice
      // when it settles (just on a slower cadence), so we never drop
      // detection entirely; see the expectPayment JSDoc in the context
      // interface above.
      stopExpectedPayment();
      const isCurrentIdentity = captureWalletIdentity();

      let __balanceTickCounter = 0;
      const tick = async () => {
        const current = expectedPaymentRef.current;
        // Pile-up guard: if the previous tick is still in flight (slow
        // NWC backend, see #133), skip this interval firing entirely
        // rather than stacking N concurrent requests.
        if (!isCurrentIdentity()) return;
        if (!current || current.inFlight) return;
        const isCurrent = () => isCurrentIdentity() && expectedPaymentRef.current === current;
        current.inFlight = true;
        // Run getBalance on every 5th tick (≈ 5 s) rather than every
        // 1 s. With a flaky NWC relay each getBalance can block 1-3.5 s
        // (visible as the [PerfBlock] NWC.getBalance markers) and each
        // settle triggers a render of HomeScreen + WalletCarousel +
        // TransactionList. Per-second balance polls were the dominant
        // source of the 20-45 s JS-thread freezes Ben hit on the Pixel
        // (#560). lookupInvoice stays on the 1 s tick so detection
        // latency for the expected payment is unchanged.
        const runBalance = __balanceTickCounter % 5 === 0;
        __balanceTickCounter += 1;
        try {
          const [lookupResult] = await Promise.allSettled([
            // 2500 ms ceiling on lookup_invoice — without it, a slow
            // NIP-47 reply blocks the pile-up-guarded tick for ~10 s
            // and recipients see the payment land before we mark it
            // paid (#553).
            nwcService.lookupInvoice(walletId, paymentHash, { replyTimeoutMs: 2500 }),
            // Balance fetch is the generic balance-diff fallback for
            // when lookup_invoice doesn't settle in time. Gated on
            // runBalance (every 5th tick ≈ 5 s) per #560 — a per-tick
            // balance call was the dominant source of the 20-45 s
            // JS-thread freezes Ben hit on the Pixel. Same 2500 ms
            // ceiling so a stalled relay reply doesn't blow latency.
            runBalance
              ? (async () => {
                  const b = await nwcService.getBalance(walletId, { replyTimeoutMs: 2500 });
                  if (b !== null && isCurrent()) updateWalletInState(walletId, { balance: b });
                })()
              : Promise.resolve(),
          ]);
          if (
            isCurrent() &&
            lookupResult.status === 'fulfilled' &&
            lookupResult.value?.paid &&
            expectedPaymentRef.current?.paymentHash === paymentHash
          ) {
            if (__DEV__)
              console.log(
                `[Wallet] expected invoice paid (${paymentHash.slice(0, 12)}…) — stopping poll`,
              );
            // Fire with the *known* invoice amount rather than the
            // balance delta. Two invoices settling between polls would
            // show a combined delta on the generic path; the explicit
            // amount is always correct.
            if (expectedAmountSats !== undefined && expectedAmountSats > 0) {
              // Mark this hash announced so the transaction-list detector
              // doesn't also fire for the same settle when the tx lands (#653).
              let seen = seenReceiptsRef.current.get(walletId);
              if (!seen) {
                seen = new Set<string>();
                seenReceiptsRef.current.set(walletId, seen);
              }
              seen.add(paymentHash);
              setLastIncomingPayment({
                walletId,
                amountSats: expectedAmountSats,
                at: Date.now(),
                paymentHash,
                // expectPayment is invoice-poll based — only ever wired
                // up by the Lightning ReceiveSheet. On-chain receives
                // arrive via the balance-diff path below.
                source: 'lightning',
              });
            }
            stopExpectedPayment();
          }
        } finally {
          const still = expectedPaymentRef.current;
          if (still === current) still.inFlight = false;
        }
      };

      const interval = setInterval(tick, 1000);
      const timeout = setTimeout(() => {
        // Only clear if THIS expectation is still current; a newer one
        // may have replaced it already.
        if (expectedPaymentRef.current?.interval === interval) {
          if (__DEV__)
            console.log(
              `[Wallet] expected payment poll window expired (${paymentHash.slice(0, 12)}…)`,
            );
          stopExpectedPayment();
        }
      }, durationMs);

      expectedPaymentRef.current = {
        walletId,
        paymentHash,
        expectedAmountSats: expectedAmountSats ?? null,
        interval,
        timeout,
        inFlight: false,
      };
      if (__DEV__)
        console.log(
          `[Wallet] expecting payment on ${paymentHash.slice(0, 12)}… (${Math.round(durationMs / 1000)} s window, amount=${expectedAmountSats ?? '?'})`,
        );
    },
    [stopExpectedPayment, updateWalletInState, captureWalletIdentity],
  );

  // Tear down any outstanding expectation when the context unmounts —
  // leaked intervals kept polling NWC after a logout / hot-reload.
  useEffect(() => {
    const unsubscribe = walletStorage.subscribeActivePubkey(() => stopExpectedPayment());
    return () => {
      unsubscribe();
      stopExpectedPayment();
    };
  }, [stopExpectedPayment]);

  // When an incoming payment is detected, also pull the latest
  // transaction list for that wallet so the Home / Transactions screens
  // show the new tx immediately — not on the user's next manual refresh.
  // Separate effect so it reads `fetchTransactionsForWallet` after it's
  // defined below without the closure-ordering dance.
  useEffect(() => {
    if (!lastIncomingPayment) return;
    // The transaction-list detector already saw the tx in a current list, so a
    // refresh here would be a redundant list_transactions round-trip. Only the
    // expectPayment path needs it (the list may not yet include the settle).
    if (lastIncomingPayment.fromTxList) return;
    const walletId = lastIncomingPayment.walletId;
    // Defer past the interaction frame so the overlay's dismiss tap is serviced
    // before this heavy refresh runs on the JS thread (#859, #828).
    const handle = deferPostPaymentRefresh(() => fetchTransactionsForWallet(walletId));
    return () => handle.cancel();
    // Intentionally only fire on `lastIncomingPayment` changes; the
    // callback identity is stable enough across renders that adding it
    // would double-fetch on unrelated renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastIncomingPayment]);

  // Balance-change trigger. A balance increase means *something* settled, so
  // refresh the transaction list promptly — the receive detector below then
  // announces it by payment_hash. We no longer announce off the balance delta
  // itself: a flapping / stale balance re-fired the same payment (#653).
  useEffect(() => {
    const baselines = paymentBaselinesRef.current;
    const liveIds = new Set(wallets.map((w) => w.id));
    // GC per-wallet state for wallets that have been removed.
    for (const id of baselines.keys()) if (!liveIds.has(id)) baselines.delete(id);
    for (const id of seenReceiptsRef.current.keys())
      if (!liveIds.has(id)) {
        seenReceiptsRef.current.delete(id);
        AsyncStorage.removeItem(`seenReceipts_${id}`).catch(() => {});
      }

    const handles: { cancel: () => void }[] = [];
    for (const wallet of wallets) {
      const bal = wallet.balance;
      if (bal === null || bal === undefined) continue;
      const prev = baselines.get(wallet.id);
      baselines.set(wallet.id, bal);
      if (prev !== undefined && bal > prev) {
        // A balance bump is when the receive overlay pops — defer the refresh
        // off the interaction path so the dismiss tap stays responsive (#859).
        const walletId = wallet.id;
        handles.push(deferPostPaymentRefresh(() => fetchTransactionsForWallet(walletId)));
      }
    }
    return () => handles.forEach((h) => h.cancel());
    // fetchTransactionsForWallet is a stable useCallback; omitting it from deps
    // avoids re-running on unrelated renders.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallets]);

  // Build the transaction list once per wallet when it first appears in state —
  // an effect (not a synchronous call in the add paths) so it runs AFTER the
  // wallet is committed and walletsRef.current includes it; otherwise
  // fetchTransactionsForWallet early-returns on the stale ref (#725). Only fetch
  // wallets whose list wasn't hydrated from cache (freshly added → empty), so a
  // launch with cached history doesn't trigger a redundant refresh storm.
  useEffect(() => {
    for (const w of wallets) {
      if (initiallyFetchedRef.current.has(w.id)) continue;
      initiallyFetchedRef.current.add(w.id);
      if ((w.transactions?.length ?? 0) === 0) {
        void fetchTransactionsForWallet(w.id, { force: true }).catch(() => {});
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wallets]);

  // Receive detector — announces each settled incoming payment exactly once
  // across all wallets. Extracted into its own hook (WalletContext is over-cap);
  // #134 threads the on-chain/lightning `source` through it for the overlay hint.
  useIncomingReceiveAnnouncer({
    wallets,
    seenReceiptsRef,
    persistSeenReceipts,
    setLastIncomingPayment,
  });

  // Keep the active NWC wallet's balance in rough sync so the global
  // overlay pops for *any* incoming payment — not just ones the user
  // explicitly asked us to watch via expectPayment. Covers:
  //
  //   - app returns to foreground → one-shot refresh to catch anything
  //     that arrived while backgrounded.
  //   - 30 s slow poll while the app is foregrounded → catches
  //     lightning-address payments that land without an in-app
  //     invoice-generation trigger. Worst-case latency ~30 s, which
  //     is acceptable for casual address receives; the expectPayment
  //     fast poll (1 s for 3 min) takes over when the user is
  //     *actively* waiting on a specific invoice.
  //
  // On-chain has its own gentler coverage in useOnchainIncomingPoll —
  // BDK / Electrum sync is too expensive for this 30 s cadence. True
  // background / app-closed delivery still needs OS push (#45).
  // Track the active wallet's connection state as an explicit dep so
  // the poll starts/stops when a wallet reconnects without the active
  // id changing. (Previous version only re-ran on `activeWalletId`
  // change and could leave the poll running against a disconnected
  // wallet — flagged in PR #135 review.) We still avoid putting the
  // full `wallets` array in deps, which would thrash on every balance
  // tick.
  const activeWalletConnected =
    activeWallet?.walletType !== 'onchain' && activeWallet?.isConnected === true;

  // Demand-counter for the 30 s balance poll. Incremented by
  // `requestBalancePoll()` callers (typically balance-displaying screens
  // inside `useFocusEffect`) and decremented by their returned cleanup.
  // The poll effect below gates on `balancePollDemand > 0` so we only
  // pay the NWC round-trip + downstream render cost when at least one
  // surface is actively showing the balance. See #569.
  const [balancePollDemand, setBalancePollDemand] = useState(0);

  const requestBalancePoll = useCallback<WalletContextType['requestBalancePoll']>(() => {
    setBalancePollDemand((d) => d + 1);
    let released = false;
    return () => {
      // Idempotent on repeat-release so a defensive double-cleanup in
      // an unmount path can't drag the counter below zero.
      if (released) return;
      released = true;
      setBalancePollDemand((d) => Math.max(0, d - 1));
    };
  }, []);

  useEffect(() => {
    if (!activeWalletId || !activeWalletConnected) return;
    // No focused surface needs the balance right now — skip the
    // interval setup entirely. Re-runs when demand transitions 0 → 1
    // (focus event in a balance-displaying screen).
    if (balancePollDemand <= 0) return;

    // singleFlight drops a tick whose predecessor is still awaiting; replyTimeoutMs caps each to a single 8 s attempt (#650).
    let disposed = false;
    const pollBalance = singleFlight(async () => {
      const isIdentityCurrent = captureWalletIdentity();
      const isCurrent = () => !disposed && isIdentityCurrent();
      if (!isCurrent()) return;
      const b = await nwcService.getBalance(activeWalletId, { replyTimeoutMs: 8000 });
      if (b !== null && isCurrent()) updateWalletInState(activeWalletId, { balance: b });
    });
    const refreshOnce = () => {
      // Bail if the wallet has since disconnected — we read through
      // `walletsRef` rather than the closure so this is current.
      const current = walletsRef.current.find((w) => w.id === activeWalletId);
      if (!current || !current.isConnected || current.walletType === 'onchain') return;
      // Skip a parked (dead/timing-out) relay so a refresh can't re-arm the
      // churn the cooldown is trying to suppress (#656).
      if (nwcService.isRelayInCooldown(activeWalletId)) return;
      pollBalance().catch(() => {});
    };

    // Event-driven (#657): refresh on focus (this effect re-runs when a balance
    // surface gains focus, via balancePollDemand) and on app-foreground — NOT on
    // a constant interval. Receive *detection* is transaction-hash-based now
    // (#653), so the old "poll to catch LUD-16 receives" rationale is gone, and
    // the constant 10 s poll was the dominant relay load that rate-limited
    // self-hosted relays. Unsolicited address receives surface on next focus /
    // foreground (sends + the Receive-sheet expectPayment poll cover the rest).
    if (AppState.currentState === 'active') refreshOnce();
    const sub = AppState.addEventListener('change', (next) => {
      if (next === 'active') refreshOnce();
    });
    return () => {
      disposed = true;
      sub.remove();
    };
  }, [
    activeWalletId,
    activeWalletConnected,
    updateWalletInState,
    balancePollDemand,
    captureWalletIdentity,
  ]);

  // On-chain incoming-payment coverage (#134). Extracted into its own
  // hook so this over-cap context doesn't grow — see
  // useOnchainIncomingPoll for the full rationale (gentle 2-min cadence,
  // foreground-resume one-shot, all-wallet sweep). It refreshes on-chain
  // balances, which trips the same balance-diff receive detector above.
  useOnchainIncomingPoll({
    wallets,
    walletsRef,
    updateWalletInState,
    captureIdentity: captureWalletIdentity,
  });

  // Stable context value — without `useMemo` here the inline `{{...}}`
  // literal produced a fresh object identity on every render of
  // `WalletProvider`, so every consumer of `useWallet()` re-rendered
  // whenever any internal state moved (the 30 s connection check, the
  // 30 s balance poll, or the 1 s `expectPayment` tick during a Receive
  // flow). Cascade hit every open sheet / TextInput, dropping in-flight
  // keystrokes and snapping cursor position to end. See #243.
  const contextValue = useMemo(
    () => ({
      wallets,
      activeWalletId,
      activeWallet,
      hasWallets,
      isOnboarded,
      isLoading,
      walletsHydrated,
      currency,
      setCurrency,
      addNwcWallet,
      addOnchainWallet,
      addHotWallet,
      removeWallet,
      updateWalletSettings,
      reorderWallet,
      setActiveWallet,
      refreshActiveBalance,
      completeOnboarding,
      makeInvoice,
      payInvoice,
      makeInvoiceForWallet,
      payInvoiceForWallet,
      refreshBalanceForWallet,
      deferSwapRefresh,
      fetchTransactionsForWallet,
      addPendingTransaction,
      getReceiveAddress,
      expectPayment,
      requestBalancePoll,
      isConnected,
      balance,
      walletAlias,
    }),
    // `activeWallet`, `hasWallets`, `isConnected`, `balance`, `walletAlias`
    // are all derived from `wallets` (+ `activeWalletId`), so listing
    // `wallets` is enough — the derived values get fresh references when
    // wallets changes and the memo invalidates correctly. See PR #244.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      wallets,
      activeWalletId,
      isOnboarded,
      isLoading,
      walletsHydrated,
      currency,
      setCurrency,
      addNwcWallet,
      addOnchainWallet,
      addHotWallet,
      removeWallet,
      updateWalletSettings,
      reorderWallet,
      setActiveWallet,
      refreshActiveBalance,
      completeOnboarding,
      makeInvoice,
      payInvoice,
      makeInvoiceForWallet,
      payInvoiceForWallet,
      refreshBalanceForWallet,
      deferSwapRefresh,
      fetchTransactionsForWallet,
      addPendingTransaction,
      getReceiveAddress,
      expectPayment,
      requestBalancePoll,
    ],
  );

  // Sibling value carrying the high-frequency price/receive slices (#801).
  // Memoised separately so a fiat-price poll or a settled receive rebuilds only
  // this — not `contextValue` — and only `useWalletLive()` consumers re-render.
  const walletLiveValue = useMemo(
    () => ({ btcPrice, lastIncomingPayment, clearLastIncomingPayment }),
    [btcPrice, lastIncomingPayment, clearLastIncomingPayment],
  );

  return (
    <WalletContext.Provider value={contextValue}>
      <WalletLiveContext.Provider value={walletLiveValue}>{children}</WalletLiveContext.Provider>
    </WalletContext.Provider>
  );
};

export function useWallet() {
  const context = useContext(WalletContext);
  if (!context) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return context;
}
