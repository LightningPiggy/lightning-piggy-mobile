import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { RefreshCw } from 'lucide-react-native';
import BrandedSpinner from './BrandedSpinner';
import { useTranslation } from '../contexts/LocaleContext';
import type { Palette } from '../styles/palettes';
import type { DmProtocolPickerSheetStyles } from '../styles/DmProtocolPickerSheet.styles';
import type { MarmotAvailability } from '../utils/marmotAvailability';

interface Props {
  availability: MarmotAvailability | null;
  name: string;
  onRetry: () => void;
  styles: DmProtocolPickerSheetStyles;
  colors: Palette;
}

/** The Marmot option's availability line in the message-type picker. */
function MarmotAvailabilityNote({ availability, name, onRetry, styles, colors }: Props) {
  const t = useTranslation();
  if (availability === 'checking') {
    return (
      <View style={styles.availability} testID="dm-protocol-marmot-checking">
        <BrandedSpinner size="small" accessibilityLabel={t('dmProtocol.availability.checking')} />
        <Text style={styles.availabilityText}>{t('dmProtocol.availability.checking')}</Text>
      </View>
    );
  }
  if (availability === 'unavailable') {
    return (
      <Text style={styles.availabilityText} testID="dm-protocol-marmot-unavailable">
        {t('dmProtocol.availability.unavailable', { name })}
      </Text>
    );
  }
  if (availability === 'error') {
    return (
      <TouchableOpacity
        style={styles.availability}
        onPress={onRetry}
        hitSlop={8}
        testID="dm-protocol-marmot-retry"
        accessibilityRole="button"
        accessibilityLabel={t('dmProtocol.availability.error')}
      >
        <RefreshCw size={14} color={colors.brandPink} strokeWidth={2.5} />
        <Text style={styles.retryText}>{t('dmProtocol.availability.error')}</Text>
      </TouchableOpacity>
    );
  }
  return null;
}

export default React.memo(MarmotAvailabilityNote);
