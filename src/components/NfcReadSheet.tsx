import BrandedSpinner from './BrandedSpinner';
import React, { useState, useRef, useEffect, useLayoutEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  BackHandler,
  AppState,
  type AppStateStatus,
} from 'react-native';
import {
  BottomSheetBackdrop,
  BottomSheetBackdropProps,
  BottomSheetView,
} from '@gorhom/bottom-sheet';
import { BottomSheetModal } from './AccessibleBottomSheetModal';
import { AlertCircle, Nfc, PartyPopper, PiggyBank } from 'lucide-react-native';
import { readHuntTagPayload, cancelNfcOperation } from '../services/nfcService';
import { paymentHashFromBolt11 } from '../utils/bolt11';
import {
  LnurlWithdrawError,
  decodeLnurlWithdraw,
  type LnurlWithdrawParams,
  claimLnurlWithdraw,
  resolveLnurlWithdraw,
} from '../services/lnurlWithdrawService';
import { recordClaim } from '../services/claimHistoryService';
import { friendlyClaimError } from '../utils/claimErrorMessage';
import { SLEEPING_PATTERN, parseCooldownSeconds, formatCountdown } from '../utils/lnurlCooldown';
import { useThemeColors } from '../contexts/ThemeContext';
import { useLocale } from '../contexts/LocaleContext';
import { useWallet, useWalletLive } from '../contexts/WalletContext';
import { createNfcReadSheetStyles } from '../styles/NfcReadSheet.styles';
import PrizeWalletPicker from './PrizeWalletPicker';
import NfcScanIndicator from './NfcScanIndicator';
import AddWalletWizard from './AddWalletWizard';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Cache coord we expect the tag to belong to. If the tag's `coord`
   * field doesn't match, the read is rejected with a "wrong Piglet"
   * error rather than silently letting the user claim against the
   * wrong cache. */
  expectedCoord: string;
}

// Sheet lifecycle: from 'ready' (waiting for the user to tap a tag) all
// the way through to the prize outcome. Pre-fix, the sheet handed off
// to a separate HuntFoundScreen after extracting the LNURL — too much
// navigation churn for a one-tap action. The full flow now stays
// in-sheet so the user lands back on the cache detail (with the find-
// log composer already in view) the moment they dismiss.
type SheetStage =
  | 'ready'
  | 'reading'
  | 'confirm'
  | 'resolving'
  | 'withdraw'
  | 'claiming'
  | 'claimed'
  | 'sleeping'
  | 'error';

