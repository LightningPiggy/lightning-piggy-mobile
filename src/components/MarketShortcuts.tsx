import { useLikedListings } from '../hooks/useLikedListings';
import React, { useMemo } from 'react';
import { ScrollView, Text, TouchableOpacity } from 'react-native';
import { Heart, Package, Store } from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { useMarketShortcutCounts } from '../contexts/MarketShortcutsContext';
import { createMarketShortcutsStyles } from '../styles/MarketShortcuts.styles';
import MarketShortcutBadge from './MarketShortcutBadge';
import type { ExploreNavigation } from '../navigation/types';

function MarketShortcuts({ navigation }: { navigation: ExploreNavigation }) {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createMarketShortcutsStyles(colors), [colors]);
  const counts = useMarketShortcutCounts();
  const { products } = useLikedListings();
  const shortcuts = [
    {
      id: 'liked',
      label: t('market.shortcuts.liked'),
      icon: Heart,
      count: products.length,
      route: 'MarketLikedItems' as const,
    },
    {
      id: 'orders',
      label: t('market.screen.myOrders'),
      icon: Package,
      count: counts.buyer,
      route: 'MarketMyOrders' as const,
    },
    {
      id: 'shop',
      label: t(counts.hasListings ? 'market.sell.myShop' : 'market.shortcuts.startSelling'),
      icon: Store,
      count: counts.seller,
      route: 'MarketMyShop' as const,
    },
  ];
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={styles.scroll}
      contentContainerStyle={styles.row}
    >
      {shortcuts.map(({ id, label, icon: Icon, count, route }) => (
        <TouchableOpacity
          key={id}
          testID={`market-shortcut-${id}`}
          style={styles.chip}
          accessibilityRole="button"
          accessibilityLabel={count > 0 ? `${label}, ${count}` : label}
          onPress={() => navigation.navigate(route)}
        >
          <Icon size={18} color={colors.brandPink} />
          <Text style={styles.label}>{label}</Text>
          <MarketShortcutBadge count={count} testID={`market-shortcut-${id}-badge`} />
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}
export default React.memo(MarketShortcuts);
