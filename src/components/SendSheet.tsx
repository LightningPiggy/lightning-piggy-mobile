import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { View, Text, TouchableOpacity, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useOnchainSendQuote } from '../utils/useOnchainSendQuote';
import { useSheetKeyboardRestore } from '../utils/useSheetKeyboardRestore';
import { useSendEligibility } from '../hooks/useSendEligibility';
import { Image as ExpoImage } from 'expo-image';
import { Alert } from './BrandedAlert';
import { Toast } from './BrandedToast';
import { BottomSheetTextInput, BottomSheetScrollView, BottomSheetView } from '@gorhom/bottom-sheet';
import { BottomSheetModal } from './AccessibleBottomSheetModal';
import { useCameraPermissions } from 'expo-camera';
import { decode as bolt11Decode } from 'light-bolt11-decoder';
import { useWallet, useWalletLive } from '../contexts/WalletContext';
import { walletLabel } from '../types/wallet';
import { useNostr, useNostrContacts } from '../contexts/NostrContext';
import { useThemeColors } from '../contexts/ThemeContext';
import { useLocale } from '../contexts/LocaleContext';
import { createSendSheetStyles } from '../styles/SendSheet.styles';
import { satsToFiatString } from '../services/fiatService';
import { useLargeSendConfirm } from '../hooks/useLargeSendConfirm';
import { usePostSendRefresh } from '../hooks/usePostSendRefresh';
import SendWalletSelector from './SendWalletSelector';
import SendPastePane from './SendPastePane';
import SendActionButtons from './SendActionButtons';
import { fetchInvoiceWithVerification, LnurlPayParams } from '../services/lnurlService';
import {
  type DecodedInvoice,
  editAddressPrefill,
  isLightningAddress,
} from '../utils/sendSheetInput';
import { useSendSheetLnurl } from '../hooks/useSendSheetLnurl';
import { useKeyboardHeight } from '../hooks/useKeyboardHeight';
import { useSendSheetInput } from '../hooks/useSendSheetInput';
import { useSendInputMode } from '../hooks/useSendInputMode';
import { useSendSheetDismiss } from '../hooks/useSendSheetDismiss';
import * as boltzService from '../services/boltzService';
import * as onchainService from '../services/onchainService';
import {
  executeReverseSwap,
  isSwapSettlingError,
  type ReverseSwapReceipt,
  isSwapCreateTimeout,
} from '../utils/reverseSwapSend';
import { quoteExactRecipient, formatRecipientFee } from '../utils/reverseSwapAmounts';
import { reverseSwapAmountBounds, shortOnchainAddress } from '../utils/onchainSwapSend';
import { paymentRecipientLabel } from '../utils/paymentIdentity';
import SendOnchainFeeRow from './SendOnchainFeeRow';
import { npubEncode } from '../services/nostrService';
import { recordOutgoing as recordOutgoingCounterparty } from '../services/zapCounterpartyStorage';
import { isReplyTimeoutError, isConnectionError } from '../services/nwcService';
import PaymentProgressOverlay from './PaymentProgressOverlay';
import { useSendProgressOverlay } from '../hooks/useSendProgressOverlay';
import { isReverseSwapNotPaid } from '../utils/swapHandoff';
import AmountEntryScreen from './AmountEntryScreen';
import SendAmountSection from './SendAmountSection';
import SendPaymentIdentity from './SendPaymentIdentity';
import SendModeTabs, { type SendInputMode } from './SendModeTabs';
import SendNfcPane from './SendNfcPane';
import SendScanPane from './SendScanPane';
import { perfLog } from '../utils/perfLog';

interface Props {
  visible: boolean;
  onClose: () => void;
  initialAddress?: string;
  initialPicture?: string;
  recipientPubkey?: string;
  recipientName?: string;
  // Optional Nostr event id to zap. When set, the 9734 zap request
  // carries an `e` tag scoping the zap to that note — the LNURL
  // server echoes it onto the 9735 receipt so per-note aggregation
  // (e.g. the find-log zaps-received pill in HuntPiggyDetail) picks
  // the zap up. Omit for plain zap-the-author flows.
  zapEventId?: string;
  // Changes on every open from the Home sheet host. A re-open while already
  // visible (a widget tap, #1849) then starts afresh on the active wallet.
  openKey?: number;
  initialMode?: SendInputMode; // Open on this tab (the widget's Scan button).
}

type Step = 'main' | 'amount';

