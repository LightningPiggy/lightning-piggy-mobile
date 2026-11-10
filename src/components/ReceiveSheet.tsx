import { useReceiveFriendShare } from '../hooks/useReceiveFriendShare';
import { useOnchainReceiveAddress } from '../hooks/useOnchainReceiveAddress';
import BrandedSpinner from './BrandedSpinner';
import React, { useEffect, useLayoutEffect, useState, useRef, useCallback, useMemo } from 'react';
import { View, Text, TouchableOpacity, Pressable, Share, BackHandler } from 'react-native';
import {
  BottomSheetBackdrop,
  BottomSheetBackdropProps,
  BottomSheetView,
} from '@gorhom/bottom-sheet';
import { BottomSheetModal } from './AccessibleBottomSheetModal';
import { ChevronUp, ChevronDown, Copy, Share2, Send } from 'lucide-react-native';
import ReceivePaymentQr from './ReceivePaymentQr';
import * as Clipboard from 'expo-clipboard';
import ReceiveClaimScanner from './ReceiveClaimScanner';
import Toast from './BrandedToast';
import { buildBip21 } from '../utils/bip21';
import { paymentHashFromBolt11 } from '../utils/bolt11';
import { useWallet, useWalletLive } from '../contexts/WalletContext';
import { useThemeColors } from '../contexts/ThemeContext';
import { useLocale } from '../contexts/LocaleContext';
import { walletLabel } from '../types/wallet';
import { createReceiveSheetStyles } from '../styles/ReceiveSheet.styles';
import { satsToFiat, formatFiat } from '../services/fiatService';
import AmountEntryScreen from './AmountEntryScreen';
import FriendPickerSheet, { PickedFriend } from './FriendPickerSheet';
import BoltzReceiveSheet from './BoltzReceiveSheet';
import type { DmProtocol } from '../utils/dmProtocol';
import type { MarmotUnreachableReason } from '../services/marmotFallback';
import { isStaleReceipt } from '../utils/incomingReceipts';

// On-chain address fetching is done via WalletContext.getReceiveAddress

interface Props {
  visible: boolean;
  onClose: () => void;
  // When set, the sheet skips the friend-picker step and DMs the generated
  // invoice (or lightning address) directly to this friend. Used when the
  // sheet is opened from inside a conversation — the friend is implicit.
  presetFriend?: PickedFriend;
  // Thread protocol for a send to `presetFriend` (a Marmot thread keeps the
  // invoice inside its MLS group). Other friends get the NIP-17 default.
  presetProtocol?: DmProtocol;
  // Group-equivalent of `presetFriend`: the sheet jumps to amount entry
  // and the eventual payload is posted to the named group via
  // `onSendToGroup` instead of DM'd to a single peer. Should be mutually
  // exclusive with `presetFriend` — call sites pass one or the other,
  // never both. If both are accidentally supplied, `presetGroup` wins
  // (see `handleSendToFriend`'s precedence ordering).
  // `onSendToGroup` is required whenever `presetGroup` is set; without
  // it the Send button stays disabled (it would otherwise silently
  // no-op on press).
  presetGroup?: { name: string };
  onSendToGroup?: (payload: string) => Promise<{ success: boolean; error?: string }>;
  // Fired after a successful DM send with the exact text that was sent.
  // The conversation view uses this to append the outgoing message
  // locally, since the Nostr subscription only sees inbound events.
  onSent?: (payload: string) => void;
  // A `presetProtocol: 'marmot'` send the peer can't receive: the
  // conversation asks before re-sending it over NIP-17 (and paints its own
  // bubble). Resolves false when the user cancels — nothing was sent.
  onMarmotUnreachable?: (reason: MarmotUnreachableReason, payload: string) => Promise<boolean>;
}

type Mode = 'address' | 'amount';
type Step = 'main' | 'amount';

