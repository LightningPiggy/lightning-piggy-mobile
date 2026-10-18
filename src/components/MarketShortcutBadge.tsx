import React, { useMemo } from 'react';
import { Text, View } from 'react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { createMarketShortcutsStyles } from '../styles/MarketShortcuts.styles';

export default function MarketShortcutBadge({ count, testID }: { count: number; testID: string }) {
  const colors = useThemeColors();
  const styles = useMemo(() => createMarketShortcutsStyles(colors), [colors]);
  if (count <= 0) return null;
  return (
    <View style={styles.badge} testID={testID}>
      <Text style={styles.badgeText}>{count}</Text>
    </View>
  );
}
