import React, { useMemo, useRef, useState } from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Search, SlidersHorizontal, X } from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createMessagesScreenStyles } from '../styles/MessagesScreen.styles';
import { createMarketHeaderStyles } from '../styles/MarketHeader.styles';

interface Props {
  query: string;
  onChangeQuery: (query: string) => void;
  filtersActive: boolean;
  activeFilterCount: number;
  onOpenFilters: () => void;
}

export default function MarketHeaderActions({
  query,
  onChangeQuery,
  filtersActive,
  activeFilterCount,
  onOpenFilters,
}: Props) {
  const colors = useThemeColors();
  const t = useTranslation();
  const messages = useMemo(() => createMessagesScreenStyles(colors), [colors]);
  const styles = useMemo(() => createMarketHeaderStyles(colors), [colors]);
  const [searchExpanded, setSearchExpanded] = useState(false);
  const searchInputRef = useRef<TextInput>(null);

  return (
    <View style={styles.actions}>
      <View style={messages.chipRow}>
        {searchExpanded ? (
          <View style={messages.searchRow}>
            <Search size={16} color="rgba(255,255,255,0.7)" strokeWidth={2} />
            <TextInput
              ref={searchInputRef}
              style={messages.searchInput}
              value={query}
              onChangeText={onChangeQuery}
              placeholder={t('market.screen.searchPlaceholder')}
              placeholderTextColor="rgba(255,255,255,0.5)"
              accessibilityLabel={t('market.screen.searchPlaceholder')}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              testID="market-search-input"
            />
            <TouchableOpacity
              onPress={() => {
                onChangeQuery('');
                setSearchExpanded(false);
              }}
              accessibilityLabel={t('messagesScreen.closeSearch')}
              accessibilityRole="button"
              testID="market-search-clear"
              hitSlop={8}
            >
              <X size={16} color="rgba(255,255,255,0.8)" strokeWidth={2.5} />
            </TouchableOpacity>
          </View>
        ) : (
          <>
            <View style={styles.spacer} />
            <TouchableOpacity
              style={messages.searchToggle}
              onPress={() => {
                setSearchExpanded(true);
                setTimeout(() => searchInputRef.current?.focus(), 100);
              }}
              accessibilityLabel={t('market.screen.searchPlaceholder')}
              accessibilityRole="button"
              accessibilityState={{ expanded: false }}
              testID="market-header-search"
            >
              <Search size={18} color="rgba(255,255,255,0.8)" strokeWidth={2} />
            </TouchableOpacity>
          </>
        )}
        <TouchableOpacity
          style={[messages.searchToggle, filtersActive && styles.activeButton]}
          onPress={onOpenFilters}
          accessibilityLabel={
            filtersActive
              ? t('market.screen.filtersApplied', { count: activeFilterCount })
              : t('market.screen.filters')
          }
          accessibilityRole="button"
          accessibilityState={{ selected: filtersActive }}
          testID="market-filter-button"
        >
          <SlidersHorizontal size={18} color={colors.white} strokeWidth={2.25} />
          {filtersActive ? (
            <View style={styles.badge} testID="market-filter-badge">
              <Text style={styles.badgeText} testID="market-filter-active-count">
                {activeFilterCount}
              </Text>
            </View>
          ) : null}
        </TouchableOpacity>
      </View>
    </View>
  );
}
