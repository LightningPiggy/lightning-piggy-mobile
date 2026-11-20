import BrandedSpinner from './BrandedSpinner';
/**
 * BoltzReceiveSheet — issue #92.
 *
 * Receive on-chain Bitcoin into a Lightning (NWC) wallet via a Boltz
 * forward submarine swap. The external sender pays the displayed BIP-21
 * lockup address; Boltz then pays the user's Lightning invoice.
 *
 * This is the symmetric counterpart of the existing reverse-swap path
 * (LN → on-chain) used by `TransferSheet`. The forward submarine flow is
 * the same one TransferSheet already uses internally for the user's own
 * "on-chain wallet → LN wallet" transfer — but here the on-chain payer
 * is *external*, so the sheet's job is to:
 *   1. Generate an LN invoice on the user's NWC wallet for `amountSats`.
 *   2. Hand it to Boltz to create a submarine swap.
 *   3. Display Boltz's lockup address as a BIP-21 QR for the sender.
 *   4. Watch the swap's status and update the UI through 4 buckets:
 *      awaiting-payment / detected / paying-invoice / complete | failed.
 *   5. On `failed`, surface a Refund button that broadcasts a refund tx
 *      to a fresh address from the user's first available on-chain
 *      wallet (matches the pattern in TransferSheet's onchain-to-LN
 *      branch). The swap is also persisted to SecureStore so
 *      `swapRecoveryService` can finish the refund on next launch if the
 *      app dies mid-swap.
 *
 * Refund-handling design (the most important call) — see PR description
 * for full rationale; the short version is: persist `submarine_swap_<id>`
 * (refund private key + script tree) so that if the app dies mid-swap,
 * `swapRecoveryService.recoverPendingSwaps()` picks it up on next launch
 * and invokes the registered submarine refund handler
 * (`recoverSubmarineRefund` → `promptSubmarineRefund`), which surfaces a
 * branded prompt to broadcast the refund. Without that persistence, a
 * missed refund window on a dropped foreground task means permanent loss.
 * (We also stash a `refundDestinationAddress` snapshot for logging/future
 * use; the recovery handler derives its own fresh address at refund time.)
 */

import React, { useEffect, useState, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Pressable,
  Share,
  BackHandler,
  Keyboard,
  Platform,
} from 'react-native';
import {
  BottomSheetBackdrop,
  BottomSheetBackdropProps,
  BottomSheetView,
} from '@gorhom/bottom-sheet';
import { BottomSheetModal } from './AccessibleBottomSheetModal';
import { ChevronLeft, Copy, Share2, Check, AlertTriangle } from 'lucide-react-native';
import ScannableQr from './ScannableQr';
import * as Clipboard from 'expo-clipboard';
import * as SecureStore from 'expo-secure-store';
import Toast from './BrandedToast';
import { useWallet, useWalletLive } from '../contexts/WalletContext';
import { useThemeColors } from '../contexts/ThemeContext';
import { useLocale } from '../contexts/LocaleContext';
import { walletLabel } from '../types/wallet';
import { createBoltzReceiveSheetStyles } from '../styles/BoltzReceiveSheet.styles';
import { satsToFiat, formatFiat } from '../services/fiatService';
import AmountEntryScreen from './AmountEntryScreen';
import * as boltzService from '../services/boltzService';
import * as swapRecoveryService from '../services/swapRecoveryService';
import * as onchainService from '../services/onchainService';
import { getActivePubkey, getDefaultOnchainWalletId } from '../services/walletStorageService';
import { buildSwapPlaceholders, markSwapPlaceholdersResolved } from '../utils/swapPendingMerge';
import { blockEta } from '../utils/blockEta';
import { useReceiveSwapFees } from '../utils/useReceiveSwapFees';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** The NWC wallet that will receive the Lightning side of the swap. */
  walletId: string | null;
}

type Step = 'amount' | 'qr';

