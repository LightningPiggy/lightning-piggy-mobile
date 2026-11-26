import React, { useMemo } from 'react';
import { Text, View } from 'react-native';
import { Satellite } from 'lucide-react-native';
import { useTranslation } from '../contexts/LocaleContext';
import type { Palette } from '../styles/palettes';
import {
  createGpsSignalIndicatorStyles,
  type GpsSignalIndicatorStyles,
} from '../styles/GpsSignalIndicator.styles';
import type { GpsSignalBars } from '../utils/gpsSignal';

// Satellite icon with a bar-count badge. With no usable fix (0 bars) the
// icon is struck through instead of badged — lucide has no SatelliteOff.
export const GpsSignalIndicator: React.FC<{
  bars: GpsSignalBars;
  colors: Palette;
}> = ({ bars, colors }) => {
  const t = useTranslation();
  const styles: GpsSignalIndicatorStyles = useMemo(
    () => createGpsSignalIndicatorStyles(colors),
    [colors],
  );
  const levelKey = (['gpsNoFix', 'gpsWeak', 'gpsGood', 'gpsStrong'] as const)[bars];
  const label = t('mapScreen.gpsSignal', { level: t(`mapScreen.${levelKey}`) });

  return (
    <View style={styles.container} accessible accessibilityLabel={label} testID="map-gps-indicator">
      <Satellite size={22} color={colors.white} strokeWidth={2.5} />
      {bars === 0 ? (
        <View style={styles.strike} pointerEvents="none" />
      ) : (
        <View style={styles.badge} pointerEvents="none">
          <Text style={styles.badgeText}>{bars}</Text>
        </View>
      )}
    </View>
  );
};
