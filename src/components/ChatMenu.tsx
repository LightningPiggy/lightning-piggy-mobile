import React, { useMemo, useState } from 'react';
import { Modal, Pressable, Text, TouchableOpacity, View } from 'react-native';
import {
  MoreVertical,
  UserRound,
  Users,
  Search,
  Images,
  BellOff,
  Bell,
  ChevronRight,
  Trash2,
  X,
} from 'lucide-react-native';
import { useTranslation } from '../contexts/LocaleContext';
import { useThemeColors } from '../contexts/ThemeContext';
import { useMutedSenders } from '../hooks/useMutedSenders';
import { useMuteNotificationAction } from '../hooks/useMuteNotificationAction';
import { chatMenuItems, type ChatMenuItem } from '../utils/chatMenu';
import { createChatToolsStyles } from '../styles/ChatTools.styles';
import { Alert } from './BrandedAlert';
import Toast from './BrandedToast';
const icons = {
  contact: UserRound,
  group: Users,
  search: Search,
  attachments: Images,
  mute: BellOff,
  unmute: Bell,
  more: ChevronRight,
  clear: Trash2,
};
export interface ChatMenuProps {
  sender: string;
  group?: boolean;
  onInfo: () => void;
  onSearch: () => void;
  onAttachments: () => void;
  onClear: () => Promise<void>;
}
export default function ChatMenu({
  sender,
  group = false,
  onInfo,
  onSearch,
  onAttachments,
  onClear,
}: ChatMenuProps) {
  const t = useTranslation();
  const colors = useThemeColors();
  const styles = useMemo(() => createChatToolsStyles(colors), [colors]);
  const { mutedSenders, ready } = useMutedSenders();
  const mute = useMuteNotificationAction();
  const [visible, setVisible] = useState(false);
  const [more, setMore] = useState(false);
  const close = () => setVisible(false);
  const select = (item: ChatMenuItem) => {
    if (item === 'more') {
      setMore(true);
      return;
    }
    close();
    if (item === 'contact' || item === 'group') onInfo();
    if (item === 'search') onSearch();
    if (item === 'attachments') onAttachments();
    if (item === 'mute' || item === 'unmute') mute(sender, 'conversation-mute-notifications');
    if (item === 'clear')
      Alert.alert(t('chatMenu.clear'), t('chatMenu.clearConfirm'), [
        { text: t('addWalletWizard.cancel'), style: 'cancel' },
        {
          text: t('chatMenu.clear'),
          style: 'destructive',
          testID: 'chat-clear-confirm',
          onPress: () => {
            void onClear().catch(() => Toast.show({ type: 'error', text1: t('chatMenu.error') }));
          },
        },
      ]);
  };
  return (
    <>
      <TouchableOpacity
        testID="conversation-notification-menu"
        accessibilityLabel={t('chatMenu.menu')}
        style={styles.button}
        onPress={() => {
          setMore(false);
          setVisible(true);
        }}
      >
        <MoreVertical size={22} color={colors.textHeader} />
      </TouchableOpacity>
      <Modal visible={visible} transparent animationType="fade" onRequestClose={close}>
        <Pressable
          style={styles.backdrop}
          accessible={false}
          onPress={close}
          testID="chat-menu-dismiss"
          accessibilityLabel={t('chatMenu.close')}
        >
          <Pressable
            style={styles.sheet}
            onPress={(event) => event.stopPropagation()}
            accessible={false}
          >
            <View style={styles.header}>
              <Text style={styles.title}>{t(more ? 'chatMenu.more' : 'chatMenu.menu')}</Text>
              <TouchableOpacity
                style={styles.button}
                onPress={close}
                testID="chat-menu-close"
                accessibilityLabel={t('chatMenu.close')}
              >
                <X color={colors.textBody} size={22} />
              </TouchableOpacity>
            </View>
            {chatMenuItems(group, mutedSenders.has(sender.toLowerCase()), more).map((item) => {
              const Icon = icons[item];
              return (
                <TouchableOpacity
                  key={item}
                  style={styles.row}
                  testID={`chat-menu-${item}`}
                  disabled={(item === 'mute' || item === 'unmute') && !ready}
                  onPress={() => select(item)}
                  accessibilityRole="button"
                >
                  <Icon size={22} color={item === 'clear' ? colors.red : colors.brandPink} />
                  <Text style={item === 'clear' ? styles.danger : styles.text}>
                    {t(`chatMenu.${item}`)}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </Pressable>
        </Pressable>
      </Modal>
    </>
  );
}
