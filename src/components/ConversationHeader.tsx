import React, { useMemo, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { Image as ExpoImage } from 'expo-image';
import { useTranslation } from '../contexts/LocaleContext';
import { useThemeColors } from '../contexts/ThemeContext';
import ChatHeaderBar from './ChatHeaderBar';
import ChatMenu, { type ChatMenuProps } from './ChatMenu';
import ConversationProtocolControl from './ConversationProtocolControl';
import { createChatHeaderStyles } from '../styles/ChatHeader.styles';
import type { DmProtocol } from '../utils/dmProtocol';
import { isSupportedImageUrl } from '../utils/imageUrl';

interface Props {
  menu: ChatMenuProps;
  name: string;
  picture?: string | null;
  protocol: DmProtocol;
  onBack: () => void;
  onOpenProfile: () => void;
  /** Marmot 1:1: "Secure chat · 2 devices" under the name (#1267). */
  byline?: string | null;
  onBylinePress?: () => void;
}

/**
 * The 1:1 thread header: back, the peer (avatar + name → profile sheet), and
 * the protocol tag. A Marmot 1:1 adds a quiet by-line under the name that
 * opens who's in the chat on which devices — the chat stays a 1:1, never a
 * group with "2 members".
 */
const ConversationHeader: React.FC<Props> = ({
  menu,
  name,
  picture,
  protocol,
  onBack,
  onOpenProfile,
  byline,
  onBylinePress,
}) => {
  const t = useTranslation();
  const colors = useThemeColors();
  const styles = useMemo(() => createChatHeaderStyles(colors), [colors]);
  const [avatarError, setAvatarError] = useState(false);
  const avatar =
    picture && !avatarError && isSupportedImageUrl(picture) ? (
      <ExpoImage
        source={{ uri: picture }}
        style={styles.headerAvatar}
        cachePolicy="memory-disk"
        recyclingKey={picture}
        autoplay={false}
        onError={() => setAvatarError(true)}
      />
    ) : (
      <View style={[styles.headerAvatar, styles.headerAvatarFallback]}>
        <Svg width={20} height={20} viewBox="0 0 24 24" fill="none">
          <Circle cx="12" cy="8" r="4" fill={colors.textSupplementary} />
          <Path
            d="M4 20c0-3.314 3.582-6 8-6s8 2.686 8 6"
            stroke={colors.textSupplementary}
            strokeWidth={2}
            strokeLinecap="round"
          />
        </Svg>
      </View>
    );

  return (
    <ChatHeaderBar
      onBack={onBack}
      backLabel={t('conversationScreen.goBack')}
      backTestID="conversation-back"
      avatar={
        <TouchableOpacity
          onPress={onOpenProfile}
          accessibilityLabel={t('conversationScreen.openProfile', { name })}
          testID="chat-header-open-profile"
        >
          {avatar}
        </TouchableOpacity>
      }
      title={
        <TouchableOpacity
          onPress={onOpenProfile}
          accessibilityLabel={t('conversationScreen.openProfile', { name })}
          testID="chat-header-open-profile-name"
        >
          <Text style={styles.headerName} numberOfLines={1}>
            {name}
          </Text>
        </TouchableOpacity>
      }
      subtitle={
        byline ? (
          <TouchableOpacity
            onPress={onBylinePress}
            accessibilityRole="button"
            accessibilityLabel={`${byline}. ${t('chatDevices.bylineA11y')}`}
            testID="chat-header-devices"
            hitSlop={{ top: 4, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.headerByline} numberOfLines={1}>
              {byline}
            </Text>
          </TouchableOpacity>
        ) : null
      }
      trailing={
        <>
          <ConversationProtocolControl protocol={protocol} name={name} />
          <ChatMenu {...menu} />
        </>
      }
    />
  );
};

export default React.memo(ConversationHeader);
