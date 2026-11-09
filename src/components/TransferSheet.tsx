import ExternalFundingSwap from './ExternalFundingSwap';
import {
  getTransferDestinationWallets,
  selectTransferDestination,
} from '../utils/transferDestinationWallets';
import { useTransferProfileNames } from '../hooks/useTransferProfileNames';
import { isMoveSource, isExternalFundingSource } from '../utils/moveSources';
import { formatTransferWalletLabel, formatTransferProfileLabel } from '../utils/transferLabels';
import TransferSwapQuoteStatus from './TransferSwapQuoteStatus';
import { useTransferSwapFees } from '../utils/useTransferSwapFees';
import { useTransferFeeEstimate } from '../hooks/useTransferFeeEstimate';
import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  BackHandler,
  Image,
  Keyboard,
  Linking,
  Platform,
} from 'react-native';
import { Alert } from './BrandedAlert';
import {
  BottomSheetBackdrop,
  BottomSheetBackdropProps,
  BottomSheetScrollView,
  BottomSheetView,
} from '@gorhom/bottom-sheet';
import { BottomSheetModal } from './AccessibleBottomSheetModal';
import Toast from './BrandedToast';
import { completeReverseSwap, createSwapWalletRefresher } from '../utils/swapCompletion';
import * as swapRecoveryService from '../services/swapRecoveryService';
import { promptSubmarineRefund } from '../utils/submarineRefund';
import { watchForwardSwap } from '../utils/forwardSwapWatch';
import { paymentHashFromBolt11 } from '../utils/bolt11';
import { useSwapSettleFollowUp } from '../hooks/useSwapSettleFollowUp';
import { useWallet, useWalletLive } from '../contexts/WalletContext';
import { useNostr } from '../contexts/NostrContext';
import { useLocale } from '../contexts/LocaleContext';
import { useThemeColors } from '../contexts/ThemeContext';
import { createTransferSheetStyles } from '../styles/TransferSheet.styles';
import { satsToFiatString } from '../services/fiatService';
import { getSendThreshold, shouldConfirmSend } from '../services/sendThresholdService';
import { WalletMetadata, WalletState, WalletTransaction } from '../types/wallet';
import * as onchainService from '../services/onchainService';
import * as boltzService from '../services/boltzService';
import { createRecoverableSubmarineSwap } from '../services/createRecoverableSubmarineSwap';
import {
  payAndClaimReverseSwap,
  persistReverseSwap,
  type ReverseSwapStage,
} from '../utils/reverseSwapPayClaim';
import { buildSwapPlaceholders, markSwapPlaceholdersResolved } from '../utils/swapPendingMerge';
import {
  isReverseSwapNotPaid,
  reverseSwapClaimingMessage,
  reverseSwapCompleteMessage,
} from '../utils/swapHandoff';
import * as lnurlService from '../services/lnurlService';
import { getWalletListForPubkey } from '../services/crossProfileWalletService';
import AmountEntryScreen from './AmountEntryScreen';
import TransferProgress from './TransferProgress';
import {
  advanceTransfer,
  completeTransfer,
  failTransfer,
  idleProgress,
  startTransfer,
  type TransferProgress as TransferProgressState,
} from '../utils/transferPhase';
import { singleFlight } from '../utils/singleFlight';
import {
  alertTransferFailure,
  classifyTransferError,
  exceedsSourceBalance,
  transferFailureMessage,
} from '../utils/transferOutcome';
import {
  findSameChainAlternative,
  promptSameChainAlternative,
} from '../utils/transferAlternativeSource';

interface Props {
  visible: boolean;
  onClose: () => void;
}

type Step = 'main' | 'amount';

