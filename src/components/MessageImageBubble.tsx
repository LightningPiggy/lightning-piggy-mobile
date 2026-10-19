import { chatImageAspectRatio } from '../styles/chatCardWidth';
import { attachmentAspectStyle } from '../styles/attachmentGeometry';
import OutgoingBubbleBackground from './OutgoingBubbleBackground';
import React, { useCallback, useState } from 'react';
import { View, TouchableOpacity } from 'react-native';
import { useLocale } from '../contexts/LocaleContext';
import type { MessageBubbleStyles } from '../styles/MessageBubble.styles';
import type { ParsedImageMessage } from '../utils/messageContent';
import { checkRemoteUrl } from '../utils/remoteUrlPolicy';
import { useActivePubkey } from '../hooks/useActivePubkey';
import { useTapToReveal } from '../hooks/useTapToReveal';
import DecryptedImage from './DecryptedImage';
import TapToLoadMedia, { displayHost } from './TapToLoadMedia';

interface Props {
  styles: MessageBubbleStyles;
  image: ParsedImageMessage;
  /** Message id — keys the tap-to-load state and the placeholder testID. */
  messageId: string;
  testIdPrefix: string;
  fromMe: boolean;
  /** Sender is me or someone I follow (#1338). Otherwise the image waits for a tap. */
  autoLoad: boolean;
  senderLabel: React.ReactNode;
  onOpenImageFullscreen?: (url: string) => void;
  // Long-press → parent's MessageActionsSheet (#205). Kept firing even when
  // there's no fullscreen tap handler, so the pressable is only disabled when
  // BOTH the tap and the long-press are absent.
  onLongPress?: () => void;
  testID: string;
  // Shared time + delivery-tick footer (#856). Passed in so a sent image shows
  // the tick like every other variant.
  footer: React.ReactNode;
}

/**
 * Image bubble (#688). Lives in its own component because the encrypted
 * branch needs render state (the resolved displayable URI for the fullscreen
 * tap) — a hook can't be called from inside MessageBubble's body, which has
 * earlier conditional returns. Renders DecryptedImage, which handles both the
 * plain-URL and fetch-ciphertext→decrypt paths.
 *
 * Trust gating (#1338): the image URL is chosen by the sender, so it only
 * loads automatically when the sender is trusted AND the URL is a public
 * address. Otherwise a tap-to-load placeholder shows the host, and nothing is
 * requested (DecryptedImage isn't even mounted) until the reader taps.
 */
/** Loaded sizes of `dim`-less images, by URL (bounded, oldest dropped first). */
const loadedImageSizes = new Map<string, { width: number; height: number }>();
const MAX_REMEMBERED_SIZES = 300;
function rememberImageSize(url: string, size: { width: number; height: number }) {
  loadedImageSizes.delete(url);
  loadedImageSizes.set(url, size);
  if (loadedImageSizes.size > MAX_REMEMBERED_SIZES) {
    const oldest = loadedImageSizes.keys().next().value;
    if (oldest !== undefined) loadedImageSizes.delete(oldest);
  }
}