let __sendSheetFirstVisibleLogged = false;
const SendSheet: React.FC<Props> = ({
  visible,
  onClose,
  initialAddress,
  initialPicture,
  recipientPubkey,
  recipientName,
  zapEventId,
  openKey,
  initialMode,
}) => {
  if (visible && !__sendSheetFirstVisibleLogged) {
    __sendSheetFirstVisibleLogged = true;
    perfLog('SendSheet first render (visible=true)');
  }
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const { t, formatLocale } = useLocale();
  const styles = useMemo(() => createSendSheetStyles(colors), [colors]);
  const { payInvoiceForWallet, addPendingTransaction, activeWalletId, wallets, currency } =
    useWallet();
  const { btcPrice } = useWalletLive();
  const { signZapRequest } = useNostr();
  const confirmLargeSend = useLargeSendConfirm();
  const refreshAfterSend = usePostSendRefresh();
  const { contacts } = useNostrContacts();
  const [capturedWalletId, setCapturedWalletId] = useState<string | null>(null);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [invoiceData, setInvoiceData] = useState<string | null>(null);
  const [decoded, setDecoded] = useState<DecodedInvoice | null>(null);
  const [sending, setSending] = useState(false);
  const [scanned, setScanned] = useState(false);
  const [pasteText, setPasteText] = useState('');
  // Remount key for the paste BottomSheetTextInput. The field is intentionally
  // uncontrolled during typing (`defaultValue`, no `value` prop) so a slow
  // re-render of this large sheet can never cause RN to re-push a stale JS
  // snapshot over text the user has since kept typing natively — the exact
  // "duplicated stale prefix" / dropped-character race reported in #873 on
  // Android. Invariant: every *programmatic* value change goes through
  // applyPasteText (which bumps this key to remount with a fresh defaultValue);
  // onChangeText stays a bare setPasteText with NO key bump. Same pattern for
  // `memo` / memoKey below.
  const [pasteTextKey, setPasteTextKey] = useState(0);
  const [satsValue, setSatsValue] = useState(''); // amount input for lightning addresses (no invoice amount)
  const [step, setStep] = useState<Step>('main');
  const [lnurlParams, setLnurlParams] = useState<LnurlPayParams | null>(null);
  const [resolving, setResolving] = useState(false);
  const [memo, setMemo] = useState('');
  // See pasteTextKey above — same uncontrolled-remount pattern; programmatic
  // sets go through applyMemo, onChangeText stays a bare setMemo.
  const [memoKey, setMemoKey] = useState(0);
  // Freshest paste-field text, written synchronously by onChangeText and
  // applyPasteText — the only two writers of `pasteText` — so it can run ahead
  // of the state (see the refs block below). Deliberately NOT synced in render:
  // a render whose `pasteText` still lags a keystroke would rewind it. Declared
  // here so useSendInputMode can see native typing that hasn't committed yet.
  const pasteTextRef = useRef(pasteText);
  const { inputMode, resetInputModeForOpen, selectInputMode } = useSendInputMode({
    visible,
    permission,
    hasInput: scanned || pasteText.length > 0,
    liveInputRef: pasteTextRef,
    preferredMode: initialMode,
  });
  const [activePubkey, setActivePubkey] = useState(recipientPubkey);
  const [activePicture, setActivePicture] = useState(initialPicture);
  const [isOnchainAddress, setIsOnchainAddress] = useState(false);
  const [isLnurl, setIsLnurl] = useState(false);
  const [swapReceipt, setSwapReceipt] = useState<ReverseSwapReceipt | null>(null);
  const {
    progressState,
    progressError,
    inFlightIsSwap,
    setInFlightIsSwap,
    swapSteps,
    canContinueInBackground,
    beginSend,
    endSend,
    ownsOverlay,
    showOutcome,
    callbacksFor,
    handleCancelPayment,
    handleOverlayDismiss,
  } = useSendProgressOverlay({ onClose, setSending });
  const bottomSheetRef = useRef<BottomSheetModal>(null);
  // Bumped on every open, close and new target; see the deferred initialAddress prefill.
  const openSessionRef = useRef(0);

  // Programmatic value changes for the uncontrolled paste/memo fields go through
  // these helpers, which bump the remount key so the input picks up the new
  // `defaultValue`. onChangeText must NOT use them — it stays a bare setter (no
  // key bump) so native typing is never fed back through React (#873).
  const applyPasteText = useCallback((v: string) => {
    pasteTextRef.current = v;
    setPasteText(v);
    setPasteTextKey((k) => k + 1);
  }, []);
  const applyMemo = useCallback((v: string) => {
    setMemo(v);
    setMemoKey((k) => k + 1);
  }, []);

  // Let dynamic sizing measure intrinsic content; tall forms scroll above
  // the safe-area inset rather than clipping the trailing action buttons.
  const keyboardHeight = useKeyboardHeight();
  // gorhom's keyboardBlurBehavior="restore" leaves a dynamically sized sheet
  // floating mid-screen on iOS once the keyboard closes; snap it back.
  useSheetKeyboardRestore(bottomSheetRef, visible);

  // Amount-less bolt11 (`lnbc1…` with no amount prefix) — recipient lets
  // the sender pick the amount. NIP-47 `pay_invoice` accepts an optional
  // `amount` (msats) for these; route through AmountEntryScreen so the
  // user enters a value before we send.
  const isAmountlessBolt11 =
    scanned &&
    !isLightningAddress(invoiceData || '') &&
    !isOnchainAddress &&
    !isLnurl &&
    !!invoiceData &&
    decoded?.amountSats === null;
  const needsAmount =
    scanned &&
    (isLightningAddress(invoiceData || '') || isOnchainAddress || isAmountlessBolt11 || isLnurl);
  const recipientLabel = isOnchainAddress
    ? shortOnchainAddress(invoiceData || '')
    : paymentRecipientLabel({
        address: isLightningAddress(invoiceData || '') ? invoiceData : null,
        lnurl: isLnurl ? invoiceData : null,
        pubkey: activePubkey,
        contacts,
        nodePubkey: decoded?.nodePubkey,
        unknownLabel: t('sendSheet.thisRecipient'),
      });
  const currentSats = parseInt(satsValue) || 0;

  const selectedWalletId = capturedWalletId ?? activeWalletId;
  const selectedWallet = useMemo(
    () => wallets.find((w) => w.id === selectedWalletId) ?? null,
    [wallets, selectedWalletId],
  );
  const walletId = selectedWallet?.id ?? null;
  const walletBalance = selectedWallet?.balance ?? null;
  const walletName = selectedWallet ? walletLabel(selectedWallet) : t('sendSheet.walletFallback');
  // On-chain sends from a hot on-chain wallet go direct; anything else hops
  // through a Boltz reverse swap that delivers exactly `currentSats` and adds
  // every fee on top (#1175) — so its limits and confirmations use the total.
  const isHotOnchainWallet =
    selectedWallet?.walletType === 'onchain' && selectedWallet?.onchainImportMethod === 'mnemonic';
  const onchainViaBoltz = isOnchainAddress && !isHotOnchainWallet;
  const onchainQuote = useOnchainSendQuote({
    visible,
    address: isOnchainAddress && scanned ? invoiceData : null,
    walletId,
    viaSwap: onchainViaBoltz,
    amountSats: currentSats,
    // A sync that changes the balance or history re-prices a direct send.
    walletSyncKey: `${walletBalance}:${selectedWallet?.transactions?.length ?? 0}`,
  });
  const boltzFees = onchainQuote.fees;
  const onchainEligibility = useSendEligibility(
    currentSats,
    walletBalance,
    onchainViaBoltz,
    onchainQuote,
  );
  const swapQuote =
    onchainViaBoltz && boltzFees && currentSats > 0
      ? quoteExactRecipient(currentSats, boltzFees)
      : null;
  const swapBounds = useMemo(
    () => (onchainViaBoltz && boltzFees ? reverseSwapAmountBounds(boltzFees, walletBalance) : null),
    [onchainViaBoltz, boltzFees, walletBalance],
  );

  const {
    processInput,
    resetInputForOpen,
    handleBarCodeScanned,
    handleNfcContent,
    handlePaste,
    handlePasteSubmit,
  } = useSendSheetInput({
    visible,
    targetKey: JSON.stringify([
      initialAddress,
      initialPicture,
      recipientPubkey,
      recipientName,
      zapEventId,
    ]),
    scanned,
    pasteTextRef,
    activePubkey,
    recipientName,
    applyPasteText,
    onInvalidInvoice: () => selectInputMode('paste'),
    setIsOnchainAddress,
    setIsLnurl,
    setInvoiceData,
    setDecoded,
    setScanned,
    setSatsValue,
  });

  useEffect(() => {
    openSessionRef.current += 1;
    if (visible) {
      setCapturedWalletId(activeWalletId);
      setDropdownOpen(false);
      setInvoiceData(null);
      setDecoded(null);
      setScanned(false);
      setSending(false);
      resetInputForOpen();
      // Default to the paste tab unless the camera is actually usable — opening
      // on a scanner that can't start (permission denied) is a dead-end; the
      // user can still switch to Scan, which prompts for access. A first open
      // before permission resolves may still move to Scan (useSendInputMode).
      resetInputModeForOpen(initialAddress);
      applyPasteText(initialAddress || '');
      setSatsValue('');
      setStep('main');
      setLnurlParams(null);
      setResolving(false);
      setIsLnurl(false);
      applyMemo('');
      // Sheet is kept mounted across opens, so useState(prop) init doesn't re-fire.
      // Re-apply recipient props or Friends-tab zap keeps stale activePubkey → no 9734.
      setActivePubkey(recipientPubkey);
      setActivePicture(initialPicture);
      bottomSheetRef.current?.present();
      if (initialAddress) {
        // Deferred past the state reset; cleanup + session check drop a stale
        // prefill on close/reopen. Deep links reaching here were already
        // confirmed by App.tsx (#1500).
        const session = openSessionRef.current;
        const prefill = setTimeout(() => {
          if (openSessionRef.current === session) processInput(initialAddress);
        }, 0);
        return () => clearTimeout(prefill);
      }
    } else {
      bottomSheetRef.current?.dismiss();
    }
    // Also keyed on the target: the sheet stays mounted and visible, so a new
    // navigateToSend (e.g. a deep link) only changes these props and must start
    // a fresh send. Nothing else (onClose identity, balance ticks) re-runs it,
    // so an unrelated render keeps the in-progress entry.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    visible,
    initialAddress,
    initialPicture,
    recipientPubkey,
    recipientName,
    zapEventId,
    openKey,
  ]);

  const { handleSheetChange, renderBackdrop } = useSendSheetDismiss({
    visible,
    onClose,
    resetInputForOpen,
  });

  // Mirror latest pasteText / invoiceData into refs so handleEditAddress reads the submitted value without closing over it — keeping the callback (and onResolveError) reference-stable so useSendSheetLnurl's effects can depend on it without re-firing on keystrokes (Copilot #872). invoiceDataRef is synced in render so it is current before any failure callback.
  // (pasteTextRef is declared above, before useSendInputMode, and written only by its setters.)
  const invoiceDataRef = useRef(invoiceData);
  invoiceDataRef.current = invoiceData;
  // Freshest-value refs for the two uncontrolled inputs. Because the fields are
  // uncontrolled (`defaultValue`) the native text can momentarily run ahead of
  // React state under JS-thread load — the accepted tradeoff of the #873 fix. To
  // stop any *consumer* reading a stale value, onChangeText also writes the
  // native string into these refs synchronously (below), and the submit paths
  // (`handlePasteSubmit`, `handleSend`) read the ref, not the state.
  // *Programmatic* sets don't fire onChangeText: applyPasteText writes
  // pasteTextRef itself, and the render-time assignment here covers applyMemo. Reading the
  // ref is therefore never staler than reading state — strictly a belt-and-
  // suspenders improvement that doesn't reintroduce the keystroke race.
  const memoRef = useRef(memo);
  memoRef.current = memo;

  // Fix-in-place recovery (#871): back to the paste/input step with the bad
  // value RETAINED (handleReset blanks it) so a one-char typo can be fixed
  // without retyping. Unwinds resolved/scanned state, keeps the editable text,
  // and reads the submitted value via refs so the callback identity stays stable.
  const handleEditAddress = useCallback(() => {
    const prefill = editAddressPrefill(pasteTextRef.current, invoiceDataRef.current);
    setActivePubkey(undefined);
    setActivePicture(undefined);
    setInvoiceData(null);
    setDecoded(null);
    setScanned(false);
    setLnurlParams(null);
    setResolving(false);
    setSatsValue('');
    setIsLnurl(false);
    setIsOnchainAddress(false);
    setStep('main');
    selectInputMode('paste');
    applyPasteText(prefill);
  }, [applyPasteText, selectInputMode]);

  // Resolution failed (typo / unreachable): toast the friendly error, then
  // hand the user straight back to the editable address (#871).
  const handleResolveError = useCallback(
    (title: string, body: string) => {
      Toast.show({ type: 'error', text1: title, text2: body });
      handleEditAddress();
    },
    [handleEditAddress],
  );

  // Resolve a scanned/pasted lightning address or raw LNURL into LNURL-pay
  // params (or report a withdraw claim code). Extracted to keep SendSheet
  // under the file-size cap — see useSendSheetLnurl.
  useSendSheetLnurl({
    scanned,
    invoiceData,
    isLnurl,
    recipientName,
    activePubkey,
    setLnurlParams,
    setDecoded,
    setResolving,
    setInvoiceData,
    setScanned,
    setIsLnurl,
    setSatsValue,
    onResolveError: handleResolveError,
  });

  const handleSend = async () => {
    if (!invoiceData) return;
    const sendTappedAt = Date.now();
    // Read the memo from its ref, not state: the memo field is uncontrolled and
    // sits right next to the Send button, so a type-then-immediately-Send can
    // outrun the state flush. The ref is written synchronously in onChangeText.
    const submittedMemo = memoRef.current;
    if (isOnchainAddress && !onchainEligibility.canSend) {
      const reason = onchainEligibility.reason!;
      Alert.alert(t('sendSheet.error'), t(reason.key, reason.params));
      return;
    }
    // High-value confirmation gate (#82) — see useLargeSendConfirm.
    const decodedAmount = decoded?.amountSats ?? 0;
    const confirmed = await confirmLargeSend({
      amountSats: decodedAmount > 0 ? decodedAmount : currentSats,
      // Name the destination itself — never the "Send to on-chain address" label.
      recipient: recipientLabel,
      swapQuote,
    });
    if (!confirmed) return;
    // Every async overlay update below is scoped to THIS send: once it is
    // superseded or continued in the background it must not repaint.
    const send = beginSend();
    const { signal } = send.controller;
    // onDispatched: once pay_invoice is sent, Cancel keeps the in-flight warning (#1776).
    const { onReplyTimeout, onPaymentDispatched: onDispatched } = callbacksFor(send);
    setSwapReceipt(null);
    setSending(true);
    let swapPaymentHash: string | null = null;
    try {
      if (isOnchainAddress) {
        if (currentSats <= 0) {
          Alert.alert(t('sendSheet.error'), t('sendSheet.enterAmount'));
          setSending(false);
          return;
        }
        if (isHotOnchainWallet) {
          // Direct on-chain send from hot wallet
          await onchainService.sendTransaction(walletId!, invoiceData, currentSats);
        } else {
          // Boltz reverse swap: Lightning → on-chain. The orchestration
          // (persist-before-pay for crash recovery, pay, lockup, claim) and
          // its #891 error contract live in reverseSwapSend — the catch
          // below maps SwapSettlingError / ReplyTimeoutError to the
          // swap-aware "Boltz swap in progress" overlay instead of "Payment
          // failed".
          if (!boltzFees) throw new Error(t('sendSheet.feeUnavailable'));
          setInFlightIsSwap(true);
          const receipt = await executeReverseSwap({
            walletId: walletId!,
            destinationAddress: invoiceData,
            recipientSats: currentSats,
            approvedQuote: boltzFees,
            signal,
            payInvoice: payInvoiceForWallet,
            ...callbacksFor(send),
          });
          swapPaymentHash = receipt.paymentHash;
          // A send continued in the background must not repaint a newer one.
          if (ownsOverlay(send)) setSwapReceipt(receipt);
        }
      } else if (isLightningAddress(invoiceData) || isLnurl) {
        if (!lnurlParams) {
          Alert.alert(t('sendSheet.error'), t('sendSheet.detailsNotResolved'));
          setSending(false);
          return;
        }
        if (currentSats <= 0) {
          Alert.alert(t('sendSheet.error'), t('sendSheet.enterAmount'));
          setSending(false);
          return;
        }
        if (currentSats < lnurlParams.minSats) {
          Alert.alert(
            t('sendSheet.error'),
            t('sendSheet.minAmount', { min: lnurlParams.minSats.toLocaleString(formatLocale) }),
          );
          setSending(false);
          return;
        }
        if (currentSats > lnurlParams.maxSats) {
          Alert.alert(
            t('sendSheet.error'),
            t('sendSheet.maxAmount', { max: lnurlParams.maxSats.toLocaleString(formatLocale) }),
          );
          setSending(false);
          return;
        }
        // Build invoice options (zap request for Nostr contacts, comment for all)
        const invoiceOptions: { nostr?: string; comment?: string } = {};

        // NIP-57 zap: sign a zap request if this is a Nostr contact and the server supports it
        if (activePubkey && lnurlParams.allowsNostr) {
          try {
            const zapRequestJson = await signZapRequest(
              activePubkey,
              currentSats,
              submittedMemo,
              zapEventId,
            );
            if (zapRequestJson) {
              invoiceOptions.nostr = zapRequestJson;
            } else if (__DEV__) {
              console.warn(
                `[Zap-send] signZapRequest returned empty for recipient=${activePubkey.slice(0, 8)} — payment will go through as a plain LN send (no kind-9735 receipt published on Nostr); local attribution still works because the counterparty is persisted below whenever activePubkey is set`,
              );
            }
          } catch (e) {
            // Don't let a signer failure block the payment — fall through to a plain LN send. The local-storage path below still records the counterparty when activePubkey is set, so the row will show the recipient even though there's no NIP-57 receipt on Nostr.
            console.warn(
              `[Zap-send] signZapRequest threw for recipient=${activePubkey.slice(0, 8)}:`,
              e,
            );
          }
        }

        // LNURL-pay comment (for non-zap or if server supports comments)
        if (submittedMemo && lnurlParams.commentAllowed > 0) {
          invoiceOptions.comment = submittedMemo.slice(0, lnurlParams.commentAllowed);
        }

        const { invoice: bolt11, verifyUrl } = await fetchInvoiceWithVerification(
          lnurlParams.callback,
          currentSats,
          invoiceOptions,
        );
        await payInvoiceForWallet(walletId!, bolt11, {
          verifyUrl,
          signal,
          onReplyTimeout,
          onDispatched,
        });

        if (__DEV__)
          console.log(
            `[Zap-send] paid ${currentSats} sats · allowsNostr=${!!lnurlParams.allowsNostr} activePubkey=${activePubkey ? activePubkey.slice(0, 8) + '…' : 'none'} hasZapRequest=${!!invoiceOptions.nostr}`,
          );

        // Persist the recipient locally whenever we know who we're paying — i.e. when activePubkey is set (Friends → Zap, ConversationScreen send, anything that arrived with a recipientPubkey prop). Decoupled from invoiceOptions.nostr so a signer failure or an LNURL server with allowsNostr=false doesn't strip the recipient's name from the transaction row. The Nostr-side path (zap receipt) is still emitted when invoiceOptions.nostr is set; this just guarantees local UI attribution even when the on-network NIP-57 receipt path is broken.
        if (activePubkey)
          void (async () => {
            try {
              const decoded = bolt11Decode(bolt11);
              const hashSection = decoded.sections?.find(
                (s: { name: string }) => s.name === 'payment_hash',
              ) as { value?: string } | undefined;
              const paymentHash = hashSection?.value;
              if (paymentHash) {
                const contact = contacts.find((c) => c.pubkey === activePubkey);
                const p = contact?.profile ?? null;
                const counterparty = {
                  pubkey: activePubkey,
                  profile: {
                    npub: npubEncode(activePubkey),
                    name: p?.name ?? null,
                    displayName: p?.displayName ?? null,
                    picture: p?.picture ?? activePicture ?? null,
                    nip05: p?.nip05 ?? null,
                  },
                  comment: submittedMemo,
                  anonymous: false,
                };
                await recordOutgoingCounterparty(paymentHash, counterparty);
                if (__DEV__)
                  console.log(`[Zap-send] stored counterparty for ph=${paymentHash.slice(0, 12)}…`);
                // Optimistic insert: surface the outgoing zap in ConversationScreen
                // (and the transaction list) without waiting for LNbits to flush
                // the tx and the next resolver pass. The subsequent
                // fetchTransactionsForWallet refresh reconciles by paymentHash —
                // see WalletContext's counterpartyByHash loop which preserves
                // this attribution across refreshes.
                if (walletId) {
                  const nowSec = Math.floor(Date.now() / 1000);
                  // Convention throughout the app: amount is a POSITIVE magnitude
                  // and `type` alone carries direction (see TransferSheet's
                  // optimistic inserts, ConversationScreen's zapItems, and every
                  // TransactionDetail consumer — all read Math.abs(tx.amount)).
                  addPendingTransaction(walletId, {
                    type: 'outgoing',
                    amount: currentSats,
                    description: submittedMemo || undefined,
                    created_at: nowSec,
                    settled_at: nowSec,
                    paymentHash,
                    bolt11,
                    invoice: bolt11,
                    zapCounterparty: counterparty,
                    optimistic: true,
                  });
                }
              }
            } catch (e) {
              if (__DEV__) console.warn('[Zap-send] store failed:', e);
            }
          })();
      } else {
        // Amount-bearing bolt11s pay as-is; amount-less bolt11s require
        // the user-entered sats threaded through as msats per NIP-47.
        if (isAmountlessBolt11 && currentSats <= 0) {
          Alert.alert(t('sendSheet.error'), t('sendSheet.enterAmount'));
          setSending(false);
          return;
        }
        // Guard against `currentSats * 1000` exceeding Number.MAX_SAFE_INTEGER
        // (~9e15) and silently losing precision when computing msats.
        // 9e12 sats is far above any practical Lightning payment
        // (~0.5 BTC HTLC ceiling = 5e7 sats) so this is purely a
        // defensive bound, not a UX limitation.
        const MAX_SAFE_SATS = Math.floor(Number.MAX_SAFE_INTEGER / 1000);
        if (isAmountlessBolt11 && currentSats > MAX_SAFE_SATS) {
          Alert.alert(t('sendSheet.error'), t('sendSheet.amountTooLarge'));
          setSending(false);
          return;
        }
        await payInvoiceForWallet(walletId!, invoiceData, {
          signal,
          onReplyTimeout,
          onDispatched,
          amountMsats: isAmountlessBolt11 ? currentSats * 1000 : undefined,
        });
      }
      if (signal.aborted) return;
      showOutcome(send, 'success');
      if (__DEV__) console.log(`[Send] Sent in ${Date.now() - sendTappedAt}ms`);
      // Confirmation owns the overlay; refresh failures must not turn a settled send into failure.
      if (walletId) void refreshAfterSend(walletId, swapPaymentHash).catch(() => {});
    } catch (error) {
      // Reply-timeout (ambiguous pay outcome) and a post-commit reverse-swap
      // settling error both mean "the money may have moved; it'll settle" —
      // surface "Still in flight", never "Payment failed" (#891).
      if (isReplyTimeoutError(error) || isSwapSettlingError(error)) {
        showOutcome(send, 'in-flight-extended');
        return;
      }
      // User Cancel before the pay request was sent (after it, Cancel doesn't
      // abort). Only THIS send's signal proves a cancel — an internal timeout
      // abort must fall through to an error.
      if (signal.aborted) return;
      // A relay/transport connectivity failure (relay unreachable, publish
      // never completed) is an UNKNOWN outcome, not a confirmed failure —
      // the payment may have settled. Surface "Connection lost" with a
      // check-before-retry warning instead of "Payment failed" (#648).
      if (isConnectionError(error)) {
        showOutcome(send, 'connection-lost');
        return;
      }
      // Stale reverse-swap quote: nothing was created or paid. Show the
      // server's refreshed fee; the form keeps the amount and the user must
      // review it and tap Send again.
      const quoteChanged = boltzService.isQuoteChangedError(error) ? error.quote : null;
      // A reverse swap whose Lightning payment provably never settled — the
      // wallet rejected it, or Boltz's own status wrote the swap off (#1167).
      const swapNotPaid = isReverseSwapNotPaid(error);
      // Superseded: say nothing. Continued in background: showOutcome toasts it.
      if (!ownsOverlay(send) && !send.dismissed) return;
      const message = quoteChanged
        ? t('sendSheet.quoteChanged', {
            fee: formatRecipientFee(currentSats, quoteChanged, formatLocale),
          })
        : swapNotPaid
          ? t('paymentProgressOverlay.swapNotPaid')
          : isSwapCreateTimeout(error)
            ? t('paymentProgressOverlay.swapServerTimeout')
            : error instanceof Error
              ? error.message
              : t('sendSheet.paymentFailed');
      if (quoteChanged) onchainQuote.adopt(quoteChanged);
      showOutcome(send, 'error', message);
    } finally {
      // Only clear state if this invocation is still the active one.
      // A cancel-then-resend can leave the first (aborted) handleSend
      // resolving AFTER a new send has already set sending=true and
      // swapped in a new controller — clearing unconditionally here
      // would stomp that new send's state (re-enable Send button,
      // allow a double-tap). See Copilot review on #185.
      if (endSend(send)) setSending(false);
    }
  };

  const handleReset = () => {
    setInvoiceData(null);
    setDecoded(null);
    setScanned(false);
    applyPasteText('');
    setSatsValue('');
    setStep('main');
    applyMemo('');
    setLnurlParams(null);
    setResolving(false);
    setActivePubkey(undefined);
    setActivePicture(undefined);
    setIsOnchainAddress(false);
    setIsLnurl(false);
  };

  // Open the sheet whenever it's asked to be visible. Do NOT gate on the
  // camera-permission hook: `useCameraPermissions()` can stay `null` (e.g. the
  // hook hasn't resolved, or returns null on some devices even when the OS
  // permission is granted), and gating here made the whole sheet render null so
  // `.present()` no-op'd and Send silently never opened. Only the scanner tab
  // needs the permission, and it handles a missing one with its own prompt.
  if (!visible) return null;

  // A swap's amount step is gated by Boltz's limits on the recipient side,
  // capped so recipient + fees fit the balance (not the LNURL range).
  const amountMinSats = onchainViaBoltz ? swapBounds?.minSats : lnurlParams?.minSats;
  const amountMaxSats = onchainViaBoltz ? swapBounds?.maxSats : lnurlParams?.maxSats;

  const canSend = isOnchainAddress
    ? onchainEligibility.canSend
    : isAmountlessBolt11
      ? currentSats > 0
      : needsAmount
        ? lnurlParams && currentSats > 0 && !resolving
        : !!invoiceData;

  return (
    <>
      <BottomSheetModal
        ref={bottomSheetRef}
        onChange={handleSheetChange}
        topInset={insets.top}
        enablePanDownToClose
        backdropComponent={renderBackdrop}
        handleIndicatorStyle={styles.handleIndicator}
        backgroundStyle={styles.sheetBackground}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
      >
        {/* AmountEntryScreen is a fixed-height component (card + button +
         *  4-row keypad) — wrap it in a plain BottomSheetView so the
         *  sheet's dynamic sizing measures the full intrinsic height.
         *  Wrapping inside a BottomSheetScrollView caused the sheet's
         *  height and the ScrollView's content height to become
         *  circular references, clipping the keypad's last row. */}
        {step === 'amount' ? (
          <BottomSheetView style={styles.amountContent}>
            <AmountEntryScreen
              initialSats={currentSats}
              title={t('sendSheet.enterAmountTitle')}
              minSats={amountMinSats}
              maxSats={amountMaxSats}
              confirmLabel={t('sendSheet.done')}
              onBack={() => setStep('main')}
              onConfirm={(sats) => {
                setSatsValue(String(sats));
                setStep('main');
              }}
            />
          </BottomSheetView>
        ) : (
          <BottomSheetScrollView
            contentContainerStyle={{
              // iOS: gorhom lifts the sheet over the keyboard itself; extra
              // padding there grows the dynamic height and leaves the sheet
              // floating after the keyboard closes. The resting pad clears
              // the home indicator (no bottomInset — that leaves a backdrop strip).
              paddingBottom:
                Platform.OS === 'android' && keyboardHeight > 0
                  ? keyboardHeight + 80
                  : 40 + insets.bottom,
            }}
            keyboardShouldPersistTaps="handled"
          >
            <View style={styles.innerContent}>
              <Text style={styles.title}>{t('sendSheet.send')}</Text>

              {/* Wallet selector */}
              <SendWalletSelector
                wallets={wallets}
                walletName={walletName}
                capturedWalletId={capturedWalletId}
                dropdownOpen={dropdownOpen}
                setDropdownOpen={setDropdownOpen}
                setCapturedWalletId={setCapturedWalletId}
                styles={styles}
                colors={colors}
              />

              {/* Mode tabs (icon toggles: QR scan / paste / NFC) */}
              {!scanned && <SendModeTabs mode={inputMode} onChange={selectInputMode} />}

              {/* Scanner, paste input, or NFC reader */}
              {!scanned ? (
                inputMode === 'nfc' ? (
                  <SendNfcPane
                    active={visible && !scanned && inputMode === 'nfc'}
                    onContent={handleNfcContent}
                  />
                ) : inputMode === 'scan' ? (
                  <SendScanPane
                    permissionGranted={!!permission?.granted}
                    onRequestPermission={requestPermission}
                    onBarcodeScanned={handleBarCodeScanned}
                  />
                ) : (
                  <SendPastePane
                    pasteText={pasteText}
                    pasteTextKey={pasteTextKey}
                    onChangeText={(v) => {
                      pasteTextRef.current = v;
                      setPasteText(v);
                    }}
                    handlePaste={handlePaste}
                    handlePasteSubmit={handlePasteSubmit}
                    styles={styles}
                    colors={colors}
                  />
                )
              ) : (
                /* Invoice/address detected - show details */
                <View style={styles.detailsCard}>
                  {activePicture && (
                    <ExpoImage
                      source={{ uri: activePicture }}
                      style={styles.recipientPicture}
                      cachePolicy="memory-disk"
                      recyclingKey={activePicture}
                      autoplay={false}
                    />
                  )}
                  <SendPaymentIdentity
                    recipient={recipientLabel}
                    memo={decoded?.description}
                    styles={styles}
                  />

                  <SendAmountSection
                    needsAmount={needsAmount}
                    resolving={resolving}
                    lnurlParams={lnurlParams}
                    isOnchainAddress={isOnchainAddress}
                    isAmountlessBolt11={isAmountlessBolt11}
                    currentSats={currentSats}
                    decodedAmountSats={decoded?.amountSats}
                    btcPrice={btcPrice}
                    currency={currency}
                    onEnterAmount={() => setStep('amount')}
                    styles={styles}
                  />

                  {isOnchainAddress && invoiceData ? (
                    <Text style={styles.detailAddress}>
                      <Text style={styles.addressHighlight}>{invoiceData.slice(0, 6)}</Text>
                      {invoiceData.slice(6, -6)}
                      <Text style={styles.addressHighlight}>{invoiceData.slice(-6)}</Text>
                    </Text>
                  ) : isLightningAddress(invoiceData || '') ? (
                    <Text style={styles.detailAddress}>{invoiceData}</Text>
                  ) : (
                    <Text style={styles.invoiceText} numberOfLines={3}>
                      {invoiceData}
                    </Text>
                  )}

                  {isOnchainAddress && (currentSats > 0 || onchainQuote.errorKey) && (
                    <SendOnchainFeeRow
                      viaBoltz={onchainViaBoltz}
                      hotWalletFee={
                        onchainQuote.directFeeSats === null
                          ? null
                          : t('sendSheet.minerFee', {
                              fee: onchainQuote.directFeeSats.toLocaleString(formatLocale),
                            })
                      }
                      blocker={onchainEligibility.reason}
                      loadingFees={onchainQuote.loading}
                      quote={swapQuote}
                      onRetry={onchainQuote.errorKey ? onchainQuote.retry : undefined}
                      styles={styles}
                    />
                  )}

                  {/* Memo / comment field for Lightning address payments */}
                  {needsAmount && (
                    <BottomSheetTextInput
                      key={memoKey}
                      style={styles.memoInput}
                      placeholder={
                        activePubkey
                          ? t('sendSheet.zapMessagePlaceholder')
                          : t('sendSheet.commentPlaceholder')
                      }
                      placeholderTextColor={colors.textSupplementary}
                      defaultValue={memo}
                      onChangeText={(v) => {
                        // Same as the paste field: mirror native text into memoRef
                        // synchronously so handleSend (which sits next to Send and
                        // can fire before state flushes) reads the freshest value.
                        memoRef.current = v;
                        setMemo(v);
                      }}
                      maxLength={lnurlParams?.commentAllowed || 150}
                      autoCorrect
                      testID="sendsheet-memo-input"
                      accessibilityLabel={t('sendSheet.zapMessageLabel')}
                    />
                  )}

                  {/* Edit-in-place: keep what was typed so a typo can be
                      fixed without retyping (#871). Only meaningful for
                      addresses / LNURL — a scanned bolt11 isn't hand-edited. */}
                  {(isLightningAddress(invoiceData || '') || isLnurl) && (
                    <TouchableOpacity
                      accessibilityRole="button"
                      onPress={handleEditAddress}
                      accessibilityLabel={t('sendSheet.editAddress')}
                      testID="sendsheet-edit-address"
                    >
                      <Text style={styles.resetText}>{t('sendSheet.editAddress')}</Text>
                    </TouchableOpacity>
                  )}

                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={handleReset}
                    accessibilityLabel={t('sendSheet.resetLabel')}
                    testID="sendsheet-reset"
                  >
                    <Text style={styles.resetText}>{t('sendSheet.resetText')}</Text>
                  </TouchableOpacity>
                </View>
              )}

              {/* Balance */}
              {walletBalance !== null && btcPrice !== null && (
                <Text style={styles.balanceText}>
                  {t('sendSheet.balance', {
                    balance: walletBalance.toLocaleString(formatLocale),
                    fiat: satsToFiatString(walletBalance, btcPrice, currency, formatLocale),
                  })}
                </Text>
              )}

              {/* Action buttons */}
              <SendActionButtons
                canSend={canSend}
                sending={sending}
                handleSend={handleSend}
                onCancel={() => {
                  resetInputForOpen();
                  handleReset();
                  onClose();
                }}
                styles={styles}
              />
            </View>
          </BottomSheetScrollView>
        )}
      </BottomSheetModal>
      <PaymentProgressOverlay
        state={progressState}
        direction="send"
        amountSats={currentSats || decoded?.amountSats || undefined}
        recipientName={recipientName}
        errorMessage={progressError}
        onDismiss={handleOverlayDismiss}
        onCancel={handleCancelPayment}
        inFlightIsSwap={inFlightIsSwap}
        swapReceipt={swapReceipt}
        swapSteps={swapSteps}
        canContinueInBackground={canContinueInBackground}
      />
    </>
  );
};

export default SendSheet;
