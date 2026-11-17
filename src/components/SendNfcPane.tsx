import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, AppState } from 'react-native';
import NfcScanIndicator from './NfcScanIndicator';
import {
  isNfcSupported,
  scanNfcTag,
  cancelNfcOperation,
  type NfcTagContent,
} from '../services/nfcService';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createSendNfcPaneStyles } from '../styles/SendNfcPane.styles';

interface Props {
  // Arm the reader while true; flipping false cancels the session.
  active: boolean;
  onContent: (content: NfcTagContent) => void;
}

type PaneStatus = 'checking' | 'armed' | 'unsupported' | 'error';

// NFC mode of the Send sheet: arms Android reader-mode and hands whatever
// the tag holds (bolt11 / lightning address / LNURL / npub) back to the
// sheet's processInput pipeline. Mirrors NfcReadSheet's lessons: re-arm
// after returning from background (the OS tears the reader down on
// onPause), and never leave a dangling session on unmount.
const SendNfcPane: React.FC<Props> = ({ active, onContent }) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createSendNfcPaneStyles(colors), [colors]);
  const [status, setStatus] = useState<PaneStatus>('checking');
  const [errorMessage, setErrorMessage] = useState('');

  // Refs so the arm loop never goes stale against parent re-renders and
  // the AppState effect can re-subscribe on `active` alone. `activeRef`
  // is owned by the arm/cleanup effect below (NOT synced from the prop
  // here) so unmount cleanup can force it false — otherwise the delayed
  // re-arm timer could re-enable reader-mode after the pane is gone.
  const activeRef = useRef(false);
  const rearmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onContentRef = useRef(onContent);
  useEffect(() => {
    onContentRef.current = onContent;
  }, [onContent]);

  const arm = useCallback(async () => {
    setErrorMessage('');
    if (!(await isNfcSupported())) {
      setStatus('unsupported');
      return;
    }
    if (!activeRef.current) return;
    setStatus('armed');
    try {
      const content = await scanNfcTag();
      if (!activeRef.current) return;
      onContentRef.current(content);
      // If the parent didn't advance (e.g. the tag was a claim code and
      // only raised an alert), quietly re-arm for another tap.
      rearmTimerRef.current = setTimeout(() => {
        if (activeRef.current) void arm();
      }, 600);
    } catch (err) {
      if (!activeRef.current) return;
      const raw = err instanceof Error ? err.message : t('sendNfcPane.failedToRead');
      // Session cancelled (mode switch / sheet close) — not an error.
      if (/cancell?ed/i.test(raw)) return;
      setStatus('error');
      setErrorMessage(
        /NFC unavailable on this device/i.test(raw) ? t('sendNfcPane.nfcTurnedOff') : raw,
      );
    }
  }, [t]);

  useEffect(() => {
    if (!active) return;
    activeRef.current = true;
    void arm();
    return () => {
      // Force the gate false BEFORE cancelling so the pending re-arm
      // timer and any in-flight scan promise no-op after close,
      // mode-switch, or unmount (Copilot #838 r1).
      activeRef.current = false;
      if (rearmTimerRef.current) {
        clearTimeout(rearmTimerRef.current);
        rearmTimerRef.current = null;
      }
      cancelNfcOperation();
    };
  }, [active, arm]);

  // Android pauses reader-mode when the app backgrounds and doesn't
  // resume it — re-arm on return (same fix as NfcReadSheet, #580).
  useEffect(() => {
    if (!active) return;
    let lastState = AppState.currentState;
    const sub = AppState.addEventListener('change', (next) => {
      const wasBackground = lastState === 'background' || lastState === 'inactive';
      lastState = next;
      if (next === 'active' && wasBackground && activeRef.current) {
        void arm();
      }
    });
    return () => sub.remove();
  }, [active, arm]);

  return (
    <View style={styles.container} testID="send-nfc-pane">
      {/* Spin from first paint (checking) through armed; stop only in the
          dead states (unsupported / error) where no scan can happen. */}
      <NfcScanIndicator
        spinning={status !== 'unsupported' && status !== 'error'}
        testID="send-nfc-indicator"
      />
      {status === 'unsupported' ? (
        <Text style={styles.description}>{t('sendNfcPane.nfcUnavailable')}</Text>
      ) : status === 'error' ? (
        <>
          <Text style={styles.description}>{errorMessage}</Text>
          <TouchableOpacity
            accessibilityRole="button"
            style={styles.retryButton}
            onPress={() => void arm()}
            accessibilityLabel={t('sendNfcPane.tryNfcAgain')}
            testID="send-nfc-retry"
          >
            <Text style={styles.retryButtonText}>{t('sendNfcPane.tryAgain')}</Text>
          </TouchableOpacity>
        </>
      ) : (
        <>
          <Text style={styles.instruction}>{t('sendNfcPane.holdTag')}</Text>
          <Text style={styles.description}>{t('sendNfcPane.readInstructions')}</Text>
        </>
      )}
    </View>
  );
};

export default SendNfcPane;