const NfcReadSheet: React.FC<Props> = ({ visible, onClose, expectedCoord }) => {
  const colors = useThemeColors();
  const { t, formatLocale } = useLocale();
  const styles = useMemo(() => createNfcReadSheetStyles(colors), [colors]);
  const { wallets, makeInvoiceForWallet, expectPayment } = useWallet();
  const { lastIncomingPayment } = useWalletLive();
  const [stage, setStage] = useState<SheetStage>('ready');
  const [withdrawal, setWithdrawal] = useState<{
    lnurl: string;
    host: string;
    params?: LnurlWithdrawParams;
  } | null>(null);
  const sessionRef = useRef(0);
  const busyRef = useRef(false);
  useLayoutEffect(() => {
    sessionRef.current += 1;
    busyRef.current = false;
    setWithdrawal(null);
    return () => {
      sessionRef.current += 1;
    };
  }, [visible, expectedCoord]);
  const [errorMessage, setErrorMessage] = useState('');
  const [claimedSats, setClaimedSats] = useState<number | null>(null);
  // Only Lightning (NWC) wallets can mint a bolt11 invoice for the prize.
  const lightningWallets = useMemo(() => wallets.filter((w) => w.walletType === 'nwc'), [wallets]);
  const [selectedWalletId, setSelectedWalletId] = useState<string | null>(
    lightningWallets[0]?.id ?? null,
  );
  const [wizardOpen, setWizardOpen] = useState(false);
  // Default to the first Lightning wallet (Home-screen order); keep a manual pick while it's valid.
  useEffect(() => {
    const stillValid =
      selectedWalletId !== null && lightningWallets.some((w) => w.id === selectedWalletId);
    if (stillValid) return;
    setSelectedWalletId(lightningWallets[0]?.id ?? null);
  }, [lightningWallets, selectedWalletId]);
  // Remaining-seconds counter that ticks down each second in the
  // sleeping state — null when the LNURLw's response doesn't carry a
  // time hint (budget exhausted, generic 'already used', etc.).
  const [cooldownRemaining, setCooldownRemaining] = useState<number | null>(null);
  const sheetRef = useRef<BottomSheetModal>(null);
  const snapPoints = useMemo(() => ['55%'], []);
  const mountedRef = useRef(true);
  // Stamped at the moment we enter `claimed` (LNURL-w issuer accepted
  // our invoice). The auto-dismiss effect below uses both this AND
  // the expected payment hash to scope which `lastIncomingPayment`
  // events are "our" settlement — otherwise an unrelated incoming
  // payment to a different wallet (or even the same wallet, e.g.
  // someone Zapping you mid-claim) would close the sheet prematurely.
  const claimedAtRef = useRef<number | null>(null);
  // Payment hash extracted from our claim's bolt11. The wallet
  // context fills `IncomingPayment.paymentHash` whenever detection
  // came through expectPayment's hash-keyed path (vs the
  // balance-diff fallback). When it matches, we know THIS settlement
  // is ours — not some coincidental wallet credit.
  const expectedPaymentHashRef = useRef<string | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Auto-dismiss the sheet when the actual bolt11 settlement lands
  // for our claim. The app-root `GlobalIncomingPaymentOverlay`
  // already pops the confetti celebration on every
  // `lastIncomingPayment` event — but its native Modal layer sits
  // BELOW the bottom-sheet's portal while we're open, so the user
  // can't see the celebration until they dismiss. Closing the sheet
  // automatically reveals the overlay on HuntPiggyDetail with the
  // exact same animation Home shows, no duplicated celebration
  // code. The 250 ms timeout lets the success state's "X sats
  // inbound!" copy register first before the sheet animates away.
  useEffect(() => {
    if (
      stage !== 'claimed' ||
      !lastIncomingPayment ||
      !claimedAtRef.current ||
      lastIncomingPayment.at < claimedAtRef.current
    ) {
      return;
    }
    // Tightened scope per Copilot #580 r1: the bare timestamp gate
    // would dismiss the sheet on ANY incoming payment that happens
    // to land after the claim moment (different wallet, unrelated
    // zap, balance-poll detecting an unrelated credit, …). Match on
    // walletId AND, when the wallet detected via the expectPayment
    // hash-keyed path, also match the payment hash to be sure this
    // settlement is the one we just kicked off. If detection came
    // via balance-diff (paymentHash === null), we fall back to
    // walletId + the post-claim timestamp window — the best we can
    // do without an invoice hash.
    if (lastIncomingPayment.walletId !== selectedWalletId) return;
    if (
      expectedPaymentHashRef.current &&
      lastIncomingPayment.paymentHash &&
      lastIncomingPayment.paymentHash !== expectedPaymentHashRef.current
    ) {
      return;
    }
    const t = setTimeout(() => {
      if (mountedRef.current) onClose();
    }, 250);
    return () => clearTimeout(t);
  }, [lastIncomingPayment, stage, onClose, selectedWalletId]);

  const startRead = useCallback(async () => {
    const session = ++sessionRef.current;
    busyRef.current = false;
    setWithdrawal(null);
    setErrorMessage('');
    setClaimedSats(null);
    // Skip the synchronous `isNfcEnabled()` pre-flight here so we
    // can call requestTechnology (which is what activates Android
    // reader-mode and stops the OS NDEF dispatcher from showing
    // "Open with…") as quickly as possible after the sheet opens.
    // Each native round-trip on Android costs ~100 ms; the previous
    // pre-flight gave a fast hider enough time to bring the tag to
    // the phone BEFORE reader-mode came up, so the OS chooser
    // intercepted. If NFC is actually disabled, readHuntTagPayload's
    // `ensureNfcStarted()` returns false and surfaces the same error
    // message below.
    setStage('ready');
    try {
      const result = await readHuntTagPayload({
        onTagDetected: () => {
          if (mountedRef.current && session === sessionRef.current) setStage('reading');
        },
      });
      if (!mountedRef.current || session !== sessionRef.current) return;
      if (result.coord && expectedCoord && result.coord !== expectedCoord) {
        throw new Error(t('nfcReadSheet.wrongPiglet'));
      }
      if (!result.lnurl) {
        throw new Error(t('nfcReadSheet.noPrizeLink'));
      }
      if (!selectedWalletId) {
        throw new Error(t('nfcReadSheet.noWalletConnected'));
      }
      if (!mountedRef.current) return;
      const host = new URL(decodeLnurlWithdraw(result.lnurl)).host;
      setWithdrawal({ lnurl: result.lnurl, host });
      setStage('confirm');
    } catch (err) {
      if (mountedRef.current && session === sessionRef.current) {
        setStage('error');
        const raw = err instanceof Error ? err.message : t('nfcReadSheet.failedToReadTag');
        // Map nfcService's `NFC unavailable on this device` (raised by
        // ensureNfcStarted when NfcManager.start() rejected, which is
        // the disabled-NFC path on Android) to the same friendlier
        // "NFC is turned off" copy the write / unlock sheets show.
        // Pre-fix (Copilot #580 r1) dropping isNfcEnabled() left the
        // user with a bare "NFC unavailable" message inconsistent with
        // the other sheets in the family.
        const isDisabled = /NFC unavailable on this device/i.test(raw);
        setErrorMessage(isDisabled ? t('nfcReadSheet.nfcTurnedOff') : raw);
      }
    }
  }, [expectedCoord, selectedWalletId, t]);

  const handleResolve = async () => {
    if (!withdrawal || stage !== 'confirm' || busyRef.current || !visible) return;
    busyRef.current = true;
    const session = sessionRef.current;
    setStage('resolving');
    try {
      const params = await resolveLnurlWithdraw(withdrawal.lnurl);
      if (!mountedRef.current || session !== sessionRef.current) return;
      if (params.maxWithdrawable <= 0) {
        setStage('sleeping');
        setCooldownRemaining(null);
      } else {
        setWithdrawal({ ...withdrawal, params });
        setStage('withdraw');
      }
    } catch (e) {
      if (!mountedRef.current || session !== sessionRef.current) return;
      const reason = e instanceof Error ? e.message : t('nfcReadSheet.couldntClaim');
      setStage(SLEEPING_PATTERN.test(reason) ? 'sleeping' : 'error');
      setErrorMessage(reason);
      setCooldownRemaining(parseCooldownSeconds(reason));
    } finally {
      if (session === sessionRef.current) busyRef.current = false;
    }
  };

  const handleClaim = async () => {
    if (
      !withdrawal?.params ||
      !selectedWalletId ||
      stage !== 'withdraw' ||
      busyRef.current ||
      !visible
    )
      return;
    busyRef.current = true;
    const session = sessionRef.current;
    const params = withdrawal.params;
    setStage('claiming');
    try {
      const claim = await claimLnurlWithdraw(params, async (sats, memo) =>
        makeInvoiceForWallet(selectedWalletId, sats, memo),
      );
      if (!mountedRef.current || session !== sessionRef.current) return;
      await recordClaim({
        lnurl: withdrawal.lnurl,
        sats: claim.sats,
        piggyId: expectedCoord,
      });
      if (!mountedRef.current || session !== sessionRef.current) return;
      setClaimedSats(claim.sats);
      // Stamp the claim moment so the auto-dismiss effect above
      // only reacts to bolt11 settlements that land AFTER this
      // point — unrelated wallet activity that happened before
      // the user tapped Try prize must not close the sheet.
      claimedAtRef.current = Date.now();
      setStage('claimed');
      // Kick off 1 s aggressive polling for THIS bolt11 in the
      // wallet context, so `lastIncomingPayment` fires within ~1 s
      // of LNbits actually paying our invoice. Without it, the
      // baseline 30 s balance poll is the only signal, which means
      // the sheet sits on "X sats inbound!" for up to half a
      // minute and the user manually taps Done before the auto-
      // dismiss + confetti can fire (#579 follow-up).
      if (selectedWalletId) {
        const paymentHash = paymentHashFromBolt11(claim.bolt11);
        if (paymentHash) {
          // Stash so the auto-dismiss effect can match against
          // `lastIncomingPayment.paymentHash` — defends against
          // unrelated incoming payments triggering close.
          expectedPaymentHashRef.current = paymentHash;
          expectPayment(selectedWalletId, paymentHash, claim.sats);
        }
      }
    } catch (e) {
      if (!mountedRef.current || session !== sessionRef.current) return;
      const reason =
        e instanceof LnurlWithdrawError ? e.message : ((e as Error).message ?? 'Unknown error');
      if (SLEEPING_PATTERN.test(reason)) {
        setStage('sleeping');
        setErrorMessage(reason);
        setCooldownRemaining(parseCooldownSeconds(reason));
      } else {
        setStage('error');
        // LNURL-withdraw issuer errors (cache empty, cooldown, already
        // claimed) are meaningful — show as-is. Wallet-side NWC/relay
        // failures surface a cryptic SDK string, so map those to friendly
        // copy (#734).
        const friendly = e instanceof LnurlWithdrawError ? null : friendlyClaimError(reason);
        setErrorMessage(friendly ?? reason);
      }
    }
  };

  useEffect(() => {
    if (visible) {
      setStage('ready');
      setErrorMessage('');
      setClaimedSats(null);
      setCooldownRemaining(null);
      claimedAtRef.current = null;
      expectedPaymentHashRef.current = null;
      sheetRef.current?.present();
      // Don't arm the reader with nowhere to send the prize; the empty state shows Add wallet instead.
      if (hasLightningWalletRef.current) startRead();
    } else {
      sheetRef.current?.dismiss();
      cancelNfcOperation();
      setStage('ready');
      setErrorMessage('');
      setClaimedSats(null);
      setCooldownRemaining(null);
      setWizardOpen(false);
      claimedAtRef.current = null;
      expectedPaymentHashRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, expectedCoord]);

  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      handleClose();
      return true;
    });
    return () => sub.remove();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible]);

  // Re-arm the foreground NFC reader when the user returns from
  // background. Android pauses the reader session on app onPause
  // (visible in logcat as 'ReactNativeNfcManager: disableReaderMode'),
  // and the SDK doesn't automatically resume on the next onResume.
  // Without this, swiping away to another app even briefly leaves the
  // sheet stuck on 'Waiting for NFC tag…' with no actual reader active.
  //
  // Stash stage + startRead in refs so the effect's dep array stays at
  // just `visible`. Otherwise startRead's own dep on `makeInvoice`
  // (which can churn when WalletProvider re-renders) makes this effect
  // re-subscribe every render — earlier shape triggered React's
  // 'Maximum update depth exceeded' guard on the Pixel.
  const stageRef = useRef(stage);
  const startReadRef = useRef(startRead);
  // Lets the present-on-visible effect decide whether to arm the reader without re-subscribing on wallet churn.
  const hasLightningWalletRef = useRef(lightningWallets.length > 0);
  useEffect(() => {
    stageRef.current = stage;
    startReadRef.current = startRead;
    hasLightningWalletRef.current = lightningWallets.length > 0;
  }, [stage, startRead, lightningWallets.length]);
  useEffect(() => {
    if (!visible) return;
    let lastState = AppState.currentState;
    const sub = AppState.addEventListener('change', (next) => {
      const wasBackground = lastState === 'background' || lastState === 'inactive';
      lastState = next;
      if (next === 'active' && wasBackground && stageRef.current === 'ready') {
        console.log('[NFC] App resumed during ready state — re-arming reader');
        startReadRef.current();
      }
    });
    return () => sub.remove();
  }, [visible]);

  // Arm the reader once a Lightning wallet lands while sitting open in 'ready' (e.g. just finished Add wallet).
  const hadLightningWalletRef = useRef(lightningWallets.length > 0);
  useEffect(() => {
    if (!visible) {
      hadLightningWalletRef.current = lightningWallets.length > 0;
      return;
    }
    const hasNow = lightningWallets.length > 0;
    if (hasNow && !hadLightningWalletRef.current && stageRef.current === 'ready') {
      startReadRef.current();
    }
    hadLightningWalletRef.current = hasNow;
  }, [visible, lightningWallets.length]);

  // Tick the countdown each second while sleeping. Stops at 0 — the
  // Try Again button then re-runs the claim and either succeeds (if
  // the LNURLw cooldown actually elapsed) or surfaces a fresh
  // 'Wait N' from the server.
  useEffect(() => {
    if (stage !== 'sleeping' || cooldownRemaining === null || cooldownRemaining <= 0) return;
    const t = setInterval(() => {
      setCooldownRemaining((n) => (n === null || n <= 0 ? n : n - 1));
    }, 1000);
    return () => clearInterval(t);
  }, [stage, cooldownRemaining]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />
    ),
    [],
  );

  const handleRetry = () => {
    cancelNfcOperation();
    startRead();
  };

  const handleClose = () => {
    sessionRef.current += 1;
    busyRef.current = true;
    cancelNfcOperation();
    onClose();
  };

  return (
    <>
      <BottomSheetModal
        ref={sheetRef}
        snapPoints={snapPoints}
        enablePanDownToClose
        onDismiss={handleClose}
        backdropComponent={renderBackdrop}
        backgroundStyle={styles.sheetBackground}
        handleIndicatorStyle={styles.handleIndicator}
      >
        <BottomSheetView style={styles.content}>
          <Text style={styles.title}>{t('nfcReadSheet.title')}</Text>

          {stage === 'ready' && (
            <View style={styles.stateContainer}>
              {/* Shared with SendSheet's NFC mode — ring spins only while armed. */}
              <View style={styles.readyIndicator}>
                <NfcScanIndicator spinning={lightningWallets.length > 0} />
              </View>
              <Text style={styles.instruction}>{t('nfcReadSheet.holdPiglet')}</Text>
              <Text style={styles.description}>{t('nfcReadSheet.willReadTag')}</Text>
              <PrizeWalletPicker
                lightningWallets={lightningWallets}
                selectedWalletId={selectedWalletId}
                onSelect={setSelectedWalletId}
                onAddWallet={() => setWizardOpen(true)}
                colors={colors}
              />
            </View>
          )}

          {(stage === 'confirm' || stage === 'withdraw') && withdrawal && (
            <View style={styles.stateContainer}>
              <Text style={styles.instruction}>
                {t('linkAction.withdraw', { target: withdrawal.host })}
              </Text>
              {stage === 'withdraw' && withdrawal.params && (
                <Text style={styles.description} testID="nfc-read-amount">
                  {t('linkAction.withdrawSats', {
                    amount: Math.floor(withdrawal.params.maxWithdrawable / 1000).toLocaleString(
                      formatLocale,
                    ),
                  })}
                </Text>
              )}
              {stage === 'withdraw' && (
                <PrizeWalletPicker
                  lightningWallets={lightningWallets}
                  selectedWalletId={selectedWalletId}
                  onSelect={setSelectedWalletId}
                  onAddWallet={() => setWizardOpen(true)}
                  colors={colors}
                />
              )}
              <TouchableOpacity
                style={styles.primaryButton}
                disabled={stage === 'withdraw' && !selectedWalletId}
                testID={stage === 'confirm' ? 'nfc-read-resolve' : 'nfc-read-withdraw'}
                accessibilityLabel={t(
                  stage === 'confirm' ? 'linkAction.continue' : 'linkAction.withdrawButton',
                )}
                onPress={stage === 'confirm' ? handleResolve : handleClaim}
              >
                <Text style={styles.primaryButtonText}>
                  {t(stage === 'confirm' ? 'linkAction.continue' : 'linkAction.withdrawButton')}
                </Text>
              </TouchableOpacity>
            </View>
          )}

          {(stage === 'reading' || stage === 'resolving' || stage === 'claiming') && (
            <View style={styles.stateContainer}>
              <BrandedSpinner size="large" />
              <Text style={styles.instruction}>
                {stage === 'reading' ? t('nfcReadSheet.reading') : t('nfcReadSheet.claimingSats')}
              </Text>
            </View>
          )}

          {stage === 'claimed' && (
            <View style={styles.stateContainer}>
              <View style={[styles.iconContainer, styles.successIcon]}>
                <PartyPopper size={64} color={colors.green} strokeWidth={2} />
              </View>
              <Text style={styles.instruction}>
                {t('nfcReadSheet.satsInbound', {
                  sats: claimedSats?.toLocaleString(formatLocale) ?? '',
                })}
              </Text>
              <Text style={styles.description}>{t('nfcReadSheet.sentToWallet')}</Text>
              <TouchableOpacity
                style={styles.primaryButton}
                onPress={handleClose}
                accessibilityLabel={t('nfcReadSheet.dismissPrizeSheet')}
                testID="nfc-read-done"
              >
                <Text style={styles.primaryButtonText}>{t('nfcReadSheet.done')}</Text>
              </TouchableOpacity>
            </View>
          )}

          {stage === 'sleeping' && (
            <View style={styles.stateContainer}>
              <View style={[styles.iconContainer, styles.sleepingIcon]}>
                <PiggyBank size={64} color={colors.brandPink} strokeWidth={2} />
                <Text style={styles.zzzBadge}>Zzz</Text>
              </View>
              <Text style={styles.instruction}>{t('nfcReadSheet.piggySnoozing')}</Text>
              {cooldownRemaining !== null && cooldownRemaining > 0 ? (
                <>
                  <Text style={styles.countdown} testID="nfc-read-sleep-countdown">
                    {formatCountdown(cooldownRemaining)}
                  </Text>
                  <Text style={styles.description}>{t('nfcReadSheet.anotherFinder')}</Text>
                </>
              ) : cooldownRemaining === 0 ? (
                <Text style={styles.description}>{t('nfcReadSheet.piggyIsUp')}</Text>
              ) : (
                <Text style={styles.description}>{t('nfcReadSheet.troughEmpty')}</Text>
              )}
              <View style={styles.errorButtons}>
                <TouchableOpacity
                  style={styles.retryButton}
                  onPress={handleRetry}
                  accessibilityLabel={t('nfcReadSheet.tryAgainAccessibility')}
                  testID="nfc-read-sleep-retry"
                >
                  <Text style={styles.retryButtonText}>{t('nfcReadSheet.tryAgain')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.cancelButton}
                  onPress={handleClose}
                  accessibilityLabel={t('nfcReadSheet.dismiss')}
                  testID="nfc-read-sleep-cancel"
                >
                  <Text style={styles.cancelButtonText}>{t('nfcReadSheet.cancel')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {stage === 'error' && (
            <View style={styles.stateContainer}>
              <View style={[styles.iconContainer, styles.errorIcon]}>
                <Nfc size={64} color={colors.red} strokeWidth={2} />
                <View style={styles.errorBadge}>
                  <AlertCircle size={26} color={colors.red} strokeWidth={2.5} />
                </View>
              </View>
              <Text style={styles.instruction}>{t('nfcReadSheet.couldntClaim')}</Text>
              <Text style={styles.description}>{errorMessage}</Text>
              <View style={styles.errorButtons}>
                <TouchableOpacity
                  style={styles.retryButton}
                  onPress={handleRetry}
                  accessibilityLabel={t('nfcReadSheet.retry')}
                  testID="nfc-read-retry"
                >
                  <Text style={styles.retryButtonText}>{t('nfcReadSheet.tryAgain')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.cancelButton}
                  onPress={handleClose}
                  accessibilityLabel={t('nfcReadSheet.cancel')}
                  testID="nfc-read-error-cancel"
                >
                  <Text style={styles.cancelButtonText}>{t('nfcReadSheet.cancel')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}
        </BottomSheetView>
      </BottomSheetModal>
      <AddWalletWizard visible={wizardOpen} onClose={() => setWizardOpen(false)} />
    </>
  );
};

export default NfcReadSheet;
