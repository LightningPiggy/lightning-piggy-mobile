import React, { useMemo, useState } from 'react';
import { ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';
import { ArrowLeft, UserRound, Users, Copy, ShieldCheck } from 'lucide-react-native';
import * as Clipboard from 'expo-clipboard';
import { nip19 } from 'nostr-tools';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { RootStackParamList } from '../navigation/types';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { useGroups } from '../contexts/GroupsContext';
import { useNostr } from '../contexts/NostrContext';
import { createChatToolsStyles } from '../styles/ChatTools.styles';
import { useChatInfoContact } from '../hooks/useChatInfoContact';
import { useChatInfoMembers } from '../hooks/useChatInfoMembers';
import { canManageGroup } from '../utils/groupAdmins';
import GroupMembersSheet from '../components/GroupMembersSheet';
import DmMembersSheet from '../components/DmMembersSheet';
import RenameGroupSheet from '../components/RenameGroupSheet';
import { Alert } from '../components/BrandedAlert';
import Toast from '../components/BrandedToast';
export default function ChatInfoScreen() {
  const { params } = useRoute<RouteProp<RootStackParamList, 'ChatInfo'>>();
  const contact = useChatInfoContact(params.contact);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const colors = useThemeColors();
  const t = useTranslation();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createChatToolsStyles(colors), [colors]);
  const { getGroup, deleteGroup } = useGroups();
  const { pubkey } = useNostr();
  const group = params.groupId ? getGroup(params.groupId) : undefined;
  const members = useChatInfoMembers(group, params.members);
  const [membersOpen, setMembersOpen] = useState(false);
  const [renameOpen, setRenameOpen] = useState(false);
  const counts = useMemo(() => new Map(params.deviceCounts), [params.deviceCounts]);
  const npub = useMemo(() => {
    try {
      return params.contact?.pubkey ? nip19.npubEncode(params.contact.pubkey) : null;
    } catch {
      return null;
    }
  }, [params.contact?.pubkey]);
  const copy = async () => {
    if (!npub) return;
    try {
      await Clipboard.setStringAsync(npub);
      Toast.show({ type: 'success', text1: t('chatMenu.copied') });
    } catch {
      Toast.show({ type: 'error', text1: t('chatMenu.error') });
    }
  };
  const leave = () => {
    if (!group) return;
    Alert.alert(
      t('groupConversationScreen.leaveGroupTitle'),
      t('groupConversationScreen.leaveGroupMessage', { name: group.name }),
      [
        { text: t('addWalletWizard.cancel'), style: 'cancel' },
        {
          text: t('groupConversationScreen.leave'),
          style: 'destructive',
          onPress: () => {
            void deleteGroup(group.id)
              .then(() => navigation.pop(2))
              .catch(() => Toast.show({ type: 'error', text1: t('chatMenu.error') }));
          },
        },
      ],
    );
  };
  return (
    <View
      style={[styles.screen, { paddingTop: insets.top, paddingBottom: insets.bottom }]}
      testID="chat-info-screen"
    >
      <View style={styles.header}>
        <TouchableOpacity
          style={styles.button}
          onPress={() => navigation.goBack()}
          testID="chat-info-back"
          accessibilityLabel={t('conversationScreen.goBack')}
        >
          <ArrowLeft color={colors.textHeader} size={24} />
        </TouchableOpacity>
        <Text style={styles.title}>
          {t(params.groupId ? 'chatMenu.group' : 'chatMenu.contact')}
        </Text>
      </View>
      <ScrollView>
        <View style={styles.card}>
          {(contact?.picture ?? params.picture) ? (
            <Image
              source={{ uri: contact?.picture ?? params.picture! }}
              style={styles.avatar}
              cachePolicy="memory-disk"
            />
          ) : (
            <View style={styles.avatar}>
              {params.groupId ? (
                <Users size={80} color={colors.brandPink} />
              ) : (
                <UserRound size={80} color={colors.brandPink} />
              )}
            </View>
          )}
          <Text style={styles.name}>{group?.name ?? contact?.name ?? params.name}</Text>
          {contact?.nip05 ? <Text style={styles.text}>{contact!.nip05}</Text> : null}
          {npub ? (
            <TouchableOpacity
              onPress={() => void copy()}
              testID="chat-info-copy-npub"
              accessibilityLabel={t('chatMenu.copyNpub')}
              style={styles.row}
            >
              <Copy size={20} color={colors.brandPink} />
              <Text selectable style={[styles.muted, styles.itemBody]}>
                {npub}
              </Text>
            </TouchableOpacity>
          ) : null}
          {contact ? (
            <TouchableOpacity
              style={styles.button}
              testID="chat-info-profile"
              onPress={() => navigation.navigate('ContactProfile', { contact: contact! })}
            >
              <Text style={styles.action}>{t('chatMenu.profile')}</Text>
            </TouchableOpacity>
          ) : null}
        </View>
        <View style={styles.card}>
          <View style={styles.row}>
            <ShieldCheck size={24} color={colors.brandPink} />
            <Text style={styles.title}>{t('chatMenu.security')}</Text>
          </View>
          <Text style={styles.text}>
            {params.protocol === 'marmot'
              ? 'Marmot MLS'
              : params.protocol === 'nip171'
                ? 'NIP-171'
                : params.protocol === 'nip17'
                  ? 'NIP-17'
                  : 'NIP-04'}
          </Text>
          <Text style={styles.muted}>
            {t(
              params.protocol === 'marmot'
                ? 'chatMenu.mlsSecurity'
                : params.protocol === 'nip171'
                  ? 'chatMenu.nip171Security'
                  : params.protocol === 'nip17'
                    ? 'chatMenu.nip17Security'
                    : 'chatMenu.nip04Security',
            )}
          </Text>
          {params.chatId ? (
            <TouchableOpacity
              style={styles.button}
              onPress={() => setMembersOpen(true)}
              testID="chat-info-devices"
            >
              <Text style={styles.action}>{t('chatMenu.devices')}</Text>
            </TouchableOpacity>
          ) : null}
          {params.protocol === 'marmot' ? (
            <>
              <Text style={styles.action}>{t('chatMenu.relays')}</Text>
              {params.relays.length ? (
                params.relays.map((relay) => (
                  <Text key={relay} selectable style={styles.text}>
                    {relay}
                  </Text>
                ))
              ) : (
                <Text style={styles.muted}>{t('chatMenu.noRelays')}</Text>
              )}
            </>
          ) : null}
        </View>
        {group ? (
          <View style={styles.card}>
            <TouchableOpacity
              style={styles.button}
              onPress={() => setMembersOpen(true)}
              testID="chat-info-members"
            >
              <Text style={styles.action}>{t('groupConversationScreen.manageMembers')}</Text>
            </TouchableOpacity>
            {canManageGroup(group, pubkey) ? (
              <TouchableOpacity
                style={styles.button}
                onPress={() => setRenameOpen(true)}
                testID="chat-info-rename"
              >
                <Text style={styles.action}>{t('chatMenu.rename')}</Text>
              </TouchableOpacity>
            ) : null}
            <TouchableOpacity style={styles.button} onPress={leave} testID="chat-info-leave">
              <Text style={styles.danger}>{t('groupConversationScreen.leaveGroupTitle')}</Text>
            </TouchableOpacity>
          </View>
        ) : null}
      </ScrollView>
      {params.contact?.pubkey ? (
        <DmMembersSheet
          visible={membersOpen}
          onClose={() => setMembersOpen(false)}
          peer={{
            pubkey: params.contact.pubkey,
            name: params.name,
            picture: params.picture ?? null,
          }}
          chatId={params.chatId}
          deviceCounts={counts}
        />
      ) : null}
      {group ? (
        <>
          <GroupMembersSheet
            visible={membersOpen}
            onClose={() => setMembersOpen(false)}
            groupId={group.id}
            members={members}
            chatId={params.chatId}
            deviceCounts={counts}
          />
          <RenameGroupSheet
            visible={renameOpen}
            groupId={group.id}
            onClose={() => setRenameOpen(false)}
          />
        </>
      ) : null}
    </View>
  );
}
