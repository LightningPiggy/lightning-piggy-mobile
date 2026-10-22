import React, { useMemo } from 'react';
import { Text, View, type StyleProp, type ViewStyle } from 'react-native';
import { AlertCircle } from 'lucide-react-native';
import BrandedSpinner from './BrandedSpinner';
import { useThemeColors } from '../contexts/ThemeContext';
import { useLocale } from '../contexts/LocaleContext';
import { createTapToLoadMediaStyles } from '../styles/TapToLoadMedia.styles';

interface Props {
  status: 'loading' | 'failed';
  /** What failed, e.g. "Couldn't load image". Only shown when `status` is failed. */
  label?: string;
  /** The caller's media geometry (aspect ratio, margins). */
  style?: StyleProp<ViewStyle>;
  testID?: string;
}

/**
 * The tinted media box from TapToLoadMedia, for media that is loading or
 * failed to load. Not touchable itself: the containing bubble owns the tap
 * (retry) so a long-press still reaches the message menu.
 */
const MediaStatusBox: React.FC<Props> = ({ status, label, style, testID }) => {
  const colors = useThemeColors();
  const { t } = useLocale();
  const styles = useMemo(() => createTapToLoadMediaStyles(colors, false), [colors]);
  return (
    <View style={[styles.imageBox, style, styles.boxTint]} testID={testID}>
      {status === 'loading' ? (
        <BrandedSpinner size="small" />
      ) : (
        <>
          <AlertCircle size={28} color={colors.brandPink} />
          <Text style={[styles.boxLabel, styles.labelCentered]}>{label}</Text>
          <Text style={[styles.boxHost, styles.labelCentered]}>
            {t('messageBubble.tapToRetry')}
          </Text>
        </>
      )}
    </View>
  );
};

export default React.memo(MediaStatusBox);
