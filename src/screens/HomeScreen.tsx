import BrandedRefreshControl from '../components/BrandedRefreshControl';
import BrandedSpinner from '../components/BrandedSpinner';
import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Pressable,
  ScrollView,
  InteractionManager,
} from 'react-native';
import { useNavigation, useRoute, RouteProp, useFocusEffect } from '@react-navigation/native';
import type { BottomTabNavigationProp } from '@react-navigation/bottom-tabs';
import { useWallet, useWalletLive } from '../contexts/WalletContext';
import { useNostr } from '../contexts/NostrContext';
import { Wallet } from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import WarmTransactionLists from '../components/WarmTransactionLists';
import HomeSheets from '../components/HomeSheets';
import type { HomeSheetActions } from '../hooks/useHomeSheetState';
import WalletCarousel from '../components/WalletCarousel';
import WalletHeaderBackdrop from '../components/WalletHeaderBackdrop';
import WelcomeWalletPrompt from '../components/WelcomeWalletPrompt';
import TabHeader from '../components/TabHeader';
import NotificationBell from '../components/NotificationBell';
import { ArrowDownIcon, ArrowUpIcon, ArrowLeftRightIcon } from '../components/icons/ArrowIcons';
import { createHomeScreenStyles } from '../styles/HomeScreen.styles';
import { selectHomeWalletState } from '../utils/homeWalletState';
import { perfLog } from '../utils/perfLog';
import { noteWalletListCommitted } from '../utils/walletSwipeTiming';
import { useActiveWalletRefresh } from '../hooks/useActiveWalletRefresh';
import { useWidgetLaunch } from '../hooks/useWidgetLaunch';
import { useNotificationDefaults } from '../hooks/useNotificationDefaults';
import { useKeyBackupReminder } from '../hooks/useKeyBackupReminder';
import KeyBackupBanner from '../components/KeyBackupBanner';
import { Toast } from '../components/BrandedToast';
import { WALLET_FRESH_MS } from '../utils/walletRefreshScheduler';
import type { WalletState } from '../types/wallet';
import * as swapRecoveryService from '../services/swapRecoveryService';
import type { AccountDrawerNavigation, MainTabParamList } from '../navigation/types';

// How often swiping to an on-chain card may trigger its (heavy) BDK sync.
const ONCHAIN_SWIPE_FRESH_MS = 5 * 60_000;

