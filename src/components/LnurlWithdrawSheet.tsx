import BrandedSpinner from './BrandedSpinner';
/**
 * Global LNURL-withdraw claim bottom sheet (#341).
 *
 * Opened imperatively from the deep-link handler (App.tsx) when a standalone
 * `lightning:lnurl…` / `lnurlw://…` tag or link is tapped — i.e. a plain
 * LNURL-withdraw voucher (gift card, bounty sticker), NOT a Hunt/Piglet
 * geo-cache (those keep the full HuntFoundScreen via their own coord route).
 *
 * Deliberately generic — Gift icon, "Claim funds" copy, no Piggy branding,
 * presented as a bottom sheet over whatever screen the user is on rather than
 * a full-screen page.
 *
 * Flow: confirm issuer → resolve LUD-03 → show amount and destination wallet
 * → explicit Withdraw tap → claim into the chosen
 * Lightning wallet. On settle the app-root celebration fires and the sheet
 * auto-dismisses.
 */
import { decodeLnurlWithdraw } from '../services/lnurlWithdrawService';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Keyboard, Platform } from 'react-native';
import {
  BottomSheetBackdrop,
  BottomSheetBackdropProps,
  BottomSheetScrollView,
  BottomSheetTextInput,
} from '@gorhom/bottom-sheet';
import { BottomSheetModal } from './AccessibleBottomSheetModal';
import { Gift, PartyPopper } from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useWallet, useWalletLive } from '../contexts/WalletContext';
import {
  LnurlWithdrawError,
  LnurlWithdrawParams,
  claimLnurlWithdraw,
  resolveLnurlWithdraw,
} from '../services/lnurlWithdrawService';
import { recordClaim } from '../services/claimHistoryService';
import { paymentHashFromBolt11 } from '../utils/bolt11';
import { formatFiatApprox } from '../utils/fiat';
import { friendlyClaimError } from '../utils/claimErrorMessage';
import { SLEEPING_PATTERN, parseCooldownSeconds, formatCountdown } from '../utils/lnurlCooldown';
import { AmountSlider } from './AmountSlider';
import PrizeWalletPicker from './PrizeWalletPicker';
import AddWalletWizard from './AddWalletWizard';
import { createLnurlWithdrawSheetStyles } from '../styles/LnurlWithdrawSheet.styles';
import { useLocale } from '../contexts/LocaleContext';

// Imperative open — mirrors the BrandedAlert host pattern so the global
// deep-link handler can pop the sheet without a screen in scope.
let listener: ((lnurl: string, walletId?: string, requireConfirmation?: boolean) => void) | null =
  null;
/** Open the global withdraw sheet for `lnurl`. Returns false if the host
 *  isn't mounted yet (cold launch race) so the caller can retry.
 *
 *  `requireConfirmation` (default true) shows the "Withdraw from <host>"
 *  consent step BEFORE the endpoint is fetched. Pass false ONLY when the
 *  caller has already obtained consent for this exact link and resolved it
 *  (the App deep-link router after `resolveLnurlDirection`) — the sheet then
 *  starts resolving straight away. Either way the amount + Withdraw tap are
 *  always required: nothing can auto-claim (#1500). */
export function openLnurlWithdrawSheet(
  lnurl: string,
  walletId?: string,
  requireConfirmation = true,
): boolean {
  if (listener) {
    listener(lnurl, walletId, requireConfirmation);
    return true;
  }
  return false;
}

type Stage =
  | { kind: 'idle' }
  | { kind: 'confirm' }
  | { kind: 'resolving' }
  | { kind: 'ready'; params: LnurlWithdrawParams }
  | { kind: 'claiming' }
  // `remaining` drives the live countdown (null = no time hint from the server).
  | { kind: 'sleeping'; remaining: number | null }
  | { kind: 'claimed'; sats: number }
  | { kind: 'error'; reason: string };

interface LnurlWithdrawHostProps {
  /** Called with the endpoint URL when the link turns out to be an LNURL-pay
   *  (`payRequest`) rather than a voucher — e.g. a bare `lnurl://` or a scanned
   *  `lnurl1…`, whose direction is only known once resolved. The host closes
   *  itself and hands over; the Send sheet still asks for the amount and the
   *  Send tap, so nothing is paid without the user confirming. A prop rather
   *  than a direct `navigateToSend` import to avoid a require cycle
   *  (AppNavigator → HomeScreen → ReceiveSheet → this file). */
  onPayLink?: (url: string) => void;
}

