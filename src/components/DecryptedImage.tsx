import BrandedSpinner from './BrandedSpinner';
import { Image } from 'expo-image';
import React, { useMemo } from 'react';
import { View, Text } from 'react-native';
import { AlertCircle } from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { createDecryptedImageStyles } from '../styles/DecryptedImage.styles';
import { useLocale } from '../contexts/LocaleContext';
import { checkRemoteUrl } from '../utils/remoteUrlPolicy';
import { useImageMediaUri } from '../hooks/useImageMediaUri';
import type { MarmotImageParams } from '../utils/messageContent';

/**
 * Renders an inline chat image that may be either plain or encrypted (#688):
 *
 *  - **Plain** (`encrypted=false`): legacy / unencrypted images (or images
 *    from other clients) — download with a hard byte cap and display a local cache URI.
 *  - **Encrypted** (`encrypted=true`, NIP-17 kind 15): fetch the
 *    AES-256-GCM ciphertext from Blossom, decrypt with the key/nonce carried
 *    inside the E2E DM, write the plaintext to a cache file, and display that
 *    `file://` URI. The Blossom server only ever holds ciphertext.
 *
 * Mirrors VoiceNotePlayer's fetch→`decryptFile`→cache-file flow. We use a
 * cache file (not a base64 `data:` URI) so the decrypted bytes don't live as a
 * multi-MB JS string — base64 adds ~33% and would double again when handed to
 * the fullscreen viewer (Copilot review on #729). **Decrypt-once:** the
 * shared `decryptedMediaCache` keeps the resolved URI in memory and on disk,
 * keyed by URL + key material and scoped to the active account (wiped on
 * sign-out, #1241), so re-renders, scrolls, remounts and the fullscreen viewer
 * reuse it without re-fetching/re-decrypting (Ben's review note on #729).
 */
interface Props {
  url: string;
  encrypted: boolean;
  sha256?: string;
  keyHex?: string;
  nonceHex?: string;
  mime?: string;
  size?: number;
  /** A Marmot (MIP-04) photo: decrypted with these instead of `keyHex`. */
  marmot?: MarmotImageParams;
  /** Style applied to the rendered <Image>. */
  style?: React.ComponentProps<typeof Image>['style'];
  accessibilityLabel?: string;
  /** Reports the displayable URI once resolved (the cache `file://` URI for
   *  encrypted images), so a parent can wire a fullscreen tap to the decrypted
   *  image rather than the ciphertext blob URL. */
  onResolved?: (uri: string) => void;
  onLoad?: React.ComponentProps<typeof Image>['onLoad'];
}

const DecryptedImage: React.FC<Props> = ({
  url,
  encrypted,
  sha256,
  keyHex,
  nonceHex,
  mime,
  size,
  marmot,
  style,
  accessibilityLabel,
  onResolved,
  onLoad,
}) => {
  const colors = useThemeColors();
  const { t } = useLocale();
  const blocked = !checkRemoteUrl(url, { kind: 'media' }).ok;
  const styles = useMemo(() => createDecryptedImageStyles(colors), [colors]);

  const { uri: localUri, failed } = useImageMediaUri(
    { url, kind: 'image', mime, size, sha256, keyHex, nonceHex, marmot },
    encrypted,
    !blocked,
    onResolved,
  );

  if (blocked)
    return (
      <View style={[style, styles.center]}>
        <Text style={styles.blocked}>{t('messageBubble.blockedLink')}</Text>
      </View>
    );

  if (failed) {
    return (
      <View style={[style, styles.center]}>
        <AlertCircle size={28} color={colors.textSupplementary} />
      </View>
    );
  }

  // Encrypted + still decrypting → spinner placeholder at the image footprint.
  if (!localUri) {
    return (
      <View style={[style, styles.center]}>
        <BrandedSpinner size="small" />
      </View>
    );
  }

  return (
    <Image
      source={{ uri: localUri as string }}
      style={style}
      onLoad={onLoad}
      contentFit="contain"
      cachePolicy="memory"
      accessibilityLabel={accessibilityLabel}
    />
  );
};

export default DecryptedImage;