const TransferSheet: React.FC<Props> = ({ visible, onClose }) => {
  const colors = useThemeColors();
  const { t, formatLocale } = useLocale();
  const styles = useMemo(() => createTransferSheetStyles(colors), [colors]);
  const wallet = useWallet();
  const {
    wallets,
    activeWalletId,
    currency,
    makeInvoiceForWallet,
    payInvoiceForWallet,
    deferSwapRefresh,
    fetchTransactionsForWallet,
    addPendingTransaction,
  } = wallet;
  const followSwapSettle = useSwapSettleFollowUp();
  const refreshWallets = createSwapWalletRefresher(wallet);
  const { btcPrice } = useWalletLive();
  const { identities, pubkey: activePubkey } = useNostr();

  const [sourceId, setSourceId] = useState<string | null>(null);
  const [destId, setDestId] = useState<string | null>(null);
  const [sourceDropdownOpen, setSourceDropdownOpen] = useState(false);
  const [destDropdownOpen, setDestDropdownOpen] = useState(false);
  // Cross-profile transfers (#485): null means "current profile" (default
  // behaviour, identical to single-profile mode). When set to another
  // signed-in identity's pubkey, the destination dropdown rescopes to
  // that profile's wallet list (read read-only via
  // crossProfileWalletService — does NOT switch active identity).
  const [selectedProfilePubkey, setSelectedProfilePubkey] = useState<string | null>(null);
  const [profileDropdownOpen, setProfileDropdownOpen] = useState(false);
  // Holds the *other* profile's wallet metadata when
  // `selectedProfilePubkey` is set to a non-active identity. Loaded
  // lazily on profile-change. Stays as plain WalletMetadata (no live
  // balance / isConnected status) — those fields require the per-
  // identity NWC client which only runs for the active profile. The
  // dropdown renders without a balance suffix in that case.
  const [otherProfileWallets, setOtherProfileWallets] = useState<WalletMetadata[]>([]);
  // Display-name cache for the Profile dropdown — same per-account
  // own-profile lookup AccountSwitcherSheet does. Without this the
  // dropdown would render raw npub prefixes for every other profile,
  // which is unhelpful when you've named those accounts (e.g. "Middle
  // Piggy"). Phase-1-only (no relay fan-out) — the data we need is
  // always on disk if the user has ever switched to that profile.
  const profileNameById = useTransferProfileNames(visible, identities);
  const [satsValue, setSatsValue] = useState('');
  const [step, setStep] = useState<Step>('main');
  const [sending, setSending] = useState(false);
  const [progressMsg, setProgressMsg] = useState<string | null>(null);
  // Issue #62: step-by-step progress display. The form is replaced by a
  // checklist while `sending` (or `progress.phase === 'failed'`, to keep
  // the failing step visible after `sending` clears); the checklist rows
  // read `progress.phase`/`activeIndex` to show which step is active /
  // done / failed. The legacy `progressMsg` is preserved as a block below
  // the checklist (rendered in TransferProgress) so the rich Boltz "swap
  // underway" copy still reaches the user.
  const [progress, setProgress] = useState<TransferProgressState>(() => idleProgress());
  // Set when the background reverse-swap task errors (usually an NWC relay
  // timeout leaving the LN payment state unknown). Drives the "Retry now"
  // button + the updated progress message in the progress view. Once the
  // retry succeeds we keep the error reference (so the spinner stays
  // suppressed in the post-retry state) and flip `recoveryAcked` to swap
  // the message + hide the Retry button.
  const [backgroundError, setBackgroundError] = useState<string | null>(null);
  const [retryingRecovery, setRetryingRecovery] = useState(false);
  const [recoveryAcked, setRecoveryAcked] = useState(false);
  // Synchronous re-entrancy guard for the Retry button. React's
  // setRetryingRecovery is async, so a fast double-tap can fire two
  // concurrent recoverPendingSwaps() calls before `disabled` flips. The
  // ref is checked + set synchronously inside the onPress closure.
  const retryInFlightRef = useRef(false);
  // Same guard for Move (#1778): `sending` only flips after the pre-flight
  // awaits, so without it a double-tap starts two transfers.
  const [runTransferOnce] = useState(() => singleFlight((run: () => Promise<void>) => run()));
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const bottomSheetRef = useRef<BottomSheetModal>(null);
  const scrollRef = useRef<any>(null);
  // Monotonically bumped every time the sheet opens or closes. Detached async
  // work (background swap IIFE, Retry handler) captures the value at start and
  // skips component-state setters if it has changed — otherwise a late callback
  // from a previous transfer can leak error/progress state into a new one.
  // Bumped via `useMemo` keyed on `visible` so the increment lands
  // SYNCHRONOUSLY during render (before any IIFE this render kicks off
  // captures it), not in an effect that runs post-commit and could let a
  // late microtask from the previous session pass the stale-session check.
  const sessionRef = useRef(0);
  useMemo(() => {
    sessionRef.current += 1;
  }, [visible]);
  // No explicit snapPoints — content-height only, not user-draggable.

  const currentSats = parseInt(satsValue) || 0;

  // True iff the destination is owned by a different profile than the
  // active one. Cross-profile destinations are always WalletMetadata
  // (no live balance / isConnected) — payment resolution falls back to
  // on-chain receive address or LNURL-pay via the destination wallet's
  // stored `lightningAddress`.
  const isCrossProfile = selectedProfilePubkey !== null && selectedProfilePubkey !== activePubkey;

  const source = useMemo(() => wallets.find((w) => w.id === sourceId) ?? null, [wallets, sourceId]);
  // The dest object is either a full WalletState (current-profile,
  // includes isConnected + balance) or a bare WalletMetadata (other
  // profile). Downstream code reads only the metadata fields except
  // when checking `isConnected` for the LN-route decision — guarded
  // with explicit `'isConnected' in dest` checks.
  const dest = useMemo<WalletState | WalletMetadata | null>(() => {
    if (isCrossProfile) {
      return otherProfileWallets.find((w) => w.id === destId) ?? null;
    }
    return wallets.find((w) => w.id === destId) ?? null;
  }, [isCrossProfile, otherProfileWallets, wallets, destId]);

  // Move sources include watch-only wallets funded from an external signer.
  // Always scoped to the ACTIVE profile — signing always happens with
  // the active pubkey, so a cross-profile transfer is "active profile
  // sends → other profile receives".
  const sourceWallets = useMemo(() => wallets.filter(isMoveSource), [wallets]);

  const externalFunding = isExternalFundingSource(source);

  // Destination dropdown contents.
  //  - Same profile: live WalletState list (existing behaviour) —
  //    excludes the source wallet, and requires NWC wallets to be
  //    `isConnected` since we need the live client to make an
  //    invoice locally.
  //  - Cross profile: read-only WalletMetadata from disk. We surface
  //    every NWC wallet (their lud16 alone is enough to receive via
  //    LNURL-pay, no need for the destination's NWC client to be
  //    loaded here) and every on-chain wallet (xpub watch-only AND
  //    mnemonic both derive a receive address fine — the SecureStore
  //    xpub blob is keyed by walletId, not pubkey, so onchainService
  //    can read it for any local profile). The two SendSheet-style
  //    routes (BIP-21 paste, lud16 string) work identically here.
  const destWallets = useMemo(
    () =>
      getTransferDestinationWallets(
        source,
        isCrossProfile ? otherProfileWallets : wallets,
        isCrossProfile,
      ),
    [source, isCrossProfile, otherProfileWallets, wallets],
  );

  // Determine transfer type
  const transferType = useMemo(() => {
    if (!source || !dest) return null;
    if (source.walletType === 'nwc' && dest.walletType === 'nwc') return 'ln-to-ln';
    if (source.walletType === 'nwc' && dest.walletType === 'onchain') return 'ln-to-onchain';
    if (source.walletType === 'onchain' && dest.walletType === 'onchain')
      return 'onchain-to-onchain';
    if (source.walletType === 'onchain' && dest.walletType === 'nwc') return 'onchain-to-ln';
    return null;
  }, [source, dest]);

  // Cross-profile LN destinations need a `lightningAddress` to receive
  // (we resolve it via LNURL-pay). NWC-based cross-profile invoice
  // creation is deferred — would require running the destination
  // profile's NWC client out-of-band. See PR description for #485.
  const crossProfileLnNoAddress =
    isCrossProfile &&
    transferType !== null &&
    (transferType === 'ln-to-ln' || transferType === 'onchain-to-ln') &&
    dest !== null &&
    dest.walletType === 'nwc' &&
    !dest.lightningAddress;

  const swapQuote = useTransferSwapFees(transferType, visible && !externalFunding);
  const cachedBoltzFees = swapQuote.fees;

  const feeEstimate = useTransferFeeEstimate({
    transferType,
    currentSats,
    swapFees: cachedBoltzFees,
    sourceId: externalFunding ? null : sourceId,
  });

  useEffect(() => {
    if (visible) {
      const activeW = wallets.find((w) => w.id === activeWalletId);
      const isWatchOnly =
        activeW?.walletType === 'onchain' && activeW?.onchainImportMethod !== 'mnemonic';
      const canSendFromActive = activeW && sourceWallets.some((w) => w.id === activeW.id);

      let defaultSource: string | null;
      let defaultDest: string | null;

      if (
        isWatchOnly &&
        activeWalletId &&
        !wallets.some((w) => w.walletType === 'nwc' && w.isConnected)
      ) {
        // Watch-only: default as destination, pick first sendable wallet as source
        defaultDest = activeWalletId;
        defaultSource = sourceWallets.find((w) => w.id !== activeWalletId)?.id ?? null;
      } else if (canSendFromActive && activeWalletId) {
        // Active wallet can send: use it as source
        defaultSource = activeWalletId;
        defaultDest =
          wallets.find((w) => w.id !== activeWalletId && w.walletType === 'nwc' && w.isConnected)
            ?.id ??
          wallets.find((w) => w.id !== activeWalletId)?.id ??
          null;
      } else {
        // Fallback: first sendable wallet as source
        defaultSource = sourceWallets.length > 0 ? sourceWallets[0].id : null;
        defaultDest =
          wallets.find((w) => w.id !== defaultSource && w.walletType === 'nwc' && w.isConnected)
            ?.id ??
          wallets.find((w) => w.id !== defaultSource)?.id ??
          null;
      }

      setSourceId(defaultSource);
      setDestId(defaultDest);
      setSatsValue('');
      setStep('main');
      setSending(false);
      setProgressMsg(null);
      setProgress(idleProgress());
      setBackgroundError(null);
      setRetryingRecovery(false);
      setRecoveryAcked(false);
      // NOTE: don't clear `retryInFlightRef` on visible-toggle. If the
      // user closes mid-retry + reopens fast enough that the IIFE is
      // still running, the in-flight ref must stay true so a second
      // tap is correctly rejected — the ref is cleared by the IIFE's
      // own finally block when its work actually completes.
      setSourceDropdownOpen(false);
      setDestDropdownOpen(false);
      // Cross-profile state resets on every open — opening with a
      // stale "other profile" selection from a previous session would
      // be confusing. Default to current-profile (null) which matches
      // the legacy single-profile flow exactly.
      setSelectedProfilePubkey(null);
      setProfileDropdownOpen(false);
      setOtherProfileWallets([]);
      bottomSheetRef.current?.present();
    } else {
      bottomSheetRef.current?.dismiss();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const handler = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => handler.remove();
  }, [visible, onClose]);

  // Cross-profile (#485): load the OTHER profile's wallet list when the
  // user picks a non-active profile from the dropdown. Same-profile or
  // null selection clears the slot. The destination selection is
  // cleared whenever the profile changes — picking a wallet from
  // profile A and then switching to profile B should NOT carry the
  // (now invalid) wallet id over.
  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    if (selectedProfilePubkey === null || selectedProfilePubkey === activePubkey) {
      setOtherProfileWallets([]);
      return;
    }
    (async () => {
      try {
        const list = await getWalletListForPubkey(selectedProfilePubkey);
        if (!cancelled) setOtherProfileWallets(list);
      } catch (e) {
        if (__DEV__) console.warn('[Transfer] cross-profile wallet load failed:', e);
        if (!cancelled) setOtherProfileWallets([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [visible, selectedProfilePubkey, activePubkey]);

  // Track keyboard height for dynamic padding (matches NostrLoginSheet pattern)
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, (e) => {
      setKeyboardHeight(e.endCoordinates.height);
      setTimeout(() => scrollRef.current?.scrollToEnd?.({ animated: true }), 100);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const handleTransfer = async () => {
    if (!sourceId || !destId || !source || !dest || currentSats <= 0) return;
    if (!transferType) return;
    if ((transferType === 'ln-to-onchain' || transferType === 'onchain-to-ln') && !cachedBoltzFees)
      return;

    // A plain local (not React state) so the value is readable in the
    // `finally` block: on a Boltz hand-off we leave the "swap underway —
    // safe to close" message up instead of clearing `sending`/`progressMsg`.
    // React setState is async, so a state flag wouldn't be updated in the
    // same closure by the time `finally` runs; a `let` survives the scope.
    let didHandOff = false;
    // Set just before the pay / broadcast call: past it, a timeout or relay
    // drop leaves the outcome unknown rather than failed (#1778).
    let paymentDispatched = false;

    // Warn if doing a cross-chain swap when a same-chain wallet has funds
    const alternative = findSameChainAlternative(wallets, sourceId, transferType, currentSats);
    if (alternative && (transferType === 'onchain-to-ln' || transferType === 'ln-to-onchain')) {
      const choice = await promptSameChainAlternative(alternative, transferType, formatLocale);
      if (choice === 'cancel') return;
      if (choice === 'switch') {
        setSourceId(alternative.id);
        return;
      }
    }

    // Validate Boltz minimum amount for cross-chain transfers
    if ((transferType === 'ln-to-onchain' || transferType === 'onchain-to-ln') && cachedBoltzFees) {
      if (currentSats < cachedBoltzFees.minAmount) {
        Alert.alert(
          'Amount Too Low',
          `Boltz swap minimum is ${cachedBoltzFees.minAmount.toLocaleString(formatLocale)} sats.`,
        );
        return;
      }
      if (currentSats > cachedBoltzFees.maxAmount) {
        Alert.alert(
          'Amount Too High',
          `Boltz swap maximum is ${cachedBoltzFees.maxAmount.toLocaleString(formatLocale)} sats.`,
        );
        return;
      }
    }

    // High-value confirmation gate (issue #82). Mirrors SendSheet's check
    // so a fat-fingered transfer above the user's threshold gets one
    // explicit "are you sure?" before we fire the swap / payment chain.
    // Run after fee/min/max validation so the prompt never appears for
    // an amount that would have been rejected anyway.
    if (shouldConfirmSend(currentSats, await getSendThreshold(activePubkey))) {
      const fiat =
        btcPrice !== null
          ? ` (${satsToFiatString(currentSats, btcPrice, currency, formatLocale)})`
          : '';
      const confirmed = await new Promise<boolean>((resolve) => {
        Alert.alert(
          'Confirm large move',
          `You're about to move ${currentSats.toLocaleString(formatLocale)} sats${fiat} from ${source.alias} to ${dest.alias}. Tap Confirm to proceed.`,
          [
            { text: 'Cancel', style: 'cancel', onPress: () => resolve(false) },
            { text: 'Confirm', onPress: () => resolve(true) },
          ],
        );
      });
      if (!confirmed) return;
    }

    setSending(true);
    setProgressMsg('Preparing move...');
    // Seed the step-by-step progress display (issue #62). Subsequent
    // setProgress(advanceTransfer(...)) calls walk the active row down
    // the list as each underlying step resolves; the existing
    // setProgressMsg(...) calls keep the per-step sublabel in sync.
    setProgress(startTransfer(transferType));
    console.log(
      `[Transfer] Starting ${transferType}: ${currentSats} sats from ${source.alias} to ${dest.alias}`,
    );

    // Skip pending-tx for cross-profile destinations — that wallet
    // belongs to a different profile and isn't in the active wallets
    // array, so the call would silently no-op anyway.
    const addPendingPair = (outgoing: WalletTransaction, incoming: WalletTransaction) => {
      addPendingTransaction(sourceId, outgoing);
      if (!isCrossProfile) addPendingTransaction(destId, incoming);
    };
    // Boltz swaps add their "Boltz swap in progress" rows only once the swap
    // exists (a stale quote can still reject creation, leaving a phantom row),
    // tagged with the swapId so the settled legs replace exactly those rows.
    const addSwapPlaceholders = (
      swapId: string,
      swapType: 'reverse' | 'submarine',
      sentSats: number,
      receivedSats: number,
    ) => {
      const { outgoing, incoming } = buildSwapPlaceholders({
        swapId,
        swapType,
        sentSats,
        receivedSats,
        nowSeconds: Math.floor(Date.now() / 1000),
      });
      addPendingPair(outgoing, incoming);
    };
    if (transferType === 'ln-to-ln' || transferType === 'onchain-to-onchain') {
      const now = Math.floor(Date.now() / 1000);
      const moveRow = {
        amount: currentSats,
        description: 'Move in progress',
        created_at: now,
        settled_at: null,
        optimistic: true,
      };
      addPendingPair({ ...moveRow, type: 'outgoing' }, { ...moveRow, type: 'incoming' });
    }

    // Cross-profile invoice creation: we can't call
    // `makeInvoiceForWallet` against the OTHER profile's NWC client
    // (it isn't loaded in this provider's session). Fall back to the
    // destination wallet's `lightningAddress` via LNURL-pay, which
    // works for any wallet that publishes a lud16. The pre-flight
    // checks above (crossProfileLnNoAddress) prevent reaching this
    // path with a missing address, so by the time we land here the
    // value is guaranteed present.
    const fetchInvoiceForDest = async (destWallet: WalletState | WalletMetadata) => {
      if (isCrossProfile) {
        if (!destWallet.lightningAddress) {
          throw new Error(
            'Destination wallet has no lightning address. Set one on the destination wallet to receive cross-profile moves.',
          );
        }
        const params = await lnurlService.resolveLightningAddress(destWallet.lightningAddress);
        if (currentSats < params.minSats || currentSats > params.maxSats) {
          throw new Error(
            `Destination accepts ${params.minSats.toLocaleString(formatLocale)}-${params.maxSats.toLocaleString(formatLocale)} sats.`,
          );
        }
        // Respect the destination LNURL's commentAllowed budget — some
        // servers reject the request when a comment is sent but
        // commentAllowed === 0. Truncate to the advertised limit when
        // they accept comments shorter than our default. Mirrors the
        // SendSheet LNURL-pay path.
        const opts: { comment?: string } = {};
        if (params.commentAllowed > 0) {
          opts.comment = 'Move'.slice(0, params.commentAllowed);
        }
        return lnurlService.fetchInvoice(params.callback, currentSats, opts);
      }
      return makeInvoiceForWallet(destWallet.id, currentSats, 'Move');
    };

    try {
      if (transferType === 'ln-to-ln') {
        setProgressMsg('Creating invoice...');
        const invoice = await fetchInvoiceForDest(dest);
        setProgress((p) => advanceTransfer(p)); // invoice → pay
        setProgressMsg('Sending payment...');
        paymentDispatched = true;
        await payInvoiceForWallet(sourceId, invoice);
        setProgress((p) => advanceTransfer(p)); // pay → refresh
      } else if (transferType === 'ln-to-onchain') {
        // Full Boltz reverse swap: LN → on-chain.
        // Foreground: create swap, persist, dispatch LN payment, dismiss sheet.
        // Background: pay the hold invoice while watching for the lockup, and
        // claim once it's verified — the invoice only settles after the claim.
        setProgressMsg('Creating Boltz swap...');
        const address = await onchainService.getNextReceiveAddress(destId);
        const swap = await boltzService.createReverseSwap(address, currentSats, cachedBoltzFees!);
        setProgress((p) => advanceTransfer(p)); // swap → handoff

        // Persist + index full swap state so the claim can be recovered if
        // the app crashes, is force-stopped, or the background task dies.
        const persisted = await persistReverseSwap(swap, address);
        // Lightning leg is the invoice amount; the on-chain leg is at most what
        // Boltz locks (the claim fee comes off at claim time).
        addSwapPlaceholders(swap.id, 'reverse', currentSats, swap.onchainAmount);

        // Kick off the Lightning payment + claim in the background so the
        // user can dismiss the sheet immediately. The swap is persisted, so
        // swapRecoveryService is the safety net if this task dies.
        const onchainAmount = swap.onchainAmount;
        const iifeSession = sessionRef.current;
        // Keep the original destination profile throughout this background swap.
        const destIsCrossProfile = isCrossProfile;
        // Track the stage for actionable background error reporting.
        // message. Surfaces in `console.warn` so it survives the
        // production `transform-remove-console` strip — critical for
        // diagnosing field reports like "swap failed with 'unknown
        // Error'" without having to read the user's screenshot for
        // which sheet stage they got stuck at.
        let stage: ReverseSwapStage = 'payAndLockup';
        (async () => {
          try {
            const claimed = await payAndClaimReverseSwap({
              persisted,
              walletId: sourceId,
              payInvoice: payInvoiceForWallet,
              onStage: (next) => {
                stage = next;
                if (next !== 'claimSwap') return;
                if (sessionRef.current === iifeSession) {
                  setProgressMsg(reverseSwapClaimingMessage(onchainAmount, formatLocale));
                }
                Toast.show({
                  type: 'info',
                  text1: t('swapToast.lockedTitle'),
                  text2: t('swapToast.claimingBody', {
                    amount: onchainAmount.toLocaleString(formatLocale),
                  }),
                  position: 'top',
                  visibilityTime: 5000,
                });
              },
            });
            // Final status: replace the "underway" copy in THIS sheet session
            // only — a reopened sheet belongs to a different transfer.
            if (sessionRef.current === iifeSession) {
              setProgressMsg(reverseSwapCompleteMessage(onchainAmount, claimed.txId, formatLocale));
            }
            completeReverseSwap({
              swapId: swap.id,
              amount: onchainAmount.toLocaleString(formatLocale),
              txId: claimed.txId,
              t,
              deferRefresh: deferSwapRefresh,
              refresh: () => refreshWallets(destIsCrossProfile ? [sourceId] : [sourceId, destId]),
              followSettle: () => followSwapSettle(sourceId, paymentHashFromBolt11(swap.invoice)),
            });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            console.warn(
              `[Transfer] reverse swap ${swap.id.slice(0, 8)} failed at stage="${stage}": ${msg || '(no message)'}`,
            );
            // Payment definitely rejected → no sats left, so the "in progress"
            // rows are phantoms. Ambiguous outcomes keep them (1h age-out).
            if (isReverseSwapNotPaid(e)) {
              markSwapPlaceholdersResolved(swap.id);
              const refreshTasks = [fetchTransactionsForWallet(sourceId)];
              if (!destIsCrossProfile) refreshTasks.push(fetchTransactionsForWallet(destId));
              Promise.all(refreshTasks).catch(() => {});
            }
            // Surface the error on the sheet itself — the previous version
            // only showed a toast and left the progress message stuck on
            // "Swap underway" forever. Users need an in-sheet signal so they
            // can act without having to catch a transient toast. Guarded by
            // the session token so a late failure from a previous transfer
            // cannot paint error state onto a new one.
            if (sessionRef.current === iifeSession) {
              // Coerce empty Error.message to a generic non-empty string
              // so the `backgroundError === null` check downstream behaves
              // consistently — Error.message can be empty in practice
              // (some SDK throws produce blank-message errors) and we need
              // a non-null sentinel to drive the spinner-suppression +
              // Retry-button render paths.
              setBackgroundError(msg || 'Background step failed');
              setProgressMsg(
                'Background step failed — the LN payment reply may have been dropped ' +
                  'by the relay. Your funds are safe; tap "Retry now" to re-check ' +
                  'and broadcast the claim. Otherwise the app will retry automatically on next launch.',
              );
            }
            Toast.show({
              type: 'error',
              text1: t('swapToast.progressTitle'),
              text2: t('swapToast.progressBody'),
              position: 'top',
              visibilityTime: 10000,
            });
          }
        })();

        // Show a terminal "underway" state with the Close button active so
        // the user can dismiss when they're ready. The background task runs
        // independently and will surface completion via toasts.
        setProgressMsg(
          'Boltz swap underway — Lightning payment is being sent and Boltz will lock on-chain funds next. Swaps take a little longer to settle.\n\n' +
            "Safe to close — you'll get a notification when the swap completes. " +
            'Progress also appears in your transaction history.',
        );
        setProgress((p) => completeTransfer(p));
        didHandOff = true;
        return;
      } else if (transferType === 'onchain-to-ln') {
        setProgressMsg('Creating Boltz swap...');
        const invoice = await fetchInvoiceForDest(dest);
        const swap = await createRecoverableSubmarineSwap(
          invoice,
          currentSats,
          sourceId,
          cachedBoltzFees!,
        );

        setProgress((p) => advanceTransfer(p)); // swap → broadcast
        // Foreground: broadcast the on-chain tx (the user's action).
        // Background: wait for Boltz to pay the LN invoice, handle refund path.
        setProgressMsg('Broadcasting on-chain transaction...');
        console.log(
          `[Transfer] Sending ${swap.expectedAmount} sats on-chain to Boltz address ${swap.address}`,
        );
        paymentDispatched = true;
        const lockupTxId = await onchainService.sendTransaction(
          sourceId,
          swap.address,
          swap.expectedAmount,
        );
        // Tag both legs so the settled on-chain lockup + LN receive badge as a
        // Boltz swap rather than generic Sent/Received (#895).
        await swapRecoveryService.recordSubmarineSwapLegs(lockupTxId, invoice, swap.id);
        // On-chain leg is what was broadcast; Lightning leg is the invoice.
        addSwapPlaceholders(swap.id, 'submarine', swap.expectedAmount, currentSats);
        setProgress((p) => advanceTransfer(p)); // broadcast → handoff
        // Background: narrate the 1-conf wait, then refresh once Boltz pays
        // our invoice — the Lightning amount is the invoice amount, not
        // `expectedAmount`, which includes Boltz's fees (#1179).
        const submarineSession = sessionRef.current;
        const submarineWallets = isCrossProfile ? [sourceId] : [sourceId, destId];
        void watchForwardSwap(
          {
            swapId: swap.id,
            invoiceSats: currentSats,
            onMessage: (msg) => {
              if (sessionRef.current === submarineSession) setProgressMsg(msg);
            },
            refreshWallets: () => refreshWallets(submarineWallets),
            onFailed: (msg) => promptSubmarineRefund(swap, sourceId, msg, undefined, formatLocale),
          },
          formatLocale,
        );

        // Terminal "underway" state — user closes when ready. Background
        // task will toast on completion/failure.
        setProgressMsg(
          'Boltz swap underway — on-chain transaction broadcast. Boltz will pay the Lightning invoice next. Swaps take a little longer to settle.\n\n' +
            "Safe to close — you'll get a notification when the swap completes. " +
            'Progress also appears in your transaction history.',
        );
        setProgress((p) => completeTransfer(p));
        didHandOff = true;
        return;
      } else if (transferType === 'onchain-to-onchain') {
        setProgressMsg('Broadcasting on-chain transaction...');
        const address = await onchainService.getNextReceiveAddress(destId);
        paymentDispatched = true;
        await onchainService.sendTransaction(sourceId, address, currentSats);
        setProgress((p) => advanceTransfer(p)); // broadcast → refresh
      }

      setProgressMsg('Refreshing wallets...');

      // Refresh balances and transactions (non-critical; see refreshWallets).
      try {
        await refreshWallets(isCrossProfile ? [sourceId] : [sourceId, destId]);
      } catch {
        console.warn('Post-transfer refresh failed — pull to refresh');
      }

      setProgress((p) => completeTransfer(p));

      // Only ln-to-ln and onchain-to-onchain reach here — Boltz paths return
      // early after handing off to the background task.
      const settleMsg =
        transferType === 'onchain-to-onchain'
          ? `${currentSats.toLocaleString(formatLocale)} sats sent. On-chain funds will arrive after confirmation (~10-60 min).`
          : `${currentSats.toLocaleString(formatLocale)} sats moved.`;

      Alert.alert('Move Complete', settleMsg, [{ text: 'OK', onPress: onClose }]);
    } catch (error) {
      // Stale reverse-swap quote: nothing was created or paid. Back to the
      // filled-in form (not the failed view, which has no Move button) with
      // the server's refreshed fee; the user must review it and tap Move again.
      if (boltzService.isQuoteChangedError(error)) {
        setProgress(idleProgress());
        swapQuote.adopt(error.quote);
        const fee = boltzService.calculateSwapFee(currentSats, error.quote);
        Alert.alert(
          t('sendSheet.quoteChangedTitle'),
          t('sendSheet.moveQuoteChanged', { fee: fee.toLocaleString(formatLocale) }),
        );
        return;
      }
      const kind = classifyTransferError(error, paymentDispatched);
      const message = transferFailureMessage(kind, error, t);
      setProgress((p) => failTransfer(p, message));
      alertTransferFailure(kind, message, t);
    } finally {
      // When a Boltz swap has been handed off to a background IIFE we leave
      // the "Swap underway — safe to close" message visible so the user gets
      // explicit confirmation the transfer is in flight. They close the sheet
      // themselves via the Close button (see dismissal effect below). For
      // synchronous transfers (LN→LN, on-chain→on-chain) and errors, clear
      // state normally.
      if (!didHandOff) {
        setSending(false);
        setProgressMsg(null);
      }
    }
  };

  const handleSheetChange = useCallback(
    (index: number) => {
      if (index === -1) onClose();
    },
    [onClose],
  );

  // Retry handler for the "Retry now" button in the progress view. Kept
  // in the sheet (not TransferProgress) because it orchestrates
  // component state + refs: a synchronous re-entrancy guard so a fast
  // double-tap can't fire two concurrent recoverPendingSwaps() calls
  // before React applies `disabled`, and the session token so a late
  // callback can't paint state onto a subsequent transfer.
  const handleRetryRecovery = useCallback(async () => {
    if (retryInFlightRef.current) return;
    retryInFlightRef.current = true;
    const retrySession = sessionRef.current;
    setRetryingRecovery(true);
    try {
      await swapRecoveryService.recoverPendingSwaps();
      Toast.show({
        type: 'info',
        text1: t('swapToast.retryTitle'),
        text2: t('swapToast.retryBody'),
        position: 'top',
        visibilityTime: 6000,
      });
      if (sessionRef.current === retrySession) {
        // Keep `backgroundError` set so the spinner stays suppressed;
        // flip `recoveryAcked` to swap the message + hide the Retry button.
        setRecoveryAcked(true);
        setProgressMsg('Recovery retried — check transaction history for the final status.');
      }
    } catch (err) {
      const m = err instanceof Error ? err.message : String(err);
      Toast.show({
        type: 'error',
        text1: t('swapToast.retryFailedTitle'),
        text2: m,
        position: 'top',
        visibilityTime: 8000,
      });
    } finally {
      retryInFlightRef.current = false;
      if (sessionRef.current === retrySession) {
        setRetryingRecovery(false);
      }
    }
  }, [t]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />
    ),
    [],
  );

  if (!visible) return null;

  const isBoltzTransfer = transferType === 'ln-to-onchain' || transferType === 'onchain-to-ln';
  const boltzMin = cachedBoltzFees?.minAmount;
  const belowBoltzMin =
    isBoltzTransfer && currentSats > 0 && boltzMin !== undefined && currentSats < boltzMin;
  const overBalance = exceedsSourceBalance(source?.balance, currentSats);
  const canTransfer =
    sourceId &&
    destId &&
    currentSats > 0 &&
    !overBalance &&
    transferType !== null &&
    (!isBoltzTransfer || cachedBoltzFees !== null) &&
    !belowBoltzMin &&
    !crossProfileLnNoAddress;

  // Sorted profile list for the Profile dropdown — active profile
  // first (so its row sits at the top, matching AccountSwitcherSheet),
  // then most-recently-used. Profile dropdown only renders when there
  // is more than one signed-in identity (single-profile users see the
  // legacy 2-dropdown layout unchanged).
  const profileOptions = [...identities].sort((a, b) => {
    if (a.pubkey === activePubkey) return -1;
    if (b.pubkey === activePubkey) return 1;
    return b.lastUsedAt - a.lastUsedAt;
  });

  const showProfileDropdown = profileOptions.length > 1;

  return (
    <BottomSheetModal
      ref={bottomSheetRef}
      onChange={handleSheetChange}
      enablePanDownToClose
      backdropComponent={renderBackdrop}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
      handleIndicatorStyle={styles.handleIndicator}
      backgroundStyle={styles.sheetBackground}
    >
      {step === 'amount' ? (
        <BottomSheetView style={styles.content}>
          <AmountEntryScreen
            initialSats={currentSats}
            title="Move amount"
            minSats={isBoltzTransfer ? boltzMin : undefined}
            maxSats={isBoltzTransfer ? cachedBoltzFees?.maxAmount : undefined}
            confirmLabel="Done"
            onBack={() => setStep('main')}
            onConfirm={(sats) => {
              setSatsValue(String(sats));
              setStep('main');
            }}
          />
        </BottomSheetView>
      ) : (
        <BottomSheetScrollView
          ref={scrollRef}
          style={styles.content}
          contentContainerStyle={{
            ...styles.innerContent,
            paddingBottom: keyboardHeight > 0 ? keyboardHeight + 80 : 40,
          }}
          keyboardShouldPersistTaps="handled"
        >
          <>
            <Text style={styles.title}>Move</Text>

            {/* Source wallet selector */}
            {sending || progress.phase === 'failed' ? (
              /* Progress view — replaces the form while a transfer is
                 executing (`sending`) and stays mounted on failure
                 (`phase === 'failed'`) so the failing step renders its X
                 row. `finally` clears `sending` but leaves the failed
                 progress in place; reopening the sheet resets it to
                 idle. */
              <TransferProgress
                amountSats={currentSats}
                sourceAlias={source?.alias}
                destAlias={dest?.alias}
                feeEstimate={feeEstimate}
                progress={progress}
                progressMsg={progressMsg}
                backgroundError={backgroundError}
                recoveryAcked={recoveryAcked}
                retryingRecovery={retryingRecovery}
                onRetry={handleRetryRecovery}
                onClose={onClose}
              />
            ) : (
              <>
                <Text style={styles.sectionLabel}>From</Text>
                <View style={[styles.dropdownWrapper, sourceDropdownOpen && { zIndex: 20 }]}>
                  <TouchableOpacity
                    style={styles.dropdown}
                    onPress={() => {
                      setSourceDropdownOpen(!sourceDropdownOpen);
                      setDestDropdownOpen(false);
                    }}
                    testID="transfer-source-dropdown"
                    accessibilityLabel="Source wallet"
                  >
                    <Text style={styles.dropdownText}>
                      {source ? formatTransferWalletLabel(source, formatLocale) : 'Select wallet'}
                    </Text>
                    <Text style={styles.dropdownArrow}>
                      {sourceDropdownOpen ? '\u25B2' : '\u25BC'}
                    </Text>
                  </TouchableOpacity>
                  {sourceDropdownOpen && (
                    <View style={styles.dropdownMenu}>
                      {sourceWallets.map((w) => (
                        <TouchableOpacity
                          key={w.id}
                          testID={`transfer-source-${w.id}`}
                          style={[
                            styles.dropdownItem,
                            sourceId === w.id && styles.dropdownItemActive,
                          ]}
                          onPress={() => {
                            setSourceId(w.id);
                            setSourceDropdownOpen(false);
                            setDestId(
                              selectTransferDestination(
                                w,
                                destId,
                                isCrossProfile ? otherProfileWallets : wallets,
                                isCrossProfile,
                              ),
                            );
                          }}
                        >
                          <Text
                            style={[
                              styles.dropdownItemText,
                              sourceId === w.id && styles.dropdownItemTextActive,
                            ]}
                          >
                            {formatTransferWalletLabel(w, formatLocale)}
                            {isExternalFundingSource(w) ? ` · ${t('externalSwap.source')}` : ''}
                          </Text>
                        </TouchableOpacity>
                      ))}
                      {sourceWallets.length === 0 && (
                        <Text style={styles.dropdownEmpty}>No wallets that can send</Text>
                      )}
                    </View>
                  )}
                </View>

                {/* Destination block. With multiple profiles signed in
                    we render `To` as a header followed by both the
                    profile and the wallet dropdown — semantically
                    "pick *who*, then pick *which of their wallets*"
                    (#485). With a single profile, the profile dropdown
                    collapses out and the layout matches the pre-#485
                    flow exactly. */}
                <Text style={styles.sectionLabel}>To</Text>
                {showProfileDropdown && (
                  <View style={[styles.dropdownWrapper, profileDropdownOpen && { zIndex: 15 }]}>
                    <TouchableOpacity
                      style={styles.dropdown}
                      onPress={() => {
                        setProfileDropdownOpen(!profileDropdownOpen);
                        setSourceDropdownOpen(false);
                        setDestDropdownOpen(false);
                      }}
                      testID="transfer-profile-dropdown"
                      accessibilityLabel="Destination profile"
                    >
                      <Text style={styles.dropdownText}>
                        {formatTransferProfileLabel(
                          selectedProfilePubkey ?? activePubkey ?? '',
                          activePubkey,
                          profileNameById,
                        )}
                      </Text>
                      <Text style={styles.dropdownArrow}>
                        {profileDropdownOpen ? '\u25B2' : '\u25BC'}
                      </Text>
                    </TouchableOpacity>
                    {profileDropdownOpen && (
                      <View style={styles.dropdownMenu}>
                        {profileOptions.map((id) => {
                          const isSelected = (selectedProfilePubkey ?? activePubkey) === id.pubkey;
                          return (
                            <TouchableOpacity
                              key={id.pubkey}
                              testID={`transfer-profile-${id.pubkey}`}
                              style={[styles.dropdownItem, isSelected && styles.dropdownItemActive]}
                              onPress={() => {
                                // null = "current profile" so the
                                // legacy code path (no cross-profile
                                // load) fires when the user picks
                                // the active identity explicitly.
                                const next = id.pubkey === activePubkey ? null : id.pubkey;
                                setSelectedProfilePubkey(next);
                                setProfileDropdownOpen(false);
                                // Clearing destId on profile change
                                // — the previously-picked walletId
                                // is from a different list and
                                // would be visually stale.
                                setDestId(null);
                              }}
                            >
                              <Text
                                style={[
                                  styles.dropdownItemText,
                                  isSelected && styles.dropdownItemTextActive,
                                ]}
                              >
                                {formatTransferProfileLabel(
                                  id.pubkey,
                                  activePubkey,
                                  profileNameById,
                                )}
                              </Text>
                            </TouchableOpacity>
                          );
                        })}
                      </View>
                    )}
                  </View>
                )}

                {/* Destination wallet selector — sits under the same
                    `To` header above (and beneath the profile dropdown
                    when one is shown). */}
                <View style={styles.dropdownWrapper}>
                  <TouchableOpacity
                    style={styles.dropdown}
                    onPress={() => {
                      setDestDropdownOpen(!destDropdownOpen);
                      setSourceDropdownOpen(false);
                      setProfileDropdownOpen(false);
                    }}
                    testID="transfer-dest-dropdown"
                    accessibilityLabel="Destination wallet"
                  >
                    <Text style={styles.dropdownText}>
                      {dest ? formatTransferWalletLabel(dest, formatLocale) : 'Select wallet'}
                    </Text>
                    <Text style={styles.dropdownArrow}>
                      {destDropdownOpen ? '\u25B2' : '\u25BC'}
                    </Text>
                  </TouchableOpacity>
                  {destDropdownOpen && (
                    <View style={styles.dropdownMenu}>
                      {destWallets.map((w) => (
                        <TouchableOpacity
                          key={w.id}
                          testID={`transfer-dest-${w.id}`}
                          style={[
                            styles.dropdownItem,
                            destId === w.id && styles.dropdownItemActive,
                          ]}
                          onPress={() => {
                            setDestId(w.id);
                            setDestDropdownOpen(false);
                          }}
                        >
                          <Text
                            style={[
                              styles.dropdownItemText,
                              destId === w.id && styles.dropdownItemTextActive,
                            ]}
                          >
                            {formatTransferWalletLabel(w, formatLocale)}
                          </Text>
                        </TouchableOpacity>
                      ))}
                    </View>
                  )}
                </View>

                {externalFunding ? (
                  <ExternalFundingSwap
                    key={`${sourceId}-${destId}-${selectedProfilePubkey}`}
                    sourceId={sourceId!}
                    dest={dest?.walletType === 'nwc' ? dest : null}
                    crossProfile={isCrossProfile}
                    onClose={onClose}
                  />
                ) : (
                  <>
                    {/* Amount picker — opens dedicated amount-entry step */}
                    <Text style={styles.sectionLabel}>Amount</Text>
                    <TouchableOpacity
                      style={styles.amountPickerRow}
                      onPress={() => setStep('amount')}
                      testID="transfer-amount-picker"
                      accessibilityLabel="Enter move amount"
                    >
                      {currentSats > 0 ? (
                        <>
                          <Text style={styles.amountPickerValue}>
                            {currentSats.toLocaleString(formatLocale)} sats
                          </Text>
                          {btcPrice ? (
                            <Text style={styles.amountPickerFiat}>
                              {satsToFiatString(currentSats, btcPrice, currency, formatLocale)}
                            </Text>
                          ) : null}
                        </>
                      ) : (
                        <Text style={styles.amountPickerPlaceholder}>Enter amount</Text>
                      )}
                    </TouchableOpacity>

                    <TransferSwapQuoteStatus {...swapQuote} styles={styles} />

                    {/* Fee estimate */}
                    {feeEstimate && (
                      <View style={styles.feeRow}>
                        {(transferType === 'ln-to-onchain' || transferType === 'onchain-to-ln') && (
                          <TouchableOpacity
                            onPress={() => Linking.openURL('https://boltz.exchange')}
                            hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                          >
                            <Image
                              source={require('../../assets/images/boltz-logo.png')}
                              style={styles.boltzLogo}
                              resizeMode="contain"
                            />
                          </TouchableOpacity>
                        )}
                        <View style={styles.feeLines}>
                          <Text style={styles.feeText}>
                            Estimated fee: {feeEstimate.split('\u00B7')[0].trim()}
                          </Text>
                          {feeEstimate.includes('\u00B7') && (
                            <Text style={styles.feeText}>
                              Estimated time: {feeEstimate.split('\u00B7')[1].trim()}
                            </Text>
                          )}
                        </View>
                      </View>
                    )}

                    {/* Boltz minimum amount warning */}
                    {belowBoltzMin && (
                      <Text style={styles.warningText}>
                        Boltz swaps require a minimum of {boltzMin?.toLocaleString(formatLocale)}{' '}
                        sats.
                      </Text>
                    )}

                    {overBalance && source && (
                      <Text style={styles.warningText} testID="transfer-over-balance">
                        {t('transferSheet.amountExceedsBalance', {
                          wallet: source.alias,
                          balance: (source.balance ?? 0).toLocaleString(formatLocale),
                        })}
                      </Text>
                    )}

                    {/* Cross-profile LN without lightning address — see #485.
                    NWC-based invoice creation against another profile's
                    wallet isn't wired up yet (would require running that
                    profile's NWC client out-of-band). LNURL-pay via the
                    destination's lud16 is the only cross-profile LN path
                    today; this surfaces a clear remediation. */}
                    {crossProfileLnNoAddress && (
                      <Text style={styles.warningText} testID="transfer-cross-profile-no-lud16">
                        Set a lightning address on the destination wallet to receive cross-profile
                        moves. On-chain destinations work without one.
                      </Text>
                    )}

                    {/* Action buttons */}
                    <View style={styles.buttonRow}>
                      <TouchableOpacity
                        style={styles.cancelButton}
                        onPress={onClose}
                        testID="transfer-cancel"
                        accessibilityLabel="Cancel move"
                      >
                        <Text style={styles.cancelButtonText}>Cancel</Text>
                      </TouchableOpacity>
                      <TouchableOpacity
                        style={[
                          styles.transferButton,
                          (!canTransfer || sending) && styles.buttonDisabled,
                        ]}
                        onPress={() => runTransferOnce(handleTransfer)}
                        disabled={!canTransfer || sending}
                        testID="transfer-execute"
                        accessibilityLabel="Execute move"
                      >
                        <Text style={styles.transferButtonText}>Move</Text>
                      </TouchableOpacity>
                    </View>
                  </>
                )}
              </>
            )}
          </>
        </BottomSheetScrollView>
      )}
    </BottomSheetModal>
  );
};

export default TransferSheet;
