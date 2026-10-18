import React, { useMemo } from 'react';
import { ScrollView, Text, TouchableOpacity } from 'react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createMarketFilterBarStyles } from '../styles/MarketFilterBar.styles';
import { orderStatusFilterStyles } from '../styles/OrderStatusFilter.styles';
import type { OrderChipStatus } from './OrderStatusChip';
import type { OrderStatusFilter as Filter } from '../utils/orderStatusFilter';

interface Props {
  counts: readonly { status: OrderChipStatus; count: number }[];
  selected: Filter;
  onSelect: (status: Filter) => void;
}

function OrderStatusFilter({ counts, selected, onSelect }: Props) {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createMarketFilterBarStyles(colors), [colors]);
  if (counts.length < 2) return null;
  const chips = [
    { status: 'all' as const, count: counts.reduce((sum, item) => sum + item.count, 0) },
    ...counts,
  ];
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={orderStatusFilterStyles.row}
    >
      {chips.map(({ status, count }) => (
        <TouchableOpacity
          key={status}
          testID={`order-filter-${status}`}
          accessibilityRole="button"
          accessibilityState={{ selected: selected === status }}
          style={[styles.chip, selected === status && styles.chipSelected]}
          onPress={() => onSelect(status)}
        >
          <Text style={[styles.chipText, selected === status && styles.chipTextSelected]}>
            {t(`orderStatus.${status}`)} {count}
          </Text>
        </TouchableOpacity>
      ))}
    </ScrollView>
  );
}

export default React.memo(OrderStatusFilter);
