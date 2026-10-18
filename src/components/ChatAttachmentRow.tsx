import React, { useMemo } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';
import { FileText, Link, Mic, ImageIcon } from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createChatToolsStyles } from '../styles/ChatTools.styles';
import type { ChatAttachment } from '../utils/chatAttachments';
import type { EncryptedMediaRef } from '../services/decryptedMediaCache';
import { useTapToReveal } from '../hooks/useTapToReveal';
import { checkRemoteUrl } from '../utils/remoteUrlPolicy';
import { useImageMediaUri } from '../hooks/useImageMediaUri';
/** Encrypted thumbnails use the same account-scoped cache as chat bubbles. */
function ChatAttachmentRow({
  item,
  autoLoad,
  onOpen,
  onJump,
}: {
  item: ChatAttachment;
  autoLoad: boolean;
  onOpen: (uri: string) => void;
  onJump: (id: string) => void;
}) {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createChatToolsStyles(colors), [colors]);
  const ref = useMemo<EncryptedMediaRef>(
    () => ({ ...item.image, url: item.url, kind: 'image' }),
    [item.image, item.url],
  );
  const [allowed, reveal] = useTapToReveal(
    `chat-media:${item.id}:${item.url}`,
    autoLoad && checkRemoteUrl(item.url, { kind: 'media' }).ok,
  );
  const { uri } = useImageMediaUri(ref, !!item.image?.encrypted, allowed && !!item.image);
  const Icon =
    item.kind === 'voice'
      ? Mic
      : item.kind === 'file'
        ? FileText
        : item.kind === 'link'
          ? Link
          : ImageIcon;
  const press = () => {
    if (!checkRemoteUrl(item.url, { kind: 'media' }).ok) return;
    if (item.image && !allowed) {
      reveal();
      return;
    }
    if (item.image && uri) onOpen(uri);
    else onJump(item.messageId);
  };
  return (
    <TouchableOpacity
      style={styles.row}
      testID={`chat-attachment-${item.id}`}
      onPress={press}
      accessibilityRole="button"
      accessibilityLabel={item.kind === 'image' ? t('chatMenu.openMedia') : item.label}
    >
      {allowed && uri ? (
        <Image
          source={{ uri }}
          style={styles.thumbnail}
          cachePolicy="memory"
          recyclingKey={item.id}
          contentFit="cover"
          autoplay={false}
        />
      ) : (
        <Icon size={36} color={colors.brandPink} />
      )}
      <View style={styles.itemBody}>
        <Text style={styles.text} numberOfLines={2}>
          {item.kind === 'voice' ? t('chatMenu.voice') : item.label}
        </Text>
        <Text style={styles.muted} numberOfLines={1}>
          {!checkRemoteUrl(item.url, { kind: 'media' }).ok
            ? t('messageBubble.blockedLink')
            : item.kind === 'image' && !allowed
              ? t('chatMenu.loadMedia')
              : item.url}
        </Text>
      </View>
    </TouchableOpacity>
  );
}
export default React.memo(ChatAttachmentRow);
