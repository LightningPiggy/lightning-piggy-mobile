import React, { useMemo } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createGeocacheRailEmptyStateStyles } from '../styles/GeocacheRailEmptyState.styles';
import type { GeocacheRailState } from '../utils/geocacheRailState';

export function GeocacheRailEmptyState({
  state,
  hiddenCount,
  onHide,
  onRetry,
}: {
  state: GeocacheRailState;
  hiddenCount: number;
  onHide: () => void;
  onRetry: () => void;
}) {
  const colors = useThemeColors();
  const styles = useMemo(() => createGeocacheRailEmptyStateStyles(colors), [colors]);
  const t = useTranslation();
  const failed = state === 'error';
  return (
    <View style={styles.container} testID={failed ? 'geocache-rail-error' : 'geocache-rail-empty'}>
      <Text style={styles.message}>{t(failed ? 'geocacheRail.error' : 'geocacheRail.empty')}</Text>
      {!failed && hiddenCount > 0 ? (
        <Text style={styles.message}>{t('geocacheRail.hidden')}</Text>
      ) : null}
      <TouchableOpacity
        style={styles.button}
        onPress={failed ? onRetry : onHide}
        accessibilityRole="button"
        accessibilityLabel={t(failed ? 'geocacheRail.retry' : 'geocacheRail.hide')}
        testID={failed ? 'geocache-rail-retry' : 'geocache-rail-hide'}
      >
        <Text style={styles.buttonText}>
          {t(failed ? 'geocacheRail.retry' : 'geocacheRail.hide')}
        </Text>
      </TouchableOpacity>
    </View>
  );
}