const BoltzReceiveSheet: React.FC<Props> = ({ visible, onClose, walletId }) => {
  const colors = useThemeColors();
  const { t, formatLocale } = useLocale();
  const styles = useMemo(() => createBoltzReceiveSheetStyles(colors), [colors]);
  const {
    wallets,
    makeInvoiceForWallet,
    refreshBalanceForWallet,
    fetchTransactionsForWallet,
    addPendingTransaction,
    currency,
  } = useWallet();
  const { btcPrice } = useWalletLive();

  const wallet = useMemo(() => wallets.find((w) => w.id === walletId) ?? null, [wallets, walletId]);

  const [step, setStep] = useState<Step>('amount');
  const [amountSats, setAmountSats] = useState(0);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // Swap state — populated after createSubmarineSwapForward returns.
  const [swap, setSwap] = useState<boltzService.SubmarineSwapResult | null>(null);
  // Current block height, for a real "expires in about …" estimate — the
  // timeout depends on the swap server (Boltz ~24h, custom backends ~1 week).
  const [tipHeight, setTipHeight] = useState<number | null>(null);
  useEffect(() => {
    if (!swap) return;
    let cancelled = false;
    onchainService
      .getBlockHeight()
      .then((h) => {
        if (!cancelled) setTipHeight(h);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [swap]);
  const etaLabel = useCallback(
    (blocks: number) => {
      const { unit, count } = blockEta(blocks);
      if (unit === 'hours')
        return count === 1 ? t('boltzReceive.etaHour') : t('boltzReceive.etaHours', { count });
      return count === 1 ? t('boltzReceive.etaDay') : t('boltzReceive.etaDays', { count });
    },
    [t],
  );
  const [phase, setPhase] = useState<boltzService.SubmarineSwapPhase>('awaiting-payment');
  const [refunding, setRefunding] = useState(false);
  const [refundedTxId, setRefundedTxId] = useState<string | null>(null);

  // Boltz fee schedule — fetched on open so we can render min/max + the
  // expected service fee, and re-fetched on confirm if that first try failed.
  const { fees, ensureFees, adopt: adoptFees } = useReceiveSwapFees(visible);

  // Track the bottom-sheet ref so we can present/dismiss imperatively.
  const bottomSheetRef = useRef<BottomSheetModal>(null);
  // Session token guards stale callbacks when the user closes + reopens.
  const sessionRef = useRef(0);
  // Swap id whose pending Home row has been added — one row per swap.
  const placeholderSwapIdRef = useRef<string | null>(null);

  // A swap "flow" is in flight once we leave the amount step to create the
  // swap and until it's explicitly closed (creating the LN invoice / Boltz
  // swap, or a live swap awaiting/processing the on-chain payment). While
  // this is true the lockup-QR + status view MUST stay mounted — see
  // `handleSheetChange` / `enablePanDownToClose` below for why (#92).
  const swapInFlight = creating || swap !== null;
  // Mirror into a ref so the (stable) sheet-change callback always reads the
  // current value without being re-created on every render. `handleConfirmAmount`
  // also sets this synchronously *before* its state updates so there's no
  // render-timing window where the sheet-change callback reads a stale `false`
  // mid-create (#92).
  const swapInFlightRef = useRef(false);
  swapInFlightRef.current = swapInFlight;

  // Track soft-keyboard visibility. A keyboard show/hide resize can momentarily
  // collapse a dynamically-sized gorhom sheet to snap index -1 — e.g. a residual
  // keyboard from the previously-open sheet animating away as this one presents.
  // That collapse must NOT be mistaken for a deliberate dismiss (see
  // `handleSheetChange`). Seeded from the live keyboard state because the
  // keyboard may already be up when this sheet mounts (its `keyboardDidShow`
  // having fired before our listener attached).
  const keyboardVisibleRef = useRef(Keyboard.isVisible());
  useEffect(() => {
    keyboardVisibleRef.current = Keyboard.isVisible();
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, () => {
      keyboardVisibleRef.current = true;
    });
    const hideSub = Keyboard.addListener(hideEvent, () => {
      keyboardVisibleRef.current = false;
    });
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // Reset / present the sheet when `visible` flips. Mirrors ReceiveSheet.
  useEffect(() => {
    if (visible) {
      sessionRef.current += 1;
      setStep('amount');
      setAmountSats(0);
      setCreating(false);
      setCreateError(null);
      setSwap(null);
      setPhase('awaiting-payment');
      setRefunding(false);
      setRefundedTxId(null);
      bottomSheetRef.current?.present();
    } else {
      bottomSheetRef.current?.dismiss();
    }
  }, [visible]);

  // Android back: behave like the ReceiveSheet — closes the sheet.
  // When a swap is in flight, the close handler already shows the
  // "hands off, swap is in progress" guard via the user-side cancel UI;
  // back is just an alias for the user pressing Close.
  useEffect(() => {
    if (!visible) return;
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => handler.remove();
  }, [visible, onClose]);

  // Subscribe to swap status changes once the swap exists. Status drives
  // the visible phase + triggers post-success balance refresh.
  useEffect(() => {
    if (!swap) return;
    const session = sessionRef.current;
    const cleanup = { cancelled: false };
    // Real teardown handle: aborting this stops the underlying Boltz
    // WebSocket/poller immediately on close/unmount, instead of leaving it
    // running in the background (network + battery) until the terminal status
    // or the 24h timeout. The `cancelled` flag alone only muted the callbacks.
    const controller = new AbortController();

    boltzService
      .watchSubmarineSwapStatus(
        swap.id,
        (next, raw) => {
          if (cleanup.cancelled || sessionRef.current !== session) return;
          console.log(`[BoltzReceive] phase ${next} (raw=${raw})`);
          setPhase(next);
          // Once the sender's on-chain payment is seen, show an incoming
          // "Boltz swap in progress" row so the swap stays visible on Home
          // after the sheet closes. Not added earlier: an address nobody pays
          // must not leave a phantom row. Superseded by the tagged Lightning
          // leg (recorded at creation) or dropped once resolved.
          if (
            (next === 'detected' || next === 'paying-invoice') &&
            walletId &&
            placeholderSwapIdRef.current !== swap.id
          ) {
            placeholderSwapIdRef.current = swap.id;
            const { incoming } = buildSwapPlaceholders({
              swapId: swap.id,
              swapType: 'submarine',
              sentSats: swap.expectedAmount,
              receivedSats: amountSats,
              nowSeconds: Math.floor(Date.now() / 1000),
            });
            addPendingTransaction(walletId, incoming);
          }
        },
        // External-sender swap — they may take a while to actually
        // broadcast. 24h is well within the Boltz timeout (currently
        // ~144 blocks ≈ 24h on mainnet) and matches the lockup window.
        24 * 60 * 60 * 1000,
        controller.signal,
      )
      .then(async (result) => {
        if (cleanup.cancelled || sessionRef.current !== session) return;
        // Final outcome known: the placeholder row goes on the next refresh.
        if (result.phase === 'complete' || result.phase === 'failed') {
          markSwapPlaceholdersResolved(swap.id);
        }
        // A failed swap's Lightning leg never arrives, so nothing else would
        // trigger that refresh — request it here (complete refreshes below).
        if (result.phase === 'failed' && walletId) {
          fetchTransactionsForWallet(walletId).catch(() => {});
        }
        if (result.phase === 'complete') {
          // Refresh the wallet balance + list so the user sees the credit
          // (and the settled row replaces the placeholder) immediately.
          if (walletId) {
            try {
              await Promise.all([
                refreshBalanceForWallet(walletId),
                fetchTransactionsForWallet(walletId),
              ]);
            } catch {}
          }
          await SecureStore.deleteItemAsync(`submarine_swap_${swap.id}`);
          await swapRecoveryService.unregisterPendingSubmarineSwap(swap.id);
          Toast.show({
            type: 'success',
            text1: t('boltzReceive.swapCompleteToastTitle'),
            text2: t('boltzReceive.swapCompleteToastBody', {
              amount: swap.expectedAmount.toLocaleString(formatLocale),
              wallet: wallet ? walletLabel(wallet) : t('boltzReceive.yourWallet'),
            }),
            position: 'top',
            visibilityTime: 8000,
          });
        }
        // `failed` is handled by the Refund button in the render path —
        // we deliberately do *not* auto-broadcast here. The user might
        // be on the move and not have a stable Electrum connection;
        // they can hit Refund on their own time within the timeout
        // window, and `swapRecoveryService` is the safety net if they
        // close the app first.
      })
      .catch((e) => {
        // AbortError is the expected outcome when the sheet closes/unmounts
        // mid-swap (we abort the controller below) — swallow it silently.
        if (cleanup.cancelled || sessionRef.current !== session) return;
        if ((e as Error)?.name === 'AbortError') return;
        console.warn('[BoltzReceive] watchSubmarineSwapStatus errored:', e);
      });

    return () => {
      cleanup.cancelled = true;
      // Tear the WS/poller down for real, not just mute its callbacks.
      controller.abort();
    };
    // walletId/wallet/refreshBalance are read for the success branch —
    // re-running this effect on every wallet refresh would tear down + re-
    // open the WS subscription which is expensive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [swap, formatLocale]);

  /**
   * Find a fresh receive address from any of the user's on-chain wallets,
   * to use as the refund destination snapshot persisted alongside the swap.
   * (The recovery handler derives its own fresh address at refund time, so
   * this is captured mainly for logging / diagnostics.)
   * Returns null if the user has no on-chain wallet at all — the swap is
   * still allowed (Boltz support can recover funds in that case) but the
   * user gets a warning.
   */
  const pickRefundDestination = useCallback(async (): Promise<{
    address: string;
    walletId: string;
  } | null> => {
    // Honour the user's chosen default first; fall back to the first
    // on-chain wallet if the default is unset / no longer exists. The default
    // ID is only a hint, so treat an AsyncStorage read failure (full disk /
    // corruption) as "no default" (null) rather than letting it break
    // refund-destination selection — the first-on-chain fallback below still
    // applies.
    let defaultId: string | null = null;
    try {
      defaultId = await getDefaultOnchainWalletId();
    } catch (e) {
      console.warn('[BoltzReceive] Failed to read default on-chain wallet id', e);
    }
    const onchainWallets = wallets.filter((w) => w.walletType === 'onchain');
    const onchainWallet =
      onchainWallets.find((w) => w.id === defaultId) ?? onchainWallets[0] ?? null;
    if (!onchainWallet) return null;
    try {
      return {
        address: await onchainService.getNextReceiveAddress(onchainWallet.id),
        walletId: onchainWallet.id,
      };
    } catch (e) {
      console.warn('[BoltzReceive] Failed to fetch refund address:', e);
      return null;
    }
  }, [wallets]);

  const handleConfirmAmount = useCallback(
    async (sats: number) => {
      if (!walletId || !wallet) return;
      // Capture the initiating identity before any async work, so an identity
      // switch mid-create can't re-attribute this swap's refund (#1124).
      const ownerPubkey = getActivePubkey() ?? undefined;
      // The sheet can be closed (Android back) and reopened mid-create. This
      // flow still finishes the swap it started (persisted for recovery), but
      // must not write into the new session's UI — e.g. a stale fee result's
      // `finally` clearing a newer confirmation's in-flight state.
      const session = sessionRef.current;
      const isCurrent = () => sessionRef.current === session;
      // Mark the flow in-flight *synchronously*, before the state updates below
      // schedule a re-render. `swapInFlightRef` is otherwise refreshed only
      // during render, so without this there's a brief window where a stray
      // gorhom collapse to -1 (keyboard/resize timing) would be read as "not in
      // flight" and dismiss the sheet mid-create, losing the lockup QR (#92).
      swapInFlightRef.current = true;
      setAmountSats(sats);
      setStep('qr');
      setCreating(true);
      setCreateError(null);

      try {
        // Step 0 — a fee schedule. If the one fetched on open failed, try
        // again now rather than replaying that error (offline → back online).
        const quote = await ensureFees();
        if ('stale' in quote) return;
        if ('errorKey' in quote) {
          if (isCurrent()) setCreateError(t(quote.errorKey));
          return;
        }

        // Step 1 — make an LN invoice on the destination NWC wallet for
        // exactly the requested amount. Boltz takes its fee from the
        // *on-chain* side (so the sender pays slightly more than `sats`),
        // but the LN invoice they pay is the bare amount.
        const invoice = await makeInvoiceForWallet(walletId, sats, t('boltzReceive.invoiceMemo'));

        // Step 2 — create the swap with Boltz.
        const created = await boltzService.createSubmarineSwapForward(invoice, sats, quote.fees);

        // Step 3 — pre-fetch a refund destination snapshot from one of the
        // user's on-chain wallets. If none exists, warn the user: recovery
        // can only reclaim funds when there's an on-chain wallet to refund
        // into (the recovery handler needs one to build the refund tx).
        const refundDestination = await pickRefundDestination();
        if (!refundDestination) {
          Toast.show({
            type: 'info',
            text1: t('boltzReceive.noOnchainToastTitle'),
            text2: t('boltzReceive.noOnchainToastBody'),
            position: 'top',
            visibilityTime: 9000,
          });
        }

        // Step 4 — persist *full* swap state under the same key prefix
        // TransferSheet uses (`submarine_swap_<id>`) so swapRecoveryService
        // picks it up. Includes refundDestination when available.
        await SecureStore.setItemAsync(
          `submarine_swap_${created.id}`,
          JSON.stringify({
            id: created.id,
            address: created.address,
            expectedAmount: created.expectedAmount,
            refundPrivateKey: created.refundPrivateKey,
            claimPublicKey: created.claimPublicKey,
            timeoutBlockHeight: created.timeoutBlockHeight,
            swapTree: created.swapTree,
            refundDestinationAddress: refundDestination?.address,
            sourceWalletId: refundDestination?.walletId,
            // Refunds only ever land in the creating identity's wallets (#1124).
            ownerPubkey,
            createdAt: Date.now(),
          }),
          // Device-only accessibility so the refundPrivateKey in this record
          // is never included in iCloud/Android backups or device migration —
          // matches TransferSheet's submarine-swap persistence.
          { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY },
        );
        await swapRecoveryService.registerPendingSubmarineSwap(created.id);
        // Tag the incoming Lightning leg so it badges as a Boltz swap and
        // replaces the pending row even if the sheet is closed first (#895).
        await swapRecoveryService.recordSubmarineSwapLegs(null, invoice, created.id);

        if (!isCurrent()) return;
        setSwap(created);
        setPhase('awaiting-payment');
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn('[BoltzReceive] Swap creation failed:', msg);
        if (!isCurrent()) return;
        if (boltzService.isQuoteChangedError(e)) adoptFees(e.quote);
        setCreateError(msg);
      } finally {
        if (isCurrent()) setCreating(false);
      }
    },
    [walletId, wallet, makeInvoiceForWallet, pickRefundDestination, t, ensureFees, adoptFees],
  );

  const handleRefund = useCallback(async () => {
    if (!swap) return;
    setRefunding(true);
    try {
      const lockup = await boltzService.getSubmarineSwapLockup(swap.id, swap.address);
      if (!lockup) {
        Toast.show({
          type: 'error',
          text1: t('boltzReceive.nothingToRefundTitle'),
          text2: t('boltzReceive.nothingToRefundBody'),
          position: 'top',
          visibilityTime: 8000,
        });
        return;
      }
      const dest = await pickRefundDestination();
      if (!dest) {
        Toast.show({
          type: 'error',
          text1: t('boltzReceive.addOnchainFirstTitle'),
          text2: t('boltzReceive.addOnchainFirstBody'),
          position: 'top',
          visibilityTime: 9000,
        });
        return;
      }
      const refundTxId = await boltzService.refundSwap(swap, lockup, dest.address);
      setRefundedTxId(refundTxId);
      Toast.show({
        type: 'success',
        text1: t('boltzReceive.refundBroadcastTitle'),
        text2: t('boltzReceive.refundBroadcastBody', {
          amount: lockup.amount.toLocaleString(formatLocale),
          txid: refundTxId.slice(0, 10),
        }),
        position: 'top',
        visibilityTime: 10000,
      });
      await SecureStore.deleteItemAsync(`submarine_swap_${swap.id}`);
      await swapRecoveryService.unregisterPendingSubmarineSwap(swap.id);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.warn('[BoltzReceive] Refund failed:', msg);
      Toast.show({
        type: 'error',
        text1: t('boltzReceive.refundFailedTitle'),
        text2: msg,
        position: 'top',
        visibilityTime: 10000,
      });
    } finally {
      setRefunding(false);
    }
  }, [swap, pickRefundDestination, t, formatLocale]);

  const bip21Uri = swap ? boltzService.buildBoltzBip21Uri(swap.address, swap.expectedAmount) : '';
  const fee = swap ? swap.expectedAmount - amountSats : 0;

  const handleCopy = useCallback(async () => {
    if (bip21Uri) await Clipboard.setStringAsync(bip21Uri);
  }, [bip21Uri]);

  const handleShare = useCallback(async () => {
    if (!bip21Uri) return;
    try {
      await Share.share({ message: bip21Uri });
    } catch {}
  }, [bip21Uri]);

  const handleSheetChange = useCallback(
    (index: number) => {
      // Close ONLY on a deliberate, user-initiated collapse. Two incidental
      // sources of `index === -1` must be ignored, or the sheet unmounts
      // (`if (!visible) return null`) and the external sender loses the lockup
      // address they still need to pay (#92):
      //   1. A swap in flight — the create round-trip, or a live swap awaiting/
      //      processing the on-chain payment. Guarded via `swapInFlightRef`,
      //      which `handleConfirmAmount` now sets synchronously so there's no
      //      render-timing window right after the user confirms an amount.
      //   2. A soft-keyboard show/hide resize — dynamic content sizing can
      //      momentarily collapse the sheet to -1 while the keyboard (or a
      //      residual one from the previously-open sheet) animates. This is the
      //      "closes on open" race on the amount step, where no swap exists yet.
      // Deliberate closes go through the explicit Back/Cancel/Done/Close
      // controls (which call `onClose` directly) or a genuine pan-down/backdrop
      // tap taken while neither guard is active.
      if (index === -1 && !swapInFlightRef.current && !keyboardVisibleRef.current) {
        onClose();
      }
    },
    [onClose],
  );

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        // While a swap is in flight, lock the backdrop so a tap can't dismiss
        // the sheet to -1 and strand the sender without the lockup QR/payment
        // request — same guarantee `enablePanDownToClose={!swapInFlight}`
        // gives against swipe/keyboard collapse (#92).
        pressBehavior={swapInFlight ? 'none' : 'close'}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
      />
    ),
    [swapInFlight],
  );

  if (!visible) return null;

  // ── Phase-driven status copy ────────────────────────────────────────────
  // Single source of truth for what the swap-status block says under the
  // QR. Each branch mirrors a `SubmarineSwapPhase` from boltzService.
  let statusLabel = '';
  let statusVariant: 'default' | 'success' | 'error' = 'default';
  switch (phase) {
    case 'awaiting-payment':
      statusLabel = t('boltzReceive.statusAwaitingPayment');
      break;
    case 'detected':
      // `detected` covers both `transaction.mempool` and
      // `transaction.confirmed`, so the copy must stay accurate whether or
      // not the lockup has already confirmed — hence no "waiting for
      // confirmations" wording here.
      statusLabel = t('boltzReceive.statusDetected');
      break;
    case 'paying-invoice':
      statusLabel = t('boltzReceive.statusPayingInvoice');
      break;
    case 'complete':
      statusLabel = t('boltzReceive.statusComplete');
      statusVariant = 'success';
      break;
    case 'failed':
      statusLabel = t('boltzReceive.statusFailed');
      statusVariant = 'error';
      break;
    default:
      statusLabel = t('boltzReceive.statusUnknown');
  }

  return (
    <BottomSheetModal
      ref={bottomSheetRef}
      onChange={handleSheetChange}
      // Swipe-to-dismiss only while on the amount step (or a create error).
      // Once a swap flow is in flight the sheet must not be swipe- or
      // keyboard-collapsible — removing -1 as a reachable snap keeps the
      // lockup-QR + status view up until the user explicitly closes it (#92).
      enablePanDownToClose={!swapInFlight}
      backdropComponent={renderBackdrop}
      handleIndicatorStyle={styles.handleIndicator}
      backgroundStyle={styles.sheetBackground}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
    >
      <BottomSheetView style={styles.content}>
        {step === 'amount' ? (
          // Reuse the same numpad screen as ReceiveSheet — gives us free
          // fiat/sats unit toggle and Boltz min/max enforcement.
          <AmountEntryScreen
            initialSats={amountSats}
            title={t('boltzReceive.amountTitle')}
            confirmLabel={t('boltzReceive.generateQr')}
            minSats={fees?.minAmount ?? boltzService.BOLTZ_MIN_SATS}
            maxSats={fees?.maxAmount ?? boltzService.BOLTZ_MAX_SATS}
            onBack={() => onClose()}
            onConfirm={(sats) => handleConfirmAmount(sats)}
          />
        ) : (
          <View style={styles.innerContent}>
            <Text style={styles.title}>{t('boltzReceive.title')}</Text>
            {wallet ? (
              <Text style={styles.walletLabel}>
                {t('boltzReceive.toWallet', { label: walletLabel(wallet) })}
              </Text>
            ) : null}

            {creating ? (
              <View style={styles.loadingBlock}>
                <BrandedSpinner size="large" />
                <Text style={styles.subtitle}>{t('boltzReceive.creating')}</Text>
              </View>
            ) : createError ? (
              <View style={styles.loadingBlock}>
                <Text style={styles.errorText}>{createError}</Text>
                <TouchableOpacity
                  style={styles.actionButton}
                  onPress={() => setStep('amount')}
                  accessibilityLabel={t('boltzReceive.tryAgain')}
                  testID="boltz-receive-retry"
                >
                  <ChevronLeft size={18} color={colors.brandPink} />
                  <Text style={styles.actionButtonText}>{t('boltzReceive.back')}</Text>
                </TouchableOpacity>
              </View>
            ) : swap ? (
              <>
                <View style={styles.qrContainer}>
                  <ScannableQr value={bip21Uri} size={200} />
                </View>

                <View style={styles.amountRow}>
                  <Text style={styles.amountValue}>
                    {swap.expectedAmount.toLocaleString(formatLocale)}
                  </Text>
                  <Text style={styles.amountUnit}>SATS</Text>
                </View>
                {btcPrice ? (
                  <Text style={styles.amountFiat}>
                    {t('boltzReceive.approx', {
                      amount: formatFiat(
                        satsToFiat(swap.expectedAmount, btcPrice),
                        currency,
                        formatLocale,
                      ),
                    })}
                  </Text>
                ) : null}

                <Text style={styles.addressLabel}>
                  <Text style={styles.addressHighlight}>{swap.address.slice(0, 6)}</Text>
                  {swap.address.slice(6, -6)}
                  <Text style={styles.addressHighlight}>{swap.address.slice(-6)}</Text>
                </Text>

                <View style={styles.feeBreakdown}>
                  <View style={styles.feeRow}>
                    <Text style={styles.feeLabel}>{t('boltzReceive.youReceiveLightning')}</Text>
                    <Text style={styles.feeValue}>
                      {t('boltzReceive.sats', { amount: amountSats.toLocaleString(formatLocale) })}
                    </Text>
                  </View>
                  <View style={styles.feeRow}>
                    <Text style={styles.feeLabel}>{t('boltzReceive.senderPaysOnchain')}</Text>
                    <Text style={styles.feeValue}>
                      {t('boltzReceive.sats', {
                        amount: swap.expectedAmount.toLocaleString(formatLocale),
                      })}
                    </Text>
                  </View>
                  <View style={styles.feeRow}>
                    <Text style={styles.feeLabel}>{t('boltzReceive.boltzFee')}</Text>
                    <Text style={styles.feeValue}>
                      {t('boltzReceive.sats', { amount: fee.toLocaleString(formatLocale) })}
                    </Text>
                  </View>
                </View>

                <View
                  style={[
                    styles.statusBlock,
                    statusVariant === 'success' && styles.statusBlockSuccess,
                    statusVariant === 'error' && styles.statusBlockError,
                  ]}
                  accessibilityLabel={t('boltzReceive.statusA11y', { status: statusLabel })}
                  testID="boltz-receive-status"
                >
                  {statusVariant === 'success' ? (
                    <Check size={18} color={colors.white} />
                  ) : statusVariant === 'error' ? (
                    <AlertTriangle size={18} color={colors.red} />
                  ) : (
                    <BrandedSpinner size="small" />
                  )}
                  <Text
                    style={[
                      styles.statusText,
                      statusVariant === 'success' && styles.statusTextSuccess,
                    ]}
                  >
                    {statusLabel}
                  </Text>
                </View>

                {swap.timeoutBlockHeight > 0 ? (
                  <Text style={styles.timeoutNote}>
                    {tipHeight !== null && tipHeight < swap.timeoutBlockHeight
                      ? t('boltzReceive.timeoutNote', {
                          height: swap.timeoutBlockHeight,
                          eta: etaLabel(swap.timeoutBlockHeight - tipHeight),
                        })
                      : t('boltzReceive.timeoutNoteNoEta', { height: swap.timeoutBlockHeight })}
                  </Text>
                ) : null}

                <View style={styles.buttonRow}>
                  <TouchableOpacity
                    style={[styles.actionButton, !bip21Uri && styles.actionButtonDisabled]}
                    onPress={handleCopy}
                    disabled={!bip21Uri}
                    accessibilityLabel={t('boltzReceive.copyRequest')}
                    testID="boltz-receive-copy"
                  >
                    <Copy size={20} color={colors.brandPink} />
                    <Text style={styles.actionButtonText}>{t('boltzReceive.copy')}</Text>
                  </TouchableOpacity>
                  <TouchableOpacity
                    style={[styles.actionButton, !bip21Uri && styles.actionButtonDisabled]}
                    onPress={handleShare}
                    disabled={!bip21Uri}
                    accessibilityLabel={t('boltzReceive.shareRequest')}
                    testID="boltz-receive-share"
                  >
                    <Text style={styles.actionButtonText}>{t('boltzReceive.share')}</Text>
                    <Share2 size={20} color={colors.brandPink} />
                  </TouchableOpacity>
                </View>

                {phase === 'failed' && !refundedTxId ? (
                  <Pressable
                    style={({ pressed }) => [
                      styles.refundButton,
                      pressed && { opacity: 0.7 },
                      refunding && styles.actionButtonDisabled,
                    ]}
                    onPress={handleRefund}
                    disabled={refunding}
                    accessibilityLabel={t('boltzReceive.refundA11y')}
                    testID="boltz-receive-refund"
                  >
                    {refunding ? (
                      <BrandedSpinner />
                    ) : (
                      <Text style={styles.refundButtonText}>{t('boltzReceive.refundButton')}</Text>
                    )}
                  </Pressable>
                ) : null}

                {refundedTxId ? (
                  <Text style={styles.timeoutNote}>
                    {t('boltzReceive.refundTxNote', { txid: refundedTxId.slice(0, 16) })}
                  </Text>
                ) : null}

                {/* Phase-aware close affordance. While a swap is in
                 *  progress (anything past awaiting-payment that's not
                 *  terminal), the language shifts to "hands off — swap
                 *  is in progress" so the user understands that closing
                 *  the sheet doesn't cancel anything; the background
                 *  task + swapRecoveryService will see it through. */}
                <TouchableOpacity
                  style={[styles.actionButton, { alignSelf: 'stretch' }]}
                  onPress={onClose}
                  accessibilityLabel={t('boltzReceive.close')}
                  testID="boltz-receive-close"
                >
                  <Text style={styles.actionButtonText}>
                    {phase === 'complete'
                      ? t('boltzReceive.done')
                      : phase === 'awaiting-payment'
                        ? t('boltzReceive.cancel')
                        : t('boltzReceive.closeSwapContinues')}
                  </Text>
                </TouchableOpacity>
              </>
            ) : null}
          </View>
        )}
      </BottomSheetView>
    </BottomSheetModal>
  );
};

export default BoltzReceiveSheet;
