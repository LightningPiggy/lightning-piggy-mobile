import React, { useEffect, useMemo } from 'react';
import { BackHandler, Text, View } from 'react-native';
import { BottomSheetBackdrop, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { BottomSheetModal } from './AccessibleBottomSheetModal';
import BrandedSpinner from './BrandedSpinner';
import { useTranslation } from '../contexts/LocaleContext';
import { useThemeColors } from '../contexts/ThemeContext';
import { createNetworkSectionStyles } from '../styles/NetworkSection.styles';
import type { useRelayPublishSheet } from '../hooks/useRelayPublishSheet';

export default function RelayPublishSheet({
  state,
}: {
  state: ReturnType<typeof useRelayPublishSheet>;
}) {
  const colors = useThemeColors();
  const styles = useMemo(() => createNetworkSectionStyles(colors), [colors]);
  const t = useTranslation();
  useEffect(() => {
    if (!state.open) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!state.title) return false;
      state.sheet.current?.dismiss();
      return true;
    });
    return () => sub.remove();
  }, [state.title, state.sheet, state.open]);
  return (
    <BottomSheetModal
      ref={state.sheet}
      enablePanDownToClose
      onDismiss={state.dismiss}
      backdropComponent={(props) => (
        <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />
      )}
      backgroundStyle={styles.sheetBackground}
    >
      <BottomSheetScrollView contentContainerStyle={styles.sheet} testID="relay-publish-sheet">
        <Text style={styles.sheetTitle}>{state.title}</Text>
        {state.phase === 'waiting' && (
          <Text style={styles.sheetText} testID="relay-publish-waiting">
            {t('relayPublishSheet.waiting')}
          </Text>
        )}
        {state.rows.map((row) => (
          <View key={row.url} style={styles.resultRow} testID={`relay-publish-${row.url}`}>
            {row.status === 'pending' && state.phase !== 'finished' ? (
              <BrandedSpinner />
            ) : (
              <Text style={styles.sheetText}>{row.status === 'accepted' ? '✓' : '✕'}</Text>
            )}
            <View style={styles.resultText}>
              <Text style={styles.sheetText}>{row.url}</Text>
              <Text style={styles.sheetText}>
                {t(
                  `relayPublishSheet.${row.status === 'pending' && state.phase === 'finished' ? 'noResponse' : row.status}`,
                )}
                {row.reason ? ` — ${row.reason}` : ''}
              </Text>
            </View>
          </View>
        ))}
        {!!state.error && (
          <Text style={styles.sheetText} testID="relay-publish-error">
            {state.error}
          </Text>
        )}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}