export function LnurlWithdrawHost({ onPayLink }: LnurlWithdrawHostProps = {}): React.ReactElement {
  const colors = useThemeColors();
  const { t, formatLocale } = useLocale();
  const styles = useMemo(() => createLnurlWithdrawSheetStyles(colors), [colors]);
  const { wallets, activeWalletId, makeInvoiceForWallet, currency, expectPayment } = useWallet();
  const { btcPrice, lastIncomingPayment } = useWalletLive();

  const sheetRef = useRef<BottomSheetModal>(null);
  // Untyped like NostrLoginSheet's scrollRef — the gorhom ScrollView ref methods
  // type omits scrollToEnd, which the underlying RN ScrollView does expose.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const scrollRef = useRef<any>(null);
  const mountedRef = useRef(true);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );

  const [lnurl, setLnurl] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'idle' });
  const [amountSats, setAmountSats] = useState<number>(0);
  // Track keyboard height so the scroll content can pad past the IME — without
  // this the sheet doesn't lift on Android and the keypad covers the amount
  // input / slider / Redeem button. See TROUBLESHOOTING → "Bottom sheet doesn't
  // slide up when keyboard opens" + NostrLoginSheet (the reference).
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  // Whether the sheet is currently presented. The keyboard listeners are
  // gated on this (audit LOW 5): the host is always mounted at app root
  // (App.tsx), so without the gate its two `Keyboard.addListener`s fired
  // `setKeyboardHeight` on EVERY app-wide keyboard open/close — a DM
  // composer, a search box, anything — even though this sheet was idle.
  // Driven by the modal's `onChange` below (index ≥ 0 = open).
  const [sheetOpen, setSheetOpen] = useState(false);
  useEffect(() => {
    if (!sheetOpen) return;
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
  }, [sheetOpen]);

  // Destination-wallet chooser (same model as the geo-cache prize sheet): only
  // Lightning (NWC) wallets can mint a bolt11 to receive the withdrawal.
  const lightningWallets = useMemo(() => wallets.filter((w) => w.walletType === 'nwc'), [wallets]);
  const [selectedWalletId, setSelectedWalletId] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  // Default to the first Lightning wallet; keep a manual pick while it's valid.
  useEffect(() => {
    const stillValid =
      selectedWalletId !== null && lightningWallets.some((w) => w.id === selectedWalletId);
    if (stillValid) return;
    setSelectedWalletId(lightningWallets[0]?.id ?? null);
  }, [lightningWallets, selectedWalletId]);

  // Stamps so the auto-dismiss effect only reacts to OUR claim's settle.
  const claimedAtRef = useRef(0);
  const claimedSatsRef = useRef(0);
  const expectedPaymentHashRef = useRef<string | null>(null);

  const minSats = stage.kind === 'ready' ? Math.ceil(stage.params.minWithdrawable / 1000) : 0;
  const maxSats = stage.kind === 'ready' ? Math.floor(stage.params.maxWithdrawable / 1000) : 0;

  const fiatLabel = useMemo(
    () => formatFiatApprox(amountSats, btcPrice, currency, formatLocale),
    [amountSats, btcPrice, currency, formatLocale],
  );

  const handleClaim = useCallback(
    async (params: LnurlWithdrawParams, sats: number, sourceLnurl: string) => {
      if (!selectedWalletId) {
        setStage({
          kind: 'error',
          reason: t('lnurlWithdrawSheet.noLightningWallet'),
        });
        return;
      }
      // Reset the match refs at the START of each claim, BEFORE entering
      // 'claiming': the auto-dismiss effect runs in 'claiming' too, and stale
      // values from a PREVIOUS claim would otherwise leak — a left-over
      // `expectedPaymentHashRef` (or, on the hashless amount-match fallback, a
      // left-over `claimedSatsRef`) could make an unrelated incoming payment
      // dismiss the sheet. `claimedAtRef = now` also fails the `at < claimedAtRef`
      // guard for any pre-existing `lastIncomingPayment` (Copilot).
      claimedAtRef.current = Date.now();
      claimedSatsRef.current = 0;
      expectedPaymentHashRef.current = null;
      setStage({ kind: 'claiming' });
      try {
        const msat = sats * 1000;
        const result = await claimLnurlWithdraw(
          { ...params, minWithdrawable: msat, maxWithdrawable: msat },
          async (s, memo) => makeInvoiceForWallet(selectedWalletId, s, memo),
        );
        if (!mountedRef.current) return;
        await recordClaim({ lnurl: sourceLnurl, sats: result.sats });
        if (!mountedRef.current) return;
        claimedSatsRef.current = result.sats;
        setStage({ kind: 'claimed', sats: result.sats });
        // Register the invoice with the wallet context's ~1s aggressive poll so
        // the incoming-payment celebration fires and the balance + transaction
        // list refresh within ~1s of the issuer paying. Without this the only
        // signal is the baseline 30s balance poll, so the sats don't appear
        // until a manual pull-to-refresh. Mirrors NfcReadSheet (#341 follow-up).
        const paymentHash = paymentHashFromBolt11(result.bolt11);
        if (paymentHash) {
          expectedPaymentHashRef.current = paymentHash;
          expectPayment(selectedWalletId, paymentHash, result.sats);
        }
      } catch (e) {
        if (!mountedRef.current) return;
        const reason =
          e instanceof LnurlWithdrawError ? e.message : ((e as Error).message ?? 'Unknown error');
        // A "you must wait N / cooldown / used-up budget" reply is a benign
        // "come back later" — LNbits reusable links rate-limit between uses.
        // Drive a live countdown from the parsed seconds (null → static copy).
        if (SLEEPING_PATTERN.test(reason)) {
          setStage({ kind: 'sleeping', remaining: parseCooldownSeconds(reason) });
          return;
        }
        // LNURL-issuer errors are meaningful → show as-is. Wallet-side NWC/relay
        // failures surface a cryptic SDK string ("reply timeout: event …") → map
        // to friendly copy (#734).
        const friendly =
          e instanceof LnurlWithdrawError ? null : friendlyClaimError(reason, 'the funds');
        setStage({ kind: 'error', reason: friendly ?? reason });
      }
    },
    [selectedWalletId, makeInvoiceForWallet, expectPayment, t],
  );

  // Open + resolve when a deep-link fires.
  useEffect(() => {
    listener = (url: string, walletId?: string, requireConfirmation = true) => {
      if (!mountedRef.current) return;
      const preferredId = walletId ?? activeWalletId;
      setSelectedWalletId(
        lightningWallets.find((w) => w.id === preferredId)?.id ?? lightningWallets[0]?.id ?? null,
      );
      setLnurl(url);
      // 'confirm' = host consent before any fetch; 'resolving' only when the
      // caller already got consent for this link. The claim tap stays mandatory.
      setStage({ kind: requireConfirmation ? 'confirm' : 'resolving' });
      sheetRef.current?.present();
    };
    return () => {
      listener = null;
    };
  }, [activeWalletId, lightningWallets]);

  // Resolve only after consent. Every amount requires a separate claim tap.
  useEffect(() => {
    if (!lnurl || stage.kind !== 'resolving') return;
    let cancelled = false;
    (async () => {
      try {
        const params = await resolveLnurlWithdraw(lnurl);
        if (cancelled || !mountedRef.current) return;
        if (params.maxWithdrawable <= 0) {
          setStage({ kind: 'sleeping', remaining: null });
          return;
        }
        // Whole-sat bounds. `lo`/`hi` can invert (hi < lo) when the issuer's
        // millisat range brackets no integer sat (e.g. 2500–2999 msat → lo=3,
        // hi=2). Auto-claiming hi there sends an amount below min and the claim
        // always fails — surface it as an error instead.
        const lo = Math.ceil(params.minWithdrawable / 1000);
        const hi = Math.floor(params.maxWithdrawable / 1000);
        if (hi < lo) {
          setStage({
            kind: 'error',
            reason: t('lnurlWithdrawSheet.cantClaimWholeSats'),
          });
          return;
        }
        setAmountSats(hi);
        setStage({ kind: 'ready', params });
      } catch (e) {
        if (cancelled || !mountedRef.current) return;
        // A pay link opened as a claim (bare `lnurl://`, scanned `lnurl1…`):
        // hand it to the Send sheet rather than dead-ending on an error.
        if (e instanceof LnurlWithdrawError && e.code === 'pay-request' && onPayLink) {
          let url: string | null = null;
          try {
            url = decodeLnurlWithdraw(lnurl);
          } catch {
            /* Unreachable — resolve already decoded it; fall through to the error. */
          }
          if (url) {
            sheetRef.current?.dismiss();
            onPayLink(url);
            return;
          }
        }
        // Issuer-sent reasons (`status: ERROR`) are meaningful → show as-is;
        // our own "not a withdrawRequest" protocol message is not (#1714).
        const reason =
          e instanceof LnurlWithdrawError
            ? e.code
              ? t('lnurlWithdrawSheet.notAVoucher')
              : e.message
            : t('lnurlWithdrawSheet.couldNotResolveLnurl', { message: (e as Error).message });
        setStage({ kind: 'error', reason });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [lnurl, stage.kind, t, onPayLink]);

  // Tick the cooldown countdown each second while sleeping. Decrements the
  // `remaining` carried in the sleeping stage; stops at 0 (the user can then
  // re-scan to retry). Mirrors the geo-cache prize sheet (NfcReadSheet).
  // Dep on a BOOLEAN (counting-down or not), not the numeric remaining — else
  // every 1s decrement would tear down + recreate the interval (Stevie review).
  const isCountingDown =
    stage.kind === 'sleeping' && stage.remaining !== null && stage.remaining > 0;
  useEffect(() => {
    if (!isCountingDown) return;
    const t = setInterval(() => {
      setStage((s) =>
        s.kind === 'sleeping' && s.remaining !== null && s.remaining > 0
          ? { ...s, remaining: s.remaining - 1 }
          : s,
      );
    }, 1000);
    return () => clearInterval(t);
  }, [isCountingDown]);

  // Auto-dismiss once OUR claim's payment actually lands. The app-root
  // GlobalIncomingPaymentOverlay shows the celebration; we close the sheet
  // behind it so tapping its OK doesn't reveal a stale "X sats inbound!" sheet.
  // Hash-scoped (when known) + post-claim + same-wallet so unrelated incoming
  // payments can't dismiss it. #341.
  useEffect(() => {
    if (stage.kind !== 'claimed' && stage.kind !== 'claiming') return;
    if (!lastIncomingPayment) return;
    if (lastIncomingPayment.at < claimedAtRef.current) return;
    if (lastIncomingPayment.walletId !== selectedWalletId) return;
    if (expectedPaymentHashRef.current) {
      // Hash known → it must match our invoice.
      if (
        lastIncomingPayment.paymentHash &&
        lastIncomingPayment.paymentHash !== expectedPaymentHashRef.current
      ) {
        return;
      }
    } else if (lastIncomingPayment.amountSats !== claimedSatsRef.current) {
      // No invoice hash to match on (paymentHashFromBolt11 returned null) → fall
      // back to an exact amount match so an unrelated same-wallet zap landing
      // right after the claim can't dismiss the sheet prematurely (Archie review).
      return;
    }
    sheetRef.current?.dismiss();
  }, [lastIncomingPayment, stage.kind, selectedWalletId]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        appearsOnIndex={0}
        disappearsOnIndex={-1}
        pressBehavior="close"
      />
    ),
    [],
  );

  let issuerHost = '';
  try {
    issuerHost = lnurl ? new URL(decodeLnurlWithdraw(lnurl)).host : '';
  } catch {
    /* Resolve reports invalid inputs after consent. */
  }
  // Only `lnurlw://` declares its direction up front; `lnurl://` / `lnurl1…`
  // may turn out to be a pay link, so the pre-fetch consent stays neutral
  // (same wording as the app-wide link prompt in `confirmLinkAction`).
  const isWithdrawForm = !!lnurl && /^(lightning:)?lnurlw:\/\//i.test(lnurl.trim());

  const close = () => sheetRef.current?.dismiss();

  return (
    <>
      <BottomSheetModal
        ref={sheetRef}
        enableDynamicSizing
        // The custom slider + dropdown need the touch; let the sheet be dragged
        // / dismissed via its handle + backdrop only.
        enableContentPanningGesture={false}
        // Lift the sheet above the keyboard so the editable amount stays visible.
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
        backgroundStyle={styles.sheetBackground}
        handleIndicatorStyle={styles.handle}
        backdropComponent={renderBackdrop}
        // Drive the keyboard-listener gate: index ≥ 0 means the sheet is
        // presented, -1 means dismissed. Keeping the listeners inert while
        // the sheet is idle (audit LOW 5).
        onChange={(index) => setSheetOpen(index >= 0)}
        onDismiss={() => {
          setLnurl(null);
          setStage({ kind: 'idle' });
          setAmountSats(0);
          setKeyboardHeight(0);
          setSheetOpen(false);
          // Close the Add-wallet wizard too, so it can't linger orphaned after
          // the claim sheet that launched it is gone (Copilot).
          setWizardOpen(false);
        }}
      >
        <BottomSheetScrollView
          ref={scrollRef}
          contentContainerStyle={[
            styles.content,
            // The scroll viewport extends under the keyboard, so the visible gap
            // below the Redeem button is roughly (paddingBottom − keyboardHeight).
            // +56 lands the keyboard-open gap close to the closed-state spacing
            // (32 content pad + the sheet's bottom safe-area, which the keyboard
            // hides). Tuned on-device.
            { paddingBottom: keyboardHeight > 0 ? keyboardHeight + 56 : 32 },
          ]}
          keyboardShouldPersistTaps="handled"
          testID="lnurl-withdraw-sheet"
        >
          {stage.kind === 'confirm' && (
            <Text style={styles.title}>
              {t(isWithdrawForm ? 'linkAction.withdraw' : 'linkAction.open', {
                target: issuerHost,
              })}
            </Text>
          )}
          {stage.kind === 'ready' && (
            <Text style={styles.title}>{t('linkAction.withdraw', { target: issuerHost })}</Text>
          )}
          {stage.kind === 'confirm' && (
            <TouchableOpacity
              style={styles.primaryButton}
              testID="lnurl-withdraw-resolve-button"
              accessibilityLabel={t('linkAction.continue')}
              onPress={() => setStage({ kind: 'resolving' })}
            >
              <Text style={styles.primaryButtonText}>{t('linkAction.continue')}</Text>
            </TouchableOpacity>
          )}
          {(stage.kind === 'resolving' || stage.kind === 'claiming') && (
            <>
              <View style={styles.iconWrap}>
                <Gift size={56} color={colors.brandPink} strokeWidth={2} />
              </View>
              <Text style={styles.title}>{t('lnurlWithdrawSheet.claimFunds')}</Text>
              <BrandedSpinner size="large" style={{ marginTop: 4 }} />
              <Text style={styles.fineprint}>
                {stage.kind === 'resolving'
                  ? t('lnurlWithdrawSheet.lookingUpVoucher')
                  : t('lnurlWithdrawSheet.claimingSats')}
              </Text>
            </>
          )}

          {stage.kind === 'ready' && (
            <>
              <View style={styles.iconWrap}>
                <Gift size={56} color={colors.brandPink} strokeWidth={2} />
              </View>
              <Text style={styles.title}>{t('lnurlWithdrawSheet.claimFunds')}</Text>
              {stage.params.defaultDescription ? (
                <Text style={styles.memo}>&ldquo;{stage.params.defaultDescription}&rdquo;</Text>
              ) : null}
              {/* Big, editable amount — the headline figure IS the input. */}
              <View style={styles.amountRow}>
                <BottomSheetTextInput
                  style={styles.amountInput}
                  keyboardType="number-pad"
                  value={amountSats > 0 ? String(amountSats) : ''}
                  onChangeText={(t) => {
                    const digits = t.replace(/[^0-9]/g, '');
                    const n = digits === '' ? 0 : parseInt(digits, 10);
                    setAmountSats(Math.min(maxSats, Number.isFinite(n) ? n : 0));
                  }}
                  onBlur={() => {
                    if (amountSats < minSats) setAmountSats(minSats);
                  }}
                  testID="lnurl-withdraw-amount-input"
                  accessibilityLabel={t('lnurlWithdrawSheet.claimAmountInSats')}
                />
                <Text style={styles.amountUnit}>{t('lnurlWithdrawSheet.satsUnit')}</Text>
              </View>
              {fiatLabel ? <Text style={styles.amountFiat}>{fiatLabel}</Text> : null}
              <AmountSlider
                min={minSats}
                max={maxSats}
                value={amountSats}
                onChange={setAmountSats}
                colors={colors}
                testID="lnurl-withdraw-amount-slider"
                accessibilityLabel={t('lnurlWithdrawSheet.claimAmountInSats')}
              />
              <View style={styles.rangeRow}>
                <Text style={styles.rangeText}>{minSats.toLocaleString(formatLocale)}</Text>
                <Text style={styles.rangeText}>
                  {t('lnurlWithdrawSheet.maxLabel', {
                    amount: maxSats.toLocaleString(formatLocale),
                  })}
                </Text>
              </View>
              {/* Destination-wallet chooser (reused from the geo-cache prize flow). */}
              <View style={styles.pickerWrap}>
                <PrizeWalletPicker
                  lightningWallets={lightningWallets}
                  selectedWalletId={selectedWalletId}
                  onSelect={setSelectedWalletId}
                  onAddWallet={() => setWizardOpen(true)}
                  colors={colors}
                />
              </View>
              <TouchableOpacity
                style={[
                  styles.primaryButton,
                  (!selectedWalletId || amountSats < minSats || amountSats > maxSats) &&
                    styles.primaryButtonDisabled,
                ]}
                // Block a sub-min / over-max claim — the typed field allows
                // below-min until blur, and the issuer would reject it (Archie).
                disabled={!selectedWalletId || amountSats < minSats || amountSats > maxSats}
                onPress={() => lnurl && handleClaim(stage.params, amountSats, lnurl)}
                accessibilityLabel={t('lnurlWithdrawSheet.claimSats', { amount: amountSats })}
                testID="lnurl-withdraw-claim-button"
              >
                <Gift size={20} color={colors.white} strokeWidth={2.5} />
                <Text style={styles.primaryButtonText}>
                  {t('linkAction.withdrawSats', {
                    amount: amountSats.toLocaleString(formatLocale),
                  })}
                </Text>
              </TouchableOpacity>
            </>
          )}

          {stage.kind === 'claimed' && (
            <>
              <View style={styles.iconWrapSuccess}>
                <PartyPopper size={56} color={colors.green} strokeWidth={2} />
              </View>
              <Text style={styles.title}>
                {t('lnurlWithdrawSheet.satsInbound', {
                  amount: stage.sats.toLocaleString(formatLocale),
                })}
              </Text>
              <Text style={styles.memo}>{t('lnurlWithdrawSheet.sentToWallet')}</Text>
              <TouchableOpacity
                style={styles.primaryButton}
                onPress={close}
                testID="lnurl-withdraw-done-button"
              >
                <Text style={styles.primaryButtonText}>{t('lnurlWithdrawSheet.done')}</Text>
              </TouchableOpacity>
            </>
          )}

          {stage.kind === 'sleeping' && (
            <>
              <View style={styles.iconWrap}>
                <Gift size={56} color={colors.textSupplementary} strokeWidth={1.5} />
              </View>
              <Text style={styles.title}>{t('lnurlWithdrawSheet.onCooldown')}</Text>
              {stage.remaining !== null && stage.remaining > 0 ? (
                <>
                  <Text style={styles.countdown} testID="lnurl-withdraw-cooldown">
                    {formatCountdown(stage.remaining)}
                  </Text>
                  <Text style={styles.memo}>{t('lnurlWithdrawSheet.voucherClaimedRecently')}</Text>
                </>
              ) : stage.remaining === 0 ? (
                <Text style={styles.memo}>{t('lnurlWithdrawSheet.unlocked')}</Text>
              ) : (
                <Text style={styles.memo}>{t('lnurlWithdrawSheet.cooldownNoHint')}</Text>
              )}
              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={close}
                testID="lnurl-withdraw-close-button"
              >
                <Text style={styles.secondaryButtonText}>{t('lnurlWithdrawSheet.close')}</Text>
              </TouchableOpacity>
            </>
          )}

          {stage.kind === 'error' && (
            <>
              <View style={styles.iconWrap}>
                <Gift size={56} color={colors.textSupplementary} strokeWidth={1.5} />
              </View>
              <Text style={styles.title}>{t('lnurlWithdrawSheet.couldntClaim')}</Text>
              <Text style={styles.memo}>{stage.reason}</Text>
              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={close}
                testID="lnurl-withdraw-close-button"
              >
                <Text style={styles.secondaryButtonText}>{t('lnurlWithdrawSheet.close')}</Text>
              </TouchableOpacity>
            </>
          )}
        </BottomSheetScrollView>
      </BottomSheetModal>
      <AddWalletWizard visible={wizardOpen} onClose={() => setWizardOpen(false)} />
    </>
  );
}