const ReceiveSheet: React.FC<Props> = ({
  visible,
  onClose,
  presetFriend,
  presetProtocol,
  presetGroup,
  onSendToGroup,
  onSent,
  onMarmotUnreachable,
}) => {
  const colors = useThemeColors();
  const { t, formatLocale } = useLocale();
  const styles = useMemo(() => createReceiveSheetStyles(colors), [colors]);
  const {
    makeInvoiceForWallet,
    refreshBalanceForWallet,
    activeWalletId,
    wallets,
    currency,
    getReceiveAddress,
    expectPayment,
  } = useWallet();
  const { btcPrice, lastIncomingPayment } = useWalletLive();
  const [capturedWalletId, setCapturedWalletId] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [mode, setMode] = useState<Mode>('address');
  const [invoice, setInvoice] = useState('');
  const [paymentReceived, setPaymentReceived] = useState(false);
  const [loading, setLoading] = useState(false);
  const [satsValue, setSatsValue] = useState('');
  // Optional invoice memo — only collected via the in-conversation
  // Invoice flow (#211), where AmountEntryScreen renders the memo
  // input. Empty string everywhere else; the standalone Receive flow
  // never writes here.
  const [memoValue, setMemoValue] = useState('');
  const [step, setStep] = useState<Step>('main');
  const [friendPickerOpen, setFriendPickerOpen] = useState(false);
  const [sendingToFriend, setSendingToFriend] = useState(false);
  // On-chain → Lightning via Boltz forward submarine swap (issue #92).
  // Only ever opens for an LN (NWC) wallet — gated by `isOnchainWallet`
  // checks at the render call site below.
  const [boltzReceiveOpen, setBoltzReceiveOpen] = useState(false);
  const bottomSheetRef = useRef<BottomSheetModal>(null);
  // The sheet stays mounted across opens (HomeSheets retains it), so an async
  // on-chain address / invoice can resolve after a close + reopen or a wallet
  // switch. Open, close and wallet switch each bump this token; a result is
  // applied only if the token it was requested under is still current, so a
  // late wallet-A response can never overwrite wallet B's QR. The bumps land
  // before any request callback can observe the transition: open/close in a
  // layout effect (still inside the commit), a dropdown switch in its handler.
  const sessionTokenRef = useRef(0);
  const {
    address: onchainAddress,
    failed: onchainAddressFailed,
    request: requestOnchainAddress,
    reset: resetOnchainAddress,
    retry: retryOnchainAddress,
  } = useOnchainReceiveAddress(getReceiveAddress, sessionTokenRef);
  // Session + wallet the current view was initialised for, so the open effect
  // and the wallet effect it triggers issue ONE address request between them.
  const initialisedViewRef = useRef<{ token: number; key: string } | null>(null);

  // No explicit snapPoints — gorhom v5's default enableDynamicSizing=true
  // gives a single content-height snap (not user-draggable).

  const selectedWalletId = capturedWalletId ?? activeWalletId;
  const selectedWallet = useMemo(
    () => wallets.find((w) => w.id === selectedWalletId) ?? null,
    [wallets, selectedWalletId],
  );
  const walletName = selectedWallet
    ? walletLabel(selectedWallet)
    : t('receiveSheet.walletFallback');
  // List all wallets in the picker rather than gating on `isConnected` —
  // receiving doesn't need a live connection (an on-chain wallet always has an
  // address, and most NWC wallets mint an invoice on demand). If a chosen
  // wallet genuinely can't produce one (e.g. a read-only NWC without
  // `make_invoice`), that surfaces as an error at generate time — which is
  // better than silently hiding it and locking the invoice to the active
  // wallet, where the user couldn't choose where funds landed at all.
  const receivableWallets = wallets;
  // Lightning Address is a per-wallet field (#169). Each NWC wallet can
  // carry its own lud16 (either parsed from the NWC URL or set manually
  // in Wallet Settings) — the Receive flow must read the *selected*
  // wallet's address, not a global one that may route payments to the
  // wrong inbox.
  const lightningAddress = selectedWallet?.lightningAddress ?? null;

  const generateInvoice = useCallback(
    async (sats: number, memo?: string) => {
      const token = sessionTokenRef.current;
      setLoading(true);
      setPaymentReceived(false);
      try {
        const wId = capturedWalletId;
        if (!wId) return;
        // Default memo "Sent with Lightning Piggy" is preserved for the
        // standalone Receive flow; the in-conversation Invoice flow (#211)
        // passes a user-typed memo through, which lands in the bolt11
        // `description` field and renders on the recipient's INVOICE
        // bubble.
        const inv = await makeInvoiceForWallet(
          wId,
          sats,
          memo?.trim() || t('receiveSheet.defaultMemo'),
        );
        // Closed/reopened or switched wallet meanwhile: never shown, never paid.
        if (sessionTokenRef.current !== token) return;
        setInvoice(inv);

        // Hand the invoice off to WalletContext.expectPayment, which
        // runs a 1 s lookup_invoice + balance poll for the next 3 min.
        // The poll lives in the context (not this sheet), so it keeps
        // running even if the user closes the receive sheet and wanders
        // off to Friends / Home etc. — the app-root overlay still pops
        // on settle regardless of which screen is active. Passing the
        // expected amount means the overlay shows the exact invoice
        // value rather than a balance-delta that could include prior
        // settles piled up between polls.
        const paymentHash = paymentHashFromBolt11(inv);
        if (paymentHash) {
          expectPayment(wId, paymentHash, sats);
        } else {
          // Unparseable bolt11 — fall back to a single balance refresh.
          // The WalletContext 30 s baseline poll still picks the
          // settle up eventually if the user lingers in-app.
          await refreshBalanceForWallet(wId);
        }
      } catch (error) {
        // Surface the failure rather than silently leaving the user on
        // a "Generating…" spinner. Common cases that hit this branch:
        //   - NWC wallet's relay is unreachable (`ensureConnected`
        //     resolved to a stale provider that throws on first call)
        //   - The remote wallet doesn't support `make_invoice` (e.g.
        //     a read-only NWC connection)
        // In the in-conversation Invoice flow (#211) the user is
        // mid-task ("send Emily a 5 k sat invoice"), so dropping them
        // back to the amount-entry step gives them a chance to retry
        // or cancel out, instead of stranding them on an empty QR
        // panel with no error.
        if (__DEV__) console.warn('Failed to create invoice:', error);
        if (sessionTokenRef.current !== token) return;
        const message = error instanceof Error ? error.message : String(error ?? 'Unknown error');
        Toast.show({
          type: 'error',
          text1: t('receiveSheet.invoiceGenerateFailed'),
          text2: message.slice(0, 120),
          position: 'top',
          visibilityTime: 4000,
        });
        setStep('amount');
      } finally {
        // A stale request must not clear a newer request's spinner; the
        // open / wallet-switch resets already cleared its own.
        if (sessionTokenRef.current === token) setLoading(false);
      }
    },
    [makeInvoiceForWallet, refreshBalanceForWallet, capturedWalletId, expectPayment, t],
  );

  const isOnchainWallet = selectedWallet?.walletType === 'onchain';

  // Single source of truth for the initial step+mode the sheet should
  // land on for a given wallet. Used both on first open AND on
  // wallet-dropdown switch — keeping them in sync prevents the
  // "switching dropdown lands on Custom amount unexpectedly" bug
  // (#450) where the two effects could disagree.
  const pickInitialView = useCallback(
    (wallet: typeof selectedWallet): { step: Step; mode: Mode } => {
      if (wallet?.walletType === 'onchain') {
        return { step: 'main', mode: 'address' };
      }
      if (presetGroup) {
        // "Send invoice to group" entry point: skip straight to amount
        // entry — the group flow needs an amount-bound bolt11 invoice
        // (sharing a static lud16 to a group has no useful "pay me"
        // semantics), so the main receive/address view is unusable.
        return { step: 'amount', mode: 'amount' };
      }
      if (presetFriend) {
        // The 1:1 DM flow deliberately does NOT skip the main view: it
        // lands there like the Home receive sheet does, so the "To:"
        // wallet picker is visible BEFORE the user commits to an
        // amount, and the lightning address can be sent as-is (an
        // amount-less request). Previously it jumped straight to
        // amount entry, which hid which wallet the invoice would pay
        // into. Only skip when there is genuinely nothing to show or
        // choose: exactly one RESOLVED wallet and it has no lightning
        // address. (=== 1, not <= 1: WalletContext initialises
        // `wallets` to [] before hydration, and an empty list must not
        // skip the main view for a user who has several wallets once
        // hydrated. Requiring `wallet` non-null covers the cold-start
        // render where `wallets` is populated but `activeWalletId`
        // hasn't hydrated yet — a null wallet must not be treated as
        // "no lightning address".)
        if (wallet && !wallet.lightningAddress && wallets.length === 1) {
          return { step: 'amount', mode: 'amount' };
        }
        return { step: 'main', mode: 'address' };
      }
      if (!wallet?.lightningAddress) {
        // No per-wallet LN address (#168/#169). Nothing useful to show
        // on the main view — jump directly to amount entry instead of
        // surfacing "Enter an amount to generate invoice" placeholder.
        return { step: 'amount', mode: 'amount' };
      }
      return { step: 'main', mode: 'address' };
    },
    [presetFriend, presetGroup, wallets],
  );

  // Reset the per-wallet view and request the on-chain address. Shared by the
  // open and wallet-switch effects, and runs once per session token + wallet:
  // the open sets capturedWalletId, which re-fires the wallet effect for the
  // same wallet — a second request (or reset) there would discard the first
  // request's result and could itself fail.
  const initWalletView = (walletId: string | null, wallet: typeof selectedWallet) => {
    const token = sessionTokenRef.current;
    const key = `${walletId}:${wallet?.walletType ?? ''}`;
    const done = initialisedViewRef.current;
    if (done?.token === token && done.key === key) return;
    initialisedViewRef.current = { token, key };
    resetOnchainAddress();
    setInvoice('');
    setPaymentReceived(false);
    setLoading(false);
    setSatsValue('');
    setMemoValue('');
    const next = pickInitialView(wallet);
    setStep(next.step);
    setMode(next.mode);
    if (wallet?.walletType === 'onchain' && walletId) requestOnchainAddress(walletId);
  };

  // Invalidate the previous open's requests inside the open/close commit.
  // Declared before the open effect; layout effects all run before it.
  useLayoutEffect(() => {
    sessionTokenRef.current += 1;
  }, [visible]);

  // Open/close the sheet — intentionally depends only on `visible`.
  // `balance` and `lightningAddress` are read for initialisation, not as reactive triggers.
  useEffect(() => {
    if (visible) {
      setCapturedWalletId(activeWalletId);
      setDropdownOpen(false);
      // Baseline is set from the first observed balance (see effect
      // below), not from the cached value here — the cache may be stale
      // if the app has been backgrounded and a previous invoice settled
      // while we weren't polling.
      initWalletView(activeWalletId, wallets.find((w) => w.id === activeWalletId) ?? null);

      bottomSheetRef.current?.present();
    } else {
      bottomSheetRef.current?.dismiss();
    }
    // Poll lives in WalletContext.expectPayment — it survives sheet
    // closure (so the user can generate an invoice, close the sheet,
    // navigate elsewhere, and still get the celebration).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Handle Android back button
  useEffect(() => {
    if (!visible) return;
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => handler.remove();
  }, [visible, onClose]);

  // Reset state when wallet is changed via dropdown. Mirrors the
  // first-open effect's pickInitialView heuristic — keeping both paths
  // in sync prevents the "switching dropdown lands on Custom amount
  // unexpectedly" bug (#450). Keyed on walletType (not just id) so
  // type-flips (lightning ↔ on-chain) always re-derive the default
  // step + mode rather than carrying state from the previous wallet.
  // The dropdown handler has already bumped the session token.
  useEffect(() => {
    if (!visible || !capturedWalletId) return;
    initWalletView(capturedWalletId, selectedWallet);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturedWalletId, selectedWallet?.walletType]);

  // The "paymentReceived" checkmark on the QR thumbnail flips to true
  // whenever the app-root overlay fires for the wallet this sheet is
  // currently showing. We used to duplicate the baseline-detector
  // logic locally — pointlessly, since WalletContext already owns it.
  // Keyed on the event timestamp so a second receive within the same
  // sheet session still re-arms the checkmark after the user dismisses
  // the global overlay and clears `lastIncomingPayment`.
  useEffect(() => {
    if (!visible) return;
    if (
      lastIncomingPayment &&
      selectedWallet &&
      lastIncomingPayment.walletId === selectedWallet.id &&
      // A catch-up receipt (settled long before we noticed it) isn't a
      // payment to this QR — and nothing clears it, as no overlay shows.
      !isStaleReceipt(lastIncomingPayment.settledAt, lastIncomingPayment.at)
    ) {
      setPaymentReceived(true);
    }
  }, [lastIncomingPayment, selectedWallet, visible]);

  const currentSats = parseInt(satsValue) || 0;

  const onchainUri = onchainAddress
    ? buildBip21(onchainAddress, mode === 'amount' ? currentSats : null)
    : '';

  const copyValue = isOnchainWallet
    ? mode === 'amount' && currentSats > 0
      ? onchainUri
      : onchainAddress || ''
    : mode === 'address'
      ? lightningAddress || ''
      : invoice;

  const handleCopy = async () => {
    if (copyValue) await Clipboard.setStringAsync(copyValue);
  };

  const handleShare = async () => {
    if (copyValue) {
      try {
        const shareMsg = isOnchainWallet
          ? onchainUri
          : mode === 'address'
            ? `lightning:${lightningAddress}`
            : `lightning:${invoice}`;
        await Share.share({ message: shareMsg });
      } catch {}
    }
  };

  // What we'd DM to a friend in the current state. In Address mode that's
  // the user's static lightning address (friend can pay it any time). In
  // Amount mode it's the just-generated bolt11 invoice (friend can pay it
  // once, for that exact amount). For on-chain wallets we share the BIP-21
  // URI directly (with optional ?amount= when the user set one). Empty
  // during Amount-tab amount entry before the debounced invoice has come
  // back — the Copy / Share / Friend buttons all disable in that window.
  const friendShareValue = isOnchainWallet
    ? onchainAddress
      ? onchainUri
      : ''
    : mode === 'address'
      ? lightningAddress || ''
      : invoice || '';

  const handleFriendPicked = useReceiveFriendShare({
    value: friendShareValue,
    isOnchain: isOnchainWallet,
    isAddress: mode === 'address',
    sending: sendingToFriend,
    setSending: setSendingToFriend,
    setFriendPickerOpen,
    presetFriend,
    presetProtocol,
    onSent,
    onMarmotUnreachable,
    onClose,
  });

  const handleSendToGroup = useCallback(async () => {
    if (!friendShareValue || !presetGroup || !onSendToGroup || sendingToFriend) return;
    setSendingToFriend(true);
    try {
      // Mirror the 1:1 payload rules: bolt11 stays bare (Nostr block
      // parsers self-detect `lnbc…`), lud16 gets a `lightning:` prefix.
      // Group flow currently only emits invoices (sheet jumps to amount
      // entry above), so this is effectively the bolt11 branch — but
      // keep the guard for symmetry in case we later allow address
      // sharing into groups.
      const payload = mode === 'address' ? `lightning:${friendShareValue}` : friendShareValue;
      const result = await onSendToGroup(payload);
      if (!result.success) {
        Toast.show({
          type: 'error',
          text1: t('receiveSheet.sendFailed'),
          text2: result.error ?? t('receiveSheet.couldNotSendToGroup'),
          position: 'top',
          visibilityTime: 4000,
        });
        return;
      }
      onSent?.(payload);
      Toast.show({
        type: 'success',
        text1: t('receiveSheet.invoiceSentTo', { name: presetGroup.name }),
        position: 'top',
        visibilityTime: 2500,
      });
      onClose();
    } finally {
      setSendingToFriend(false);
    }
  }, [friendShareValue, presetGroup, onSendToGroup, sendingToFriend, mode, onSent, onClose, t]);

  const handleSendToFriend = useCallback(() => {
    if (!friendShareValue) return;
    if (presetGroup) {
      handleSendToGroup();
      return;
    }
    if (presetFriend) {
      handleFriendPicked(presetFriend);
      return;
    }
    setFriendPickerOpen(true);
  }, [friendShareValue, presetFriend, presetGroup, handleFriendPicked, handleSendToGroup]);

  const handleSheetChange = useCallback(
    (index: number) => {
      // Presenting the Boltz receive sheet (a second BottomSheetModal) on top
      // collapses THIS sheet to index -1. That collapse is not a user dismiss —
      // and closing here calls onClose() → the parent sets visible=false → this
      // component returns null and unmounts, taking the still-open
      // <BoltzReceiveSheet> child (rendered in this tree) down with it. That
      // stranded the Boltz lockup QR the instant it opened (#92). Only treat a
      // genuine collapse to -1 as a dismiss when no child sheet is open.
      if (index === -1 && !boltzReceiveOpen) onClose();
    },
    [onClose, boltzReceiveOpen],
  );

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />
    ),
    [],
  );

  if (!visible) return null;

  return (
    <>
      <BottomSheetModal
        ref={bottomSheetRef}
        onChange={handleSheetChange}
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        handleIndicatorStyle={styles.handleIndicator}
        backgroundStyle={styles.sheetBackground}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
      >
        <BottomSheetView style={styles.content}>
          {/* No TouchableWithoutFeedback-with-Keyboard.dismiss wrapper here
           *  per TROUBLESHOOTING.adoc rule (6): it interferes with the
           *  sheet's keyboard handling AND, under the New Architecture,
           *  swallows UiAutomator/Maestro accessibility clicks that should
           *  reach the inner Pressable/TouchableOpacity testIDs (caused
           *  issue #106 — Maestro tap on `receive-send-to-friend` reported
           *  COMPLETED but never dispatched onPress). The keyboard can be
           *  dismissed naturally by tapping any of the buttons or the
           *  hardware back key. */}
          <ReceiveClaimScanner
            key={selectedWalletId}
            walletId={selectedWalletId}
            enabled={!presetFriend && !presetGroup && selectedWallet?.walletType === 'nwc'}
            onClaimOpen={onClose}
          >
            {step === 'amount' ? (
              <AmountEntryScreen
                initialSats={currentSats}
                // The in-conversation Invoice flow (#211) shows a peer's
                // name in the title so the user has visual confirmation
                // they're requesting from the right person. The standalone
                // Receive flow keeps the generic "Custom amount".
                title={
                  presetFriend
                    ? t('receiveSheet.requestFrom', { name: presetFriend.name })
                    : presetGroup
                      ? t('receiveSheet.requestFrom', { name: presetGroup.name })
                      : t('receiveSheet.customAmount')
                }
                confirmLabel={t('receiveSheet.generateInvoice')}
                // Memo only makes sense for an amount-bound bolt11 (it's
                // the bolt11 `description` field), and only when there's
                // a clear "what's it for" context — i.e. requesting a
                // specific amount from a peer or group. Standalone
                // Receive (no preset) intentionally omits it: that flow
                // can land on a static lud16 view, and a memo on a
                // lud16 has nowhere to go.
                enableMemo={!isOnchainWallet && (!!presetFriend || !!presetGroup)}
                initialMemo={memoValue}
                onBack={
                  // If the main view has nothing useful to show (no lud16
                  // to display, not an on-chain wallet with an address),
                  // don't render the back arrow at all — there's nothing
                  // meaningful to navigate back to. Hardware back / swipe
                  // down still dismisses the sheet.
                  !lightningAddress && !isOnchainWallet ? undefined : () => setStep('main')
                }
                onConfirm={(sats, memo) => {
                  setSatsValue(String(sats));
                  setMemoValue(memo ?? '');
                  setStep('main');
                  // User confirmed — generate the invoice straight away.
                  // On-chain skips this: the BIP-21 URI is derived from
                  // currentSats so the QR refreshes on its own.
                  if (sats > 0 && !isOnchainWallet) generateInvoice(sats, memo);
                }}
              />
            ) : (
              <View style={styles.innerContent}>
                <Text style={styles.title}>{t('receiveSheet.receive')}</Text>

                {/* Wallet selector */}
                {receivableWallets.length > 1 ? (
                  <View style={styles.walletDropdownRow}>
                    <Text style={styles.walletLabel}>{t('receiveSheet.to')}</Text>
                    <View style={styles.walletDropdownWrapper}>
                      <TouchableOpacity
                        testID="receive-wallet-dropdown-toggle"
                        accessibilityLabel={t('receiveSheet.toWallet', { wallet: walletName })}
                        accessibilityRole="button"
                        accessibilityState={{ expanded: dropdownOpen }}
                        style={styles.walletDropdown}
                        onPress={() => setDropdownOpen(!dropdownOpen)}
                      >
                        <Text style={styles.walletDropdownText}>{walletName}</Text>
                        {dropdownOpen ? (
                          <ChevronUp size={16} color={colors.white} />
                        ) : (
                          <ChevronDown size={16} color={colors.white} />
                        )}
                      </TouchableOpacity>
                      {dropdownOpen && (
                        <View style={styles.walletDropdownMenu}>
                          {receivableWallets.map((w) => (
                            <TouchableOpacity
                              key={w.id}
                              testID={`receive-wallet-option-${w.id}`}
                              accessibilityRole="button"
                              accessibilityState={{ selected: selectedWalletId === w.id }}
                              accessibilityLabel={t('receiveSheet.selectWalletA11y', {
                                wallet: walletLabel(w),
                              })}
                              style={[
                                styles.walletDropdownItem,
                                selectedWalletId === w.id && styles.walletDropdownItemActive,
                              ]}
                              onPress={() => {
                                if (w.id !== selectedWalletId) {
                                  // Invalidate the previous wallet's requests and
                                  // drop its QR in this commit, not an effect later.
                                  sessionTokenRef.current += 1;
                                  resetOnchainAddress();
                                  setInvoice('');
                                  setLoading(false);
                                }
                                setCapturedWalletId(w.id);
                                setDropdownOpen(false);
                              }}
                            >
                              <Text
                                style={[
                                  styles.walletDropdownItemText,
                                  selectedWalletId === w.id && styles.walletDropdownItemTextActive,
                                ]}
                              >
                                {walletLabel(w)}
                              </Text>
                            </TouchableOpacity>
                          ))}
                        </View>
                      )}
                    </View>
                  </View>
                ) : (
                  <Text style={styles.walletLabel}>
                    {t('receiveSheet.toWallet', { wallet: walletName })}
                  </Text>
                )}

                <ReceivePaymentQr
                  styles={styles}
                  isOnchainWallet={isOnchainWallet}
                  onchainAddress={onchainAddress}
                  onchainUri={onchainUri}
                  mode={mode}
                  currentSats={currentSats}
                  lightningAddress={lightningAddress}
                  invoice={invoice}
                  paymentReceived={paymentReceived}
                  loading={loading}
                />

                <Text style={styles.qrLabel}>
                  {isOnchainWallet && onchainAddress && !(mode === 'amount' && currentSats > 0) ? (
                    <>
                      <Text style={styles.addressHighlight}>{onchainAddress.slice(0, 6)}</Text>
                      {onchainAddress.slice(6, -6)}
                      <Text style={styles.addressHighlight}>{onchainAddress.slice(-6)}</Text>
                    </>
                  ) : isOnchainWallet ? (
                    mode === 'amount' && currentSats > 0 ? (
                      `${currentSats.toLocaleString(formatLocale)} sats`
                    ) : onchainAddressFailed ? (
                      t('receiveSheet.addressLoadFailed')
                    ) : (
                      t('receiveSheet.loadingAddress')
                    )
                  ) : mode === 'address' ? (
                    lightningAddress
                  ) : (
                    t('receiveSheet.lightningInvoice')
                  )}
                </Text>
                {isOnchainWallet && onchainAddressFailed ? (
                  <TouchableOpacity
                    accessibilityRole="button"
                    style={styles.secondaryActionButton}
                    onPress={retryOnchainAddress}
                    testID="receive-address-retry"
                    accessibilityLabel={t('receiveSheet.retryAddressLabel')}
                  >
                    <Text style={styles.secondaryActionText}>{t('receiveSheet.retry')}</Text>
                  </TouchableOpacity>
                ) : null}
                {mode === 'amount' && invoice && memoValue ? (
                  // Surface the memo so the user can see the "what's it
                  // for" they typed is actually attached to the invoice
                  // they're about to send (#211). Truncated to two lines
                  // to keep the sheet from growing if someone pastes a
                  // novella in.
                  <Text style={styles.invoiceMemoPreview} numberOfLines={2}>
                    {`“${memoValue}”`}
                  </Text>
                ) : null}
                {mode === 'amount' && invoice ? (
                  <Text style={styles.invoiceText} numberOfLines={2}>
                    {invoice}
                  </Text>
                ) : null}

                {presetFriend || presetGroup ? (
                  <View style={styles.buttonRow}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{
                        disabled:
                          !friendShareValue ||
                          sendingToFriend ||
                          // Programmer-error guard: if a caller passes
                          // `presetGroup` without `onSendToGroup`, the press
                          // would early-return with no feedback. Surface the
                          // misconfiguration as a disabled button instead.
                          (!!presetGroup && !onSendToGroup),
                      }}
                      style={({ pressed }) => [
                        styles.actionButton,
                        styles.actionButtonPrimary,
                        !friendShareValue && styles.actionButtonDisabled,
                        pressed && { opacity: 0.7 },
                      ]}
                      onPress={handleSendToFriend}
                      disabled={
                        !friendShareValue ||
                        sendingToFriend ||
                        // Programmer-error guard: if a caller passes
                        // `presetGroup` without `onSendToGroup`, the press
                        // would early-return with no feedback. Surface the
                        // misconfiguration as a disabled button instead.
                        (!!presetGroup && !onSendToGroup)
                      }
                      accessibilityLabel={t('receiveSheet.sendTo', {
                        name: presetFriend?.name ?? presetGroup?.name,
                      })}
                      testID="receive-send-to-friend"
                    >
                      {sendingToFriend ? (
                        <BrandedSpinner onGradient />
                      ) : (
                        <>
                          <Send size={20} color={colors.white} />
                          <Text style={[styles.actionButtonText, styles.actionButtonTextPrimary]}>
                            {t('receiveSheet.sendTo', {
                              name: presetFriend?.name ?? presetGroup?.name,
                            })}
                          </Text>
                        </>
                      )}
                    </Pressable>
                  </View>
                ) : (
                  <View style={styles.buttonRow}>
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityState={{ disabled: !copyValue }}
                      style={[styles.actionButton, !copyValue && styles.actionButtonDisabled]}
                      onPress={handleCopy}
                      accessibilityLabel={t('receiveSheet.copy')}
                      testID="receive-copy"
                      disabled={!copyValue}
                    >
                      <Copy size={20} color={colors.brandPink} />
                      <Text style={styles.actionButtonText}>{t('receiveSheet.copy')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityState={{ disabled: !copyValue }}
                      style={[styles.actionButton, !copyValue && styles.actionButtonDisabled]}
                      onPress={handleShare}
                      accessibilityLabel={t('receiveSheet.share')}
                      testID="receive-share"
                      disabled={!copyValue}
                    >
                      <Text style={styles.actionButtonText}>{t('receiveSheet.share')}</Text>
                      <Share2 size={20} color={colors.brandPink} />
                    </TouchableOpacity>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ disabled: !friendShareValue }}
                      style={({ pressed }) => [
                        styles.actionButton,
                        !friendShareValue && styles.actionButtonDisabled,
                        pressed && { opacity: 0.7 },
                      ]}
                      onPress={() => {
                        if (__DEV__) console.log('[ReceiveSheet] Friend Pressable FIRED');
                        handleSendToFriend();
                      }}
                      disabled={!friendShareValue}
                      accessibilityLabel={t('receiveSheet.sendToFriend')}
                      testID={
                        isOnchainWallet ? 'receive-friend-share-onchain' : 'receive-send-to-friend'
                      }
                    >
                      <Text style={styles.actionButtonText}>{t('receiveSheet.friend')}</Text>
                      <Send size={20} color={colors.brandPink} />
                    </Pressable>
                  </View>
                )}

                {currentSats > 0 && (invoice || (isOnchainWallet && onchainAddress)) ? (
                  <View style={styles.amountSummary}>
                    <View style={styles.amountSummaryLine}>
                      <Text style={styles.amountSummaryValue}>
                        {currentSats.toLocaleString(formatLocale)}
                      </Text>
                      <Text style={styles.amountSummaryUnit}>{t('receiveSheet.satsUnit')}</Text>
                    </View>
                    {btcPrice ? (
                      <Text style={styles.amountSummaryFiat}>
                        {t('receiveSheet.approxFiat', {
                          value: formatFiat(
                            satsToFiat(currentSats, btcPrice),
                            currency,
                            formatLocale,
                          ),
                        })}
                      </Text>
                    ) : null}
                    <TouchableOpacity
                      accessibilityRole="button"
                      style={styles.changeAmountButton}
                      onPress={() => setStep('amount')}
                      testID="receive-change-amount"
                      accessibilityLabel={t('receiveSheet.changeAmount')}
                    >
                      <Text style={styles.changeAmountText}>{t('receiveSheet.changeAmount')}</Text>
                    </TouchableOpacity>
                    {!isOnchainWallet && !presetGroup && lightningAddress ? (
                      <TouchableOpacity
                        accessibilityRole="button"
                        style={styles.secondaryActionButton}
                        onPress={() => {
                          setInvoice('');
                          setSatsValue('');
                          setMode('address');
                        }}
                        testID="receive-show-address"
                        accessibilityLabel={t('receiveSheet.showLightningAddress')}
                      >
                        <Text style={styles.secondaryActionText}>
                          {t('receiveSheet.showMyAddress')}
                        </Text>
                      </TouchableOpacity>
                    ) : null}
                  </View>
                ) : !presetGroup && !loading ? (
                  // Shown for the standalone Receive flow AND the 1:1 DM
                  // flow (presetFriend) — in a DM the user can either send
                  // their address as-is via "Send to <name>" or add an
                  // amount here to request a specific sum.
                  <TouchableOpacity
                    accessibilityRole="button"
                    style={styles.enterAmountButton}
                    onPress={() => {
                      setMode('amount');
                      setStep('amount');
                    }}
                    testID="receive-enter-custom-amount"
                    accessibilityLabel={t('receiveSheet.enterAnAmount')}
                  >
                    <Text style={styles.enterAmountText}>{t('receiveSheet.enterAnAmount')}</Text>
                  </TouchableOpacity>
                ) : null}

                {/* Issue #92 — on-chain → Lightning via Boltz forward
                 *  submarine swap. Symmetric to the LN→on-chain path that
                 *  TransferSheet already exposes. Only meaningful when the
                 *  selected wallet is a connected NWC wallet (on-chain
                 *  wallets already display a native receive address; the
                 *  preset DM/group flows have a single-purpose CTA already).
                 *  Tapping opens BoltzReceiveSheet on top of this one. */}
                {!presetFriend &&
                !presetGroup &&
                !isOnchainWallet &&
                selectedWallet?.isConnected ? (
                  <TouchableOpacity
                    accessibilityRole="button"
                    style={styles.secondaryActionButton}
                    onPress={() => setBoltzReceiveOpen(true)}
                    testID="receive-via-onchain-boltz"
                    accessibilityLabel={t('receiveSheet.receiveOnchainBoltzA11y')}
                  >
                    <Text style={styles.secondaryActionText}>
                      {t('receiveSheet.receiveOnchainBoltz')}
                    </Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            )}
          </ReceiveClaimScanner>
        </BottomSheetView>
      </BottomSheetModal>
      <FriendPickerSheet
        visible={friendPickerOpen}
        onClose={() => setFriendPickerOpen(false)}
        onSelect={handleFriendPicked}
        title={t('receiveSheet.sendInvoiceToFriend')}
        subtitle={t('receiveSheet.friendPickerSubtitle')}
      />
      <BoltzReceiveSheet
        visible={boltzReceiveOpen}
        // Opening this sheet collapsed the parent ReceiveSheet's own sheet to
        // -1 (see handleSheetChange); with the self-dismiss now guarded, that
        // parent stays mounted-but-hidden behind. Closing Boltz therefore also
        // closes ReceiveSheet so we return cleanly to Home instead of leaving
        // an invisible, un-re-presentable ReceiveSheet stuck open (#92).
        onClose={() => {
          setBoltzReceiveOpen(false);
          onClose();
        }}
        walletId={selectedWalletId}
      />
    </>
  );
};

export default ReceiveSheet;