const MessageImageBubble: React.FC<Props> = ({
  styles,
  image,
  messageId,
  testIdPrefix,
  fromMe,
  autoLoad,
  senderLabel,
  onOpenImageFullscreen,
  onLongPress,
  testID,
  footer,
}) => {
  // Without a `dim` tag the size is only known once the image loads; reuse it
  // when the row re-mounts (scrolled away and back) so it doesn't open square
  // and then resize, moving the rows around it.
  const [sourceSize, setSourceSize] = useState(
    () => loadedImageSizes.get(image.url) ?? { width: 1, height: 1 },
  );
  const dim = image.dim?.match(/^(\d+)x(\d+)$/);
  const aspect = dim
    ? chatImageAspectRatio(Number(dim[1]), Number(dim[2]))
    : chatImageAspectRatio(sourceSize.width, sourceSize.height);
  const onImageLoad = useCallback(
    (event: { source: { width: number; height: number } }) => {
      const size = { width: event.source.width, height: event.source.height };
      rememberImageSize(image.url, size);
      setSourceSize(size);
    },
    [image.url],
  );
  const { t } = useLocale();
  const owner = useActivePubkey();
  const safe = checkRemoteUrl(image.url, { kind: 'media' }).ok;
  const [loadAllowed, reveal] = useTapToReveal(`image:${messageId}:${image.url}`, autoLoad && safe);
  // DecryptedImage reports the local cache URI it resolved (plain download or
  // decrypted plaintext) so the fullscreen tap shows that, never the remote
  // URL. The URI is a per-account cache file for ONE image, so it is only
  // honoured while the account and the image URL it was resolved for are
  // still current — otherwise a tap during the next image's load would open
  // the previous image (or the previous account's file).
  const mediaKey = `${owner ?? ''}|${image.url}`;
  const [display, setDisplay] = useState<{ key: string; uri: string } | null>(null);
  const displayUri = display?.key === mediaKey ? display.uri : null;
  const onResolved = useCallback((uri: string) => setDisplay({ key: mediaKey, uri }), [mediaKey]);
  // A failed load shows a retry box; the bubble's tap retries it.
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const canOpen = safe && loadAllowed && !!onOpenImageFullscreen && !!displayUri;
  // Until revealed, a tap loads the image; long-press still opens the menu.
  const onPress = !loadAllowed
    ? reveal
    : failed
      ? retry
      : () => displayUri && onOpenImageFullscreen?.(displayUri);
  return (
    <View style={[styles.bubbleRow, fromMe ? styles.bubbleRowRight : styles.bubbleRowLeft]}>
      <TouchableOpacity
        activeOpacity={0.85}
        onPress={safe ? onPress : undefined}
        onLongPress={onLongPress}
        delayLongPress={350}
        style={[styles.imageBubble, fromMe ? styles.imageBubbleMe : styles.imageBubbleThem]}
        accessibilityLabel={
          !loadAllowed
            ? t('messageBubble.loadImageA11y', { host: displayHost(image.url) })
            : failed
              ? `${t('messageBubble.imageLoadFailed')}. ${t('messageBubble.tapToRetry')}`
              : fromMe
                ? t('messageBubble.imageSent')
                : t('messageBubble.imageReceived')
        }
        // Announce as an image-button whenever it's interactive — either it can
        // open fullscreen (tap) OR it can open the actions sheet (long-press).
        // Only a purely-static image announces as a plain 'image'.
        accessibilityRole={
          !loadAllowed || failed ? 'button' : canOpen || onLongPress ? 'imagebutton' : 'image'
        }
        disabled={loadAllowed && !failed && !canOpen && !onLongPress}
        testID={testID}
      >
        <OutgoingBubbleBackground fromMe={fromMe} />
        {senderLabel}
        {loadAllowed ? (
          <DecryptedImage
            url={image.url}
            encrypted={image.encrypted}
            sha256={image.sha256}
            keyHex={image.keyHex}
            nonceHex={image.nonceHex}
            mime={image.mime}
            marmot={image.marmot}
            style={[styles.imageBubbleImage, attachmentAspectStyle(aspect)]}
            onLoad={onImageLoad}
            accessibilityLabel={t('messageBubble.sharedImage')}
            onResolved={onResolved}
            size={image.size}
            attempt={attempt}
            onFailedChange={setFailed}
          />
        ) : (
          <TapToLoadMedia
            style={[styles.imageBubbleImage, attachmentAspectStyle(aspect)]}
            variant="image"
            url={image.url}
            fromMe={fromMe}
            testID={`${testIdPrefix}-image-placeholder-${messageId}`}
          />
        )}
        {footer}
      </TouchableOpacity>
    </View>
  );
};

export default React.memo(MessageImageBubble);
