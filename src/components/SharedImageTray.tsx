import React, { useMemo } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';
import { Send, X } from 'lucide-react-native';
import BrandedSpinner from './BrandedSpinner';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createSharedImageTrayStyles } from '../styles/SharedImageTray.styles';
import type { StagedShare } from '../hooks/useStagedShare';

/**
 * Images shared in from another app (#1692), waiting above the composer. They
 * go out only when the user taps Send here; × drops one.
 */
const SharedImageTray: React.FC<StagedShare> = ({ images, sending, onSend, onRemove }) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createSharedImageTrayStyles(colors), [colors]);
  const count = images.length;

  return (
    <View style={styles.tray} testID="shared-image-tray">
      <Text style={styles.title}>{t('shareIntent.trayTitle', { count })}</Text>
      <View style={styles.row}>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={styles.thumbs}
          style={styles.thumbScroll}
        >
          {images.map((image, index) => (
            <View key={image.uri} style={styles.thumb}>
              {/* Plain local copy, private to this account: memory cache
                  only, never a device-wide disk copy. */}
              <Image
                source={{ uri: image.uri }}
                style={styles.thumbImage}
                contentFit="cover"
                cachePolicy="memory"
                accessibilityIgnoresInvertColors
                accessibilityLabel={t('shareIntent.imageLabel', {
                  index: index + 1,
                  total: count,
                })}
                testID={`shared-image-${index}`}
              />
              {sending ? null : (
                <TouchableOpacity
                  style={styles.removeButton}
                  onPress={() => onRemove(image.uri)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityRole="button"
                  accessibilityLabel={t('shareIntent.removeImage', {
                    index: index + 1,
                    total: count,
                  })}
                  testID={`shared-image-remove-${index}`}
                >
                  <X size={14} color={colors.white} />
                </TouchableOpacity>
              )}
            </View>
          ))}
        </ScrollView>
        <TouchableOpacity
          style={[styles.sendButton, sending && styles.sendButtonDisabled]}
          onPress={onSend}
          disabled={sending}
          accessibilityRole="button"
          accessibilityState={{ disabled: sending, busy: sending }}
          accessibilityLabel={t('shareIntent.sendImages', { count })}
          testID="shared-image-send"
        >
          {sending ? <BrandedSpinner onGradient /> : <Send size={16} color={colors.white} />}
          <Text style={styles.sendButtonText}>{t('shareIntent.sendImages', { count })}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

export default React.memo(SharedImageTray);
