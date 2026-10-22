import { checkRemoteUrl } from '../utils/remoteUrlPolicy';
import React, { useMemo } from 'react';
import { Text, TouchableOpacity, View, type StyleProp, type ViewStyle } from 'react-native';
import { FileText, ImageIcon, Link2, Link2Off } from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useLocale } from '../contexts/LocaleContext';
import { createTapToLoadMediaStyles } from '../styles/TapToLoadMedia.styles';

/** Host shown on the placeholder so the reader knows where a tap will connect. */
export function displayHost(url: string): string {
  try {
    return new URL(url).hostname || url;
  } catch {
    return url;
  }
}

interface Props {
  /** `thumb` fills its parent (profile thumbnails / media tiles) and drops
   *  the host line to fit. `pdf` is the image box for a PDF's first page. */
  variant: 'image' | 'pdf' | 'preview' | 'thumb';
  url: string;
  fromMe: boolean;
  testID: string;
  /** Omit when a parent touchable owns the tap (the image bubble does, so a
   *  long-press still reaches the message menu). */
  onPress?: () => void;
  /** Match the image geometry supplied by the containing chat bubble. */
  style?: StyleProp<ViewStyle>;
}

/**
 * Placeholder for chat media that didn't auto-load because the sender isn't
 * someone the reader follows (#1338). Nothing is fetched until it's tapped.
 */
const TapToLoadMedia: React.FC<Props> = ({ variant, url, fromMe, testID, onPress, style }) => {
  const colors = useThemeColors();
  const { t } = useLocale();
  const styles = useMemo(() => createTapToLoadMediaStyles(colors, fromMe), [colors, fromMe]);
  const host = displayHost(url);
  // White only on the preview card, which sits on our pink bubble.
  const iconColor = fromMe ? colors.white : colors.brandPink;
  const onLightBox = variant !== 'preview';

  if (!checkRemoteUrl(url, { kind: variant === 'preview' ? 'preview' : 'media' }).ok) {
    return (
      <View
        style={[
          variant === 'image' || variant === 'pdf'
            ? styles.imageBox
            : variant === 'thumb'
              ? styles.thumbBox
              : styles.textCol,
          style,
          onLightBox && styles.boxTint,
        ]}
        testID={testID}
      >
        {onLightBox ? (
          <Link2Off size={variant === 'thumb' ? 20 : 28} color={colors.brandPink} />
        ) : null}
        <Text style={onLightBox ? styles.boxLabel : styles.label}>
          {t('messageBubble.blockedLink')}
        </Text>
      </View>
    );
  }

  if (variant === 'thumb') {
    return (
      <View style={[styles.thumbBox, styles.boxTint]} testID={testID}>
        <ImageIcon size={20} color={colors.brandPink} />
        <Text style={styles.thumbLabel} numberOfLines={2}>
          {t('messageBubble.tapToLoadImage')}
        </Text>
      </View>
    );
  }

  if (variant === 'image' || variant === 'pdf') {
    const Icon = variant === 'pdf' ? FileText : ImageIcon;
    return (
      <View style={[styles.imageBox, style, styles.boxTint]} testID={testID}>
        <Icon size={28} color={colors.brandPink} />
        <Text style={[styles.boxLabel, styles.labelCentered]}>
          {t(variant === 'pdf' ? 'messageBubble.tapToLoadPdf' : 'messageBubble.tapToLoadImage')}
        </Text>
        <Text style={[styles.boxHost, styles.labelCentered]} numberOfLines={1}>
          {t('messageBubble.loadsFrom', { host })}
        </Text>
      </View>
    );
  }

  return (
    <TouchableOpacity
      activeOpacity={0.85}
      onPress={onPress}
      style={styles.previewCard}
      accessibilityRole="button"
      accessibilityLabel={t('messageBubble.loadPreviewA11y', { host })}
      testID={testID}
    >
      <Link2 size={20} color={iconColor} />
      <View style={styles.textCol}>
        <Text style={styles.label}>{t('messageBubble.tapToLoadPreview')}</Text>
        <Text style={styles.host} numberOfLines={1}>
          {t('messageBubble.loadsFrom', { host })}
        </Text>
      </View>
    </TouchableOpacity>
  );
};

export default React.memo(TapToLoadMedia);
