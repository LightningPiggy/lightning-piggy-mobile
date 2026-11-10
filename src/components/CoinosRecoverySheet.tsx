import React, { useState, useCallback, useEffect, useMemo, useRef } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { BottomSheetBackdrop, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { BottomSheetModal } from './AccessibleBottomSheetModal';
import * as Clipboard from 'expo-clipboard';
import { Copy, Eye, EyeOff, ShieldAlert } from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import type { Palette } from '../styles/palettes';
import { createCoinosRecoverySheetStyles } from '../styles/CoinosRecoverySheet.styles';
import { canCopySensitiveText, copySensitiveText } from '../services/sensitiveClipboard';
import { useScreenCaptureBlock } from '../hooks/useScreenCaptureBlock';

export interface CoinosRecoveryDetails {
  baseUrl: string;
  username: string;
  password: string;
  /** Full NIP-47 connection string. Long, but the recovery view is the
   *  one place we surface it so a power user can move the wallet to a
   *  different NWC client without re-provisioning. */
  nwc: string;
}

interface Props {
  visible: boolean;
  details: CoinosRecoveryDetails | null;
  /** Mandatory acknowledgement mode (post-create flow). When true the
   *  user can't dismiss the sheet by swipe / backdrop and the primary
   *  action reads "I've saved this somewhere". When false (re-display
   *  from Wallet Settings) the sheet is freely dismissable and the
   *  primary action reads "Done". */
  requireAcknowledge: boolean;
  onAcknowledge: () => void;
  onClose: () => void;
}

/**
 * Renders the CoinOS managed-wallet recovery info — username, password,
 * NWC connection string + a one-line restore hint.
 *
 * Funds-loss surface area: if a user wipes their device without backing
 * this up, their CoinOS balance is unrecoverable. The post-create flow
 * uses `requireAcknowledge` so the user MUST tap the primary action
 * before we let them onto Home — see `CreateLightningWalletScreen` for
 * the create-flow wiring and `WalletSettingsSheet` for the re-display
 * entry point.
 */
const CoinosRecoverySheet: React.FC<Props> = ({
  visible,
  details,
  requireAcknowledge,
  onAcknowledge,
  onClose,
}) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createCoinosRecoverySheetStyles(colors), [colors]);
  const ref = useRef<BottomSheetModal>(null);
  // Content-height only — matches the rest of the app's sheet pattern.
  const [copyHint, setCopyHint] = useState<string | null>(null);
  // Track the copy-hint timeout so unmounting (or a fast second copy)
  // cancels the previous timer — without this, a setTimeout fires
  // setState after unmount and React warns. Lives in a ref so
  // copyToClipboard can read/write the same handle across calls.
  const copyHintTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The password and NWC string are on this sheet: block screenshots /
  // recording / the recents thumbnail for as long as it's showing (#1784).
  useScreenCaptureBlock('coinos-recovery', visible && !!details);
  const canCopySecret = canCopySensitiveText();

  useEffect(() => {
    if (visible && details) ref.current?.present();
    else ref.current?.dismiss();
  }, [visible, details]);

  // Cleanup outstanding copy-hint timer on unmount.
  useEffect(() => {
    return () => {
      if (copyHintTimerRef.current) clearTimeout(copyHintTimerRef.current);
    };
  }, []);

  const handleSheetChange = useCallback(
    (index: number) => {
      // In acknowledge-mode the sheet is `enablePanDownToClose={false}` so
      // index never reaches -1 from a swipe; this is purely the "X" /
      // backdrop fallback path used by the re-display flow.
      if (index === -1) onClose();
    },
    [onClose],
  );

  const renderBackdrop = useCallback(
    (props: any) => (
      <BottomSheetBackdrop
        {...props}
        // In acknowledge-mode disable backdrop-tap dismissal.
        // pressBehavior="none" matches @gorhom/bottom-sheet's intent.
        pressBehavior={requireAcknowledge ? 'none' : 'close'}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
      />
    ),
    [requireAcknowledge],
  );

  // Secrets (password, NWC string) go through the secret clipboard: marked
  // sensitive, local-only on iOS and cleared after a short window (#1784).
  const copyToClipboard = useCallback(async (label: string, value: string, secret = false) => {
    try {
      if (secret) await copySensitiveText(value);
      else await Clipboard.setStringAsync(value);
    } catch {
      return;
    }
    setCopyHint(label);
    if (copyHintTimerRef.current) clearTimeout(copyHintTimerRef.current);
    copyHintTimerRef.current = setTimeout(() => {
      setCopyHint(null);
      copyHintTimerRef.current = null;
    }, 1500);
  }, []);

  if (!details) return null;

  const host = (() => {
    try {
      return new URL(details.baseUrl).host;
    } catch {
      return details.baseUrl;
    }
  })();

  return (
    <BottomSheetModal
      ref={ref}
      enablePanDownToClose={!requireAcknowledge}
      onChange={handleSheetChange}
      backdropComponent={renderBackdrop}
      backgroundStyle={styles.sheetBackground}
      handleIndicatorStyle={styles.handle}
    >
      <BottomSheetScrollView
        contentContainerStyle={styles.content}
        keyboardShouldPersistTaps="handled"
      >
        <View style={styles.iconBubble}>
          <ShieldAlert size={36} color={colors.white} strokeWidth={2.5} />
        </View>
        <Text style={styles.title} testID="coinos-recovery-title">
          {t('coinosRecoverySheet.title')}
        </Text>
        <Text style={styles.subtitle}>{t('coinosRecoverySheet.subtitle', { host })}</Text>

        <RecoveryRow
          label={t('coinosRecoverySheet.serverLabel')}
          value={details.baseUrl}
          onCopy={() => copyToClipboard(t('coinosRecoverySheet.serverCopyLabel'), details.baseUrl)}
          colors={colors}
          testID="coinos-recovery-server"
        />
        <RecoveryRow
          label={t('coinosRecoverySheet.usernameLabel')}
          value={details.username}
          onCopy={() => copyToClipboard(t('coinosRecoverySheet.usernameLabel'), details.username)}
          colors={colors}
          testID="coinos-recovery-username"
        />
        <RecoveryRow
          label={t('coinosRecoverySheet.passwordLabel')}
          value={details.password}
          onCopy={
            canCopySecret
              ? () =>
                  copyToClipboard(t('coinosRecoverySheet.passwordLabel'), details.password, true)
              : undefined
          }
          colors={colors}
          monospace
          maskable
          testID="coinos-recovery-password"
        />
        <RecoveryRow
          label={t('coinosRecoverySheet.nwcLabel')}
          value={details.nwc}
          onCopy={
            canCopySecret
              ? () => copyToClipboard(t('coinosRecoverySheet.nwcCopyLabel'), details.nwc, true)
              : undefined
          }
          colors={colors}
          monospace
          // The NWC URL is long; the row stretches and wraps but copy
          // is still the primary affordance.
          truncate
          // NWC string contains the wallet secret — masking it by
          // default matches the password row's treatment.
          maskable
          testID="coinos-recovery-nwc"
        />

        {copyHint && (
          <Text style={styles.copyConfirm} testID="coinos-recovery-copy-confirm">
            {t('coinosRecoverySheet.copiedToClipboard', { label: copyHint })}
          </Text>
        )}

        <TouchableOpacity
          style={styles.primaryButton}
          onPress={() => {
            // Belt-and-braces: dismiss the modal locally AND notify the
            // parent. The useEffect-driven dismissal (via visible=false)
            // wasn't firing reliably when this sheet is presented over
            // another BottomSheetModal (settings) — the inner ref.dismiss
            // call gets swallowed by the outer modal's portal context.
            // Calling dismiss() directly here pops just this modal; the
            // onChange handler then propagates to onClose so parent
            // state stays in sync.
            ref.current?.dismiss();
            if (requireAcknowledge) onAcknowledge();
            else onClose();
          }}
          testID="coinos-recovery-acknowledge"
          accessibilityLabel={
            requireAcknowledge
              ? t('coinosRecoverySheet.savedAcknowledge')
              : t('coinosRecoverySheet.closeRecoveryInfo')
          }
        >
          <Text style={styles.primaryButtonText}>
            {requireAcknowledge
              ? t('coinosRecoverySheet.savedAcknowledge')
              : t('coinosRecoverySheet.done')}
          </Text>
        </TouchableOpacity>
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
};

