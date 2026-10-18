import React, { useMemo } from 'react';
import { View } from 'react-native';
import { ChevronLeft } from 'lucide-react-native';
import BrandPatternBackground from './BrandPatternBackground';
import TabHeader from './TabHeader';
import { useThemeColors } from '../contexts/ThemeContext';
import { createMarketHeaderStyles } from '../styles/MarketHeader.styles';

interface Props {
  title: string;
  backLabel: string;
  onBack: () => void;
  testID: string;
  children?: React.ReactNode;
  insetTop?: boolean;
  backDisabled?: boolean;
  showProfile?: boolean;
}

/** Messages' shared header row and brand wash, with Market's goods motif. */
export default function MarketHeader({
  title,
  backLabel,
  onBack,
  testID,
  children,
  insetTop,
  backDisabled,
  showProfile = false,
}: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createMarketHeaderStyles(colors), [colors]);
  return (
    <View style={styles.header}>
      <BrandPatternBackground variant="market-goods" />
      <TabHeader
        title={title}
        icon={<ChevronLeft size={20} color={colors.brandPink} />}
        onIconPress={onBack}
        iconAccessibilityLabel={backLabel}
        iconTestID={testID}
        iconDisabled={backDisabled}
        insetTop={insetTop}
        rightAction={showProfile ? undefined : <View />}
      />
      {children}
    </View>
  );
}