const HomeScreen: React.FC = () => {
  useNotificationDefaults();
  const colors = useThemeColors();
  const t = useTranslation();
  // First-render marker: fires once per mount when the first commit lands. Used by scripts/perf-startup.sh to measure tap-to-render latency for tab-wallets.
  const homeRenderLoggedRef = useRef(false);
  useEffect(() => {
    if (homeRenderLoggedRef.current) return;
    homeRenderLoggedRef.current = true;
    console.log(`[Perf] HomeScreen first render`);
  }, []);
  const styles = useMemo(() => createHomeScreenStyles(colors), [colors]);
  const {
    wallets,
    activeWalletId,
    walletsHydrated,
    refreshBalanceForWallet,
    fetchTransactionsForWallet,
    setActiveWallet,
    currency,
    requestBalancePoll,
    retryWalletLoad,
  } = useWallet();
  const {
    activeWallet,
    hasWallets,
    showWelcome,
    isReceiveDisabled,
    isSendDisabled,
    isSendWatchOnly,
    isTransferDisabled,
    dimActions,
  } = selectHomeWalletState(wallets, activeWalletId, walletsHydrated);
  const { btcPrice } = useWalletLive();
  const { isLoggedIn, profile, refreshProfile } = useNostr();
  const navigation = useNavigation<BottomTabNavigationProp<MainTabParamList, 'Home'>>();
  const drawerNavigation = useNavigation<AccountDrawerNavigation>();
  // Weekly key-backup reminder (#1546): schedules the notifications and, with
  // notifications off, drives the in-app banner below.
  const keyBackup = useKeyBackupReminder();
  const keyBackupPubkey = keyBackup.pubkey;
  const openKeyBackup = useCallback(() => {
    if (keyBackupPubkey) drawerNavigation.navigate('AccountKeyBackup', { pubkey: keyBackupPubkey });
  }, [drawerNavigation, keyBackupPubkey]);
  const route = useRoute<RouteProp<MainTabParamList, 'Home'>>();

  const sheetsRef = useRef<HomeSheetActions>(null);
  // True while the carousel's trailing "Add wallet" card is the active page, so
  // the tx list shows an add-wallet prompt instead of the pinned wallet's
  // history (#666). Kept separate from activeWalletId, which #166 deliberately
  // pins to the last real wallet on the add card to keep Send/Receive usable.
  const [addCardActive, setAddCardActive] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  // Refresh the own-profile kind-0 on focus so the top-right profile
  // icon picks up external renames (e.g. via Amber or another client).
  // The call is cache-respecting: if the 24h kind-0 cache is still
  // fresh it short-circuits without hitting relays, so switching tabs
  // doesn't incur a network cost. Pull-to-refresh in MessagesScreen
  // passes `{ force: true }` for the explicit-user-intent path.
  useFocusEffect(
    useCallback(() => {
      if (!isLoggedIn) return;
      // Defer to after the tab-transition animation finishes — same
      // rationale as Friends/Messages: refreshProfile can hold the JS
      // thread briefly while it walks the profile cache and (on miss)
      // hits a relay, and running it during the focus callback
      // synchronously makes the tab feel laggy.
      const handle = InteractionManager.runAfterInteractions(() => refreshProfile());
      return () => handle.cancel();
    }, [isLoggedIn, refreshProfile]),
  );

  // Drive the 30 s NWC balance poll only while Home is focused — see
  // #569. The poll lives in WalletContext but is now demand-gated: this
  // screen signals "the balance is on screen, keep refreshing it" on
  // focus, and the cleanup signals "I no longer need it" on blur. The
  // initial in-effect `refreshOnce()` inside WalletContext means the
  // balance refreshes immediately on return to Home rather than waiting
  // up to 30 s for the next tick.
  useFocusEffect(
    useCallback(() => {
      const release = requestBalancePoll();
      return release;
    }, [requestBalancePoll]),
  );

  // Handle sendToAddress from navigation params (e.g., from Friends tab zap)
  useEffect(() => {
    if (route.params?.sendToAddress) {
      sheetsRef.current?.openSend({
        address: route.params.sendToAddress,
        picture: route.params.sendToPicture,
        pubkey: route.params.sendToPubkey,
        name: route.params.sendToName,
      });
      navigation.setParams({
        sendToAddress: undefined,
        sendToPicture: undefined,
        sendToPubkey: undefined,
        sendToName: undefined,
      });
    }
  }, [
    route.params?.sendToAddress,
    route.params?.sendToPicture,
    route.params?.sendToPubkey,
    route.params?.sendToName,
    navigation,
  ]);

  // Home-screen widget buttons (#1849): select the widget's wallet once the
  // wallets have loaded, then open Receive / Send / Scan on it.
  const clearWidgetParams = useCallback(
    () =>
      navigation.setParams({
        widgetAction: undefined,
        widgetWalletId: undefined,
        widgetNonce: undefined,
      }),
    [navigation],
  );
  useWidgetLaunch({
    action: route.params?.widgetAction,
    walletId: route.params?.widgetWalletId,
    nonce: route.params?.widgetNonce,
    wallets,
    activeWalletId,
    walletsHydrated,
    setActiveWallet,
    sheetsRef,
    clearParams: clearWidgetParams,
    watchOnlyMessage: t('homeScreen.watchOnlySend'),
  });

  // Hold the latest wallets + balance refresher in refs so `fetchWallet` stays
  // stable without taking the constantly-churning `wallets` as a dependency.
  const walletsRef = useRef(wallets);
  const refreshBalanceForWalletRef = useRef(refreshBalanceForWallet);
  useEffect(() => {
    walletsRef.current = wallets;
    refreshBalanceForWalletRef.current = refreshBalanceForWallet;
  }, [wallets, refreshBalanceForWallet]);

  // Refresh one wallet; resolves whether its transaction list loaded. On-chain
  // `fetchTransactionsForWallet` already syncs the balance in the same pass, so
  // only NWC wallets need the separate balance read (which also re-probes a
  // dropped NWC connection). `force` (pull-to-refresh) bypasses the
  // zap-resolver's fingerprint skip for a full attribution pass (#526).
  const fetchWallet = useCallback(
    async (walletId: string, opts: { force: boolean }): Promise<boolean> => {
      const wallet = walletsRef.current.find((w) => w.id === walletId);
      if (wallet?.walletType === 'onchain') {
        return fetchTransactionsForWallet(walletId, opts);
      }
      const [, loaded] = await Promise.all([
        refreshBalanceForWalletRef.current(walletId).catch(() => {}),
        fetchTransactionsForWallet(walletId, opts),
      ]);
      return loaded;
    },
    [fetchTransactionsForWallet],
  );

  const isWalletAvailable =
    activeWallet?.walletType === 'onchain' ? true : (activeWallet?.isConnected ?? false);

  // Transactions from the active wallet (owned by WalletContext). Every
  // wallet's list is hydrated from its per-wallet cache at launch and kept in
  // memory, so a newly active card renders its own rows in the same commit.
  // `useActiveWalletRefresh` refreshes it in the background (~300 ms after the
  // card settles, skipped if it loaded recently, retried after a failure) and
  // then warms the neighbouring cards so the next swipe is current too (#1304).
  const transactions = activeWallet?.transactions ?? [];
  const getNeighbours = useCallback((walletId: string) => {
    const list = walletsRef.current;
    const i = list.findIndex((w) => w.id === walletId);
    if (i < 0) return [];
    // Right first (the likelier next swipe), then left. NWC only: an on-chain
    // refresh is a BDK sync that holds the JS thread for seconds, which would
    // stall the very swipe it's meant to speed up.
    return [list[i + 1], list[i - 1]]
      .filter((w): w is WalletState => w?.walletType === 'nwc')
      .map((w) => w.id);
  }, []);
  // On-chain refreshes are that same heavy sync: refresh them on swipe at most
  // every 5 min (pull-to-refresh still forces one).
  const freshMsFor = useCallback(
    (walletId: string) =>
      walletsRef.current.find((w) => w.id === walletId)?.walletType === 'onchain'
        ? ONCHAIN_SWIPE_FRESH_MS
        : WALLET_FRESH_MS,
    [],
  );
  const { isLoading, isFetching, refreshNow } = useActiveWalletRefresh({
    activeWalletId,
    available: isWalletAvailable,
    fetchWallet,
    getNeighbours,
    freshMsFor,
  });

  // Full spinner only while an empty wallet's first load is due or running —
  // never an empty state while fetching. A wallet with cached rows keeps showing
  // them, with a small indicator only while fresh data is actually fetching.
  const loadingTransactions = isLoading && transactions.length === 0;

  // Read the active wallet through a ref so `handleRefresh` (and with it the
  // RefreshControl element every warm list shares) keeps its identity across
  // swipes; a new element per swipe would re-render every warm list (#1304).
  const activeWalletIdRef = useRef(activeWalletId);
  activeWalletIdRef.current = activeWalletId;
  const handleRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      // Also retry any pending Boltz swap claims — recovery otherwise only runs
      // at app startup, so a swap parked mid-session (e.g. an ambiguous pay that
      // resolved later) would stay unclaimed until a full restart. Fire-and-
      // forget; the single-flight guard dedupes against a startup pass.
      swapRecoveryService.recoverPendingSwaps().catch((e) => {
        console.warn('[Home] pull-to-refresh swap recovery failed:', e);
      });
      // A cold-start wallet load that failed is retried here too (#1746);
      // a no-op once the wallets loaded.
      await retryWalletLoad();
      // Explicit pull-to-refresh: force a fetch, ignoring the 30 s freshness.
      const walletId = activeWalletIdRef.current;
      if (walletId) await refreshNow(walletId);
    } finally {
      // A rejected refresh must never strand the pull-to-refresh spinner.
      setRefreshing(false);
    }
  }, [refreshNow, retryWalletLoad]);

  // Stable RefreshControl ELEMENT. Passing a fresh element on every render
  // made the (Pure) FlatList inside TransactionList re-render on every Home
  // commit — and FlatList re-wraps renderItem when it re-renders, which
  // re-executed every visible row (#1014). Memoised, it only changes when
  // the spinner state genuinely flips.
  const homeRefreshControl = useMemo(
    () => <BrandedRefreshControl refreshing={refreshing} onRefresh={handleRefresh} />,
    [refreshing, handleRefresh],
  );

  const handleWalletChange = useCallback(
    (walletId: string | null) => {
      if (walletId !== activeWalletId) {
        setActiveWallet(walletId);
      }
    },
    [activeWalletId, setActiveWallet],
  );

  const handleSettingsPress = useCallback((walletId: string) => {
    sheetsRef.current?.openSettings(walletId);
  }, []);

  const greetingName = profile?.displayName?.trim() || profile?.name?.trim() || 'Satoshi';

  // Actions, carousel and warm transaction lists all read `wallets` from this
  // commit. Never retain a previous identity's cards to mask a hydration gap.
  // Use Pressable below: TouchableOpacity owns a native animated opacity that
  // can stay faded independently of `disabled` after an interrupted press or
  // style transition. Press feedback here changes scale, never opacity.

  // Render the (virtualized) TransactionList only on the real-wallet branch:
  // a wallet is selected, we're not on the carousel's "Add wallet" card, and
  // the first-load spinner has finished. The other branches stay in a
  // ScrollView (see below) so pull-to-refresh still works on empty states.
  const showTransactionList =
    hasWallets &&
    !addCardActive &&
    activeWalletId !== null &&
    !(loadingTransactions && transactions.length === 0);

  // Swipe-latency probe (#1304): which wallet's list this commit shows.
  useEffect(() => {
    noteWalletListCommitted(showTransactionList ? activeWalletId : null);
  }, [showTransactionList, activeWalletId]);

  return (
    <View style={styles.container}>
      {/* Header area with brand background + faded pig behind carousel */}
      <View style={styles.headerBackground}>
        <WalletHeaderBackdrop />

        <TabHeader
          title={t('homeScreen.greeting', { name: greetingName })}
          // Keep Home's greeting at its pre-#139 lighter weight + smaller
          // size; section titles (Messages/Friends/Learn) stay bolder to
          // read as section labels.
          titleStyle={{ fontSize: 22, fontWeight: '400' }}
          icon={<Wallet size={20} color={colors.brandPink} />}
          rightAccessory={<NotificationBell />}
        />

        <WalletCarousel
          wallets={wallets}
          activeWalletId={activeWalletId}
          btcPrice={btcPrice}
          currency={currency}
          onWalletChange={handleWalletChange}
          onAddWallet={() => sheetsRef.current?.openWizard()}
          onSettingsPress={handleSettingsPress}
          onAddCardActiveChange={setAddCardActive}
        />

        {/* Send/Receive/Transfer buttons */}
        <View style={styles.buttonRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: isReceiveDisabled }}
            style={({ pressed }) => [
              styles.actionButton,
              dimActions && styles.actionButtonDisabled,
              pressed && styles.actionButtonPressed,
            ]}
            onPress={() => {
              perfLog('btn-receive onPress');
              sheetsRef.current?.openReceive();
            }}
            disabled={isReceiveDisabled}
            accessibilityLabel={t('homeScreen.receive')}
            testID="btn-receive"
          >
            <View style={styles.actionCircle}>
              <ArrowDownIcon size={24} strokeWidth={3} />
            </View>
            <Text style={styles.actionText}>{t('homeScreen.receive')}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: isTransferDisabled }}
            style={({ pressed }) => [
              styles.actionButton,
              dimActions && styles.actionButtonDisabled,
              pressed && styles.actionButtonPressed,
            ]}
            onPress={() => sheetsRef.current?.openTransfer()}
            disabled={isTransferDisabled}
            accessibilityLabel={t('homeScreen.transfer')}
            testID="btn-transfer"
          >
            <View style={styles.actionCircle}>
              <ArrowLeftRightIcon size={24} strokeWidth={3} />
            </View>
            <Text style={styles.actionText}>{t('homeScreen.transfer')}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ disabled: isSendDisabled }}
            accessibilityHint={isSendWatchOnly ? t('homeScreen.watchOnlySend') : undefined}
            style={({ pressed }) => [
              styles.actionButton,
              dimActions && styles.actionButtonDisabled,
              pressed && styles.actionButtonPressed,
            ]}
            onPress={() => {
              perfLog('btn-send onPress');
              if (isSendWatchOnly) {
                Toast.show({ type: 'info', text1: t('homeScreen.watchOnlySend'), position: 'top' });
                return;
              }
              sheetsRef.current?.openSend();
            }}
            disabled={isSendDisabled}
            accessibilityLabel={t('homeScreen.send')}
            testID="btn-send"
          >
            <View style={styles.actionCircle}>
              <ArrowUpIcon size={24} strokeWidth={3} />
            </View>
            <Text style={styles.actionText}>{t('homeScreen.send')}</Text>
          </Pressable>
        </View>
      </View>

      {/* Transaction lists. Each warm list renders TransactionList's FlatList
          directly as the scroller (passing the RefreshControl through), so the
          list virtualizes properly. The non-list branches (welcome / add-wallet
          / first-load spinner) stay in a ScrollView so pull-to-refresh keeps
          working on them too. */}
      <View style={styles.transactionsWrapper}>
        {keyBackup.visible ? (
          <KeyBackupBanner onOpen={openKeyBackup} onDismiss={keyBackup.dismiss} />
        ) : null}
        {/* One list per warm wallet (active + neighbours), kept mounted so a
            swipe reveals already-rendered rows (#1304). Hidden, not unmounted,
            while an empty / add-wallet / first-load state shows instead. */}
        <WarmTransactionLists
          wallets={wallets}
          activeWalletId={hasWallets ? activeWalletId : null}
          visible={showTransactionList}
          currency={currency}
          refreshControl={homeRefreshControl}
        />
        {showTransactionList ? null : (
          <ScrollView style={styles.transactionsContainer} refreshControl={homeRefreshControl}>
            {showWelcome ? (
              <WelcomeWalletPrompt onGetStarted={() => sheetsRef.current?.openWizard()} />
            ) : hasWallets && (addCardActive || activeWalletId === null) ? (
              // On the "Add wallet" card (or no active wallet) show an add-wallet
              // prompt rather than the previous wallet's transactions (#666).
              <View style={styles.emptyState}>
                <TouchableOpacity
                  onPress={() => sheetsRef.current?.openWizard()}
                  accessibilityRole="button"
                  accessibilityLabel={t('homeScreen.addWallet')}
                  testID="home-add-wallet-empty"
                >
                  <Text style={styles.addWalletText}>{t('homeScreen.addWalletText')}</Text>
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.emptyState}>
                {!refreshing && <BrandedSpinner size="small" testID="home-tx-loading" />}
              </View>
            )}
          </ScrollView>
        )}
        {showTransactionList && isFetching && !refreshing && transactions.length > 0 ? (
          // Background refresh of a wallet that already shows cached rows (#1304).
          <View
            style={styles.refreshingIndicator}
            pointerEvents="none"
            accessibilityLabel={t('homeScreen.updatingTransactions')}
            testID="home-tx-refreshing"
          >
            <BrandedSpinner size="small" />
          </View>
        ) : null}
      </View>

      <HomeSheets ref={sheetsRef} />
    </View>
  );
};

// React.Profiler wrapper to surface render-commit costs as
// [PerfBlock] log lines. Threshold-gated to ≥ 100 ms (the user-perceived
// jank floor) so the log doesn't drown on healthy frames. The id arg
// is the screen name so multi-screen Profiler output is greppable as
// [PerfBlock] render:<screen>. Pre-fix the silent 20-45 s freezes in
// #560 had no React-side instrumentation, so render-storm cost from
// the 596-contact setContacts dispatch was completely invisible.
const ProfiledHomeScreen: React.FC = () => (
  <React.Profiler
    id="HomeScreen"
    onRender={(id, phase, actualDuration) => {
      if (actualDuration > 100) {
        console.log(`[PerfBlock] render:${id} ${phase}=${Math.round(actualDuration)}ms`);
      }
    }}
  >
    <HomeScreen />
  </React.Profiler>
);

export default ProfiledHomeScreen;