const RecoveryRow: React.FC<{
  label: string;
  value: string;
  /** Omitted for a secret on a build without the secret clipboard. */
  onCopy?: () => void;
  colors: Palette;
  monospace?: boolean;
  truncate?: boolean;
  /** Hide the value behind dots with an eye-toggle. For secrets like
   *  the account password the recipient shouldn't have on-screen by
   *  default in case they're holding the phone in public. */
  maskable?: boolean;
  testID?: string;
}> = ({ label, value, onCopy, colors, monospace, truncate, maskable, testID }) => {
  const t = useTranslation();
  const styles = useMemo(() => createCoinosRecoverySheetStyles(colors), [colors]);
  const [revealed, setRevealed] = useState(false);
  const shown = maskable && !revealed ? '••••••••••••' : value;
  return (
    <View style={styles.row}>
      <Text style={styles.rowLabel}>{label}</Text>
      <View style={styles.rowValueWrap}>
        <Text
          style={[styles.rowValue, monospace ? styles.mono : null]}
          numberOfLines={truncate ? 3 : undefined}
          testID={testID}
        >
          {shown}
        </Text>
        {maskable && (
          <TouchableOpacity
            onPress={() => setRevealed((v) => !v)}
            style={styles.copyButton}
            accessibilityLabel={
              revealed
                ? t('coinosRecoverySheet.hideField', { label })
                : t('coinosRecoverySheet.revealField', { label })
            }
            testID={testID ? `${testID}-reveal` : undefined}
            hitSlop={8}
          >
            {revealed ? (
              <EyeOff size={18} color={colors.textSupplementary} strokeWidth={2} />
            ) : (
              <Eye size={18} color={colors.textSupplementary} strokeWidth={2} />
            )}
          </TouchableOpacity>
        )}
        {onCopy && (
          <TouchableOpacity
            onPress={onCopy}
            style={styles.copyButton}
            accessibilityLabel={t('coinosRecoverySheet.copyField', { label })}
            testID={testID ? `${testID}-copy` : undefined}
            hitSlop={8}
          >
            <Copy size={18} color={colors.brandPink} strokeWidth={2.5} />
          </TouchableOpacity>
        )}
      </View>
    </View>
  );
};

export default CoinosRecoverySheet;
