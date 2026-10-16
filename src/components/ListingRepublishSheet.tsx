import React, { useEffect, useMemo, useRef } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { BottomSheetBackdrop, BottomSheetScrollView } from '@gorhom/bottom-sheet';
import { BottomSheetModal } from './AccessibleBottomSheetModal';
import BrandedSpinner from './BrandedSpinner';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import type { RepublishSummary } from '../hooks/useListingRepublish';
import { relayDisplayName } from '../utils/relayDetails';
import { createListingRepublishStyles } from '../styles/ListingRepublish.styles';

/** Opens as soon as a republish starts; each listing's relays tick in as they answer. */
export default function ListingRepublishSheet({
  progress,
  onClose,
}: {
  progress: { open: boolean; finished: boolean; items: RepublishSummary[] };
  onClose: () => void;
}) {
  const colors = useThemeColors();
  const styles = useMemo(() => createListingRepublishStyles(colors), [colors]);
  const t = useTranslation();
  const sheet = useRef<BottomSheetModal>(null);
  useEffect(() => {
    if (progress.open) sheet.current?.present();
    else sheet.current?.dismiss();
  }, [progress.open]);
  return (
    <BottomSheetModal
      ref={sheet}
      enablePanDownToClose
      onDismiss={onClose}
      backdropComponent={(props) => (
        <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />
      )}
      backgroundStyle={styles.sheetBackground}
    >
      <BottomSheetScrollView
        contentContainerStyle={styles.sheet}
        testID="republish-result-sheet"
        accessibilityLabel={t('market.republish.results')}
      >
        <Text style={styles.title}>
          {t(progress.finished ? 'market.republish.results' : 'market.republish.progress')}
        </Text>
        {progress.items.map((item) => (
          <View key={item.key} style={styles.item} testID={`republish-item-${item.key}`}>
            <Text style={styles.itemTitle}>{item.title}</Text>
            {item.missing ? <Text style={styles.text}>{t('market.republish.missing')}</Text> : null}
            {item.results.map((result) => (
              <View key={result.url} style={styles.resultRow}>
                <Text style={styles.text}>
                  {result.status === 'accepted' || result.status === 'alreadyPresent' ? '✓' : '✕'}
                </Text>
                <View style={styles.resultText}>
                  <Text style={styles.text}>{relayDisplayName(result.url)}</Text>
                  <Text style={styles.muted}>
                    {t(`market.republish.${result.status}`)}
                    {result.reason ? `: ${result.reason}` : ''}
                  </Text>
                </View>
              </View>
            ))}
            {!item.done && !progress.finished ? (
              <View style={styles.resultRow} testID={`republish-pending-${item.key}`}>
                <BrandedSpinner />
                <Text style={styles.muted}>
                  {t(item.results.length ? 'market.republish.waiting' : 'market.republish.queued')}
                </Text>
              </View>
            ) : null}
          </View>
        ))}
        <TouchableOpacity
          onPress={() => sheet.current?.dismiss()}
          accessibilityLabel={t('market.republish.close')}
          testID="republish-results-close"
          style={styles.button}
        >
          <Text style={styles.buttonText}>{t('market.republish.close')}</Text>
        </TouchableOpacity>
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
}
