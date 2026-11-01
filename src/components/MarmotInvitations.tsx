import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, Text, TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';
import { UserRound } from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { useNostr, useNostrContacts } from '../contexts/NostrContext';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { usePendingMarmotInvitations } from '../hooks/usePendingMarmotInvitations';
import { useNonFollowProfiles } from '../hooks/useNonFollowProfiles';
import type { DmInboxEntry } from '../utils/conversationSummaries';
import type { PendingMarmotInvitation } from '../services/marmotPendingInvitations';
import { acceptMarmotInvitation, declineMarmotInvitation } from '../services/marmotWelcomeRouter';
import { createMarmotInvitationsStyles } from '../styles/MarmotInvitations.styles';
import { isSupportedImageUrl } from '../utils/imageUrl';
import { Toast } from './BrandedToast';

const InvitationRow = React.memo(function InvitationRow({
  invitation,
  name,
  picture,
  onAction,
}: {
  invitation: PendingMarmotInvitation;
  name: string;
  picture?: string | null;
  onAction: (id: string, accept: boolean) => Promise<void>;
}) {
  const t = useTranslation();
  const colors = useThemeColors();
  const styles = useMemo(() => createMarmotInvitationsStyles(colors), [colors]);
  const [busy, setBusy] = useState(false);
  const id8 = invitation.id.slice(0, 8);
  const declineLabel = t(
    invitation.error ? 'addContactCelebration.dismiss' : 'marmotInvitation.decline',
  );
  const act = async (accept: boolean) => {
    setBusy(true);
    try {
      await onAction(invitation.id, accept);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.row} testID={`marmot-invite-row-${id8}`}>
      <View style={styles.identity}>
        {picture && isSupportedImageUrl(picture) ? (
          <Image
            source={{ uri: picture }}
            style={styles.avatar}
            cachePolicy="memory-disk"
            autoplay={false}
          />
        ) : (
          <View style={styles.avatar}>
            <UserRound size={22} color={colors.textSupplementary} />
          </View>
        )}
        <View style={styles.details}>
          <Text style={styles.name}>{t('marmotInvitation.pending')}</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {name}
          </Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {invitation.direct
              ? t('marmotInvitation.direct')
              : invitation.groupName || t('marmotInvitation.group')}
          </Text>
        </View>
      </View>
      {invitation.error && <Text style={styles.subtitle}>{t('marmotInvitation.unavailable')}</Text>}
      <View style={styles.actions}>
        {!invitation.error && (
          <TouchableOpacity
            style={styles.button}
            disabled={busy}
            onPress={() => void act(true)}
            accessibilityRole="button"
            accessibilityLabel={t('marmotInvitation.accept')}
            testID={`marmot-invite-accept-${id8}`}
          >
            <Text style={styles.buttonText}>{t('marmotInvitation.accept')}</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity
          style={styles.button}
          disabled={busy}
          onPress={() => void act(false)}
          accessibilityRole="button"
          accessibilityLabel={declineLabel}
          testID={`marmot-invite-decline-${id8}`}
        >
          <Text style={styles.buttonText}>{declineLabel}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
});

/** Compact virtualised requests section, separate from trusted conversations. */
export function MarmotInvitations() {
  const { pubkey, fetchProfilesForPubkeys } = useNostr();
  const { contacts } = useNostrContacts();
  const invitations = usePendingMarmotInvitations(pubkey);
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createMarmotInvitationsStyles(colors), [colors]);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  // Reuse the existing public profile cache; no Welcome content enters it.
  const peers = useMemo<DmInboxEntry[]>(
    () =>
      invitations.map(({ id, rumor }) => ({
        id,
        partnerPubkey: rumor.pubkey,
        fromMe: false,
        createdAt: rumor.created_at,
        text: '',
        wireKind: 444,
      })),
    [invitations],
  );
  const { contactInfoMap } = useNonFollowProfiles({
    pubkey,
    dmInbox: peers,
    contacts,
    fetchProfilesForPubkeys,
  });
  const onAction = useCallback(
    async (id: string, accept: boolean) => {
      if (!pubkey) return;
      try {
        if (!accept) {
          await declineMarmotInvitation(pubkey, id);
          return;
        }
        const group = await acceptMarmotInvitation(pubkey, id);
        if (group?.isDm && group.memberPubkeys[0]) {
          const peer = group.memberPubkeys[0];
          const info = contactInfoMap.get(peer);
          navigation.navigate('Conversation', {
            protocol: 'marmot',
            pubkey: peer,
            name: info?.name || peer.slice(0, 8),
            picture: info?.picture,
          });
        } else if (group) navigation.navigate('GroupConversation', { groupId: group.id });
        else Toast.show({ type: 'info', text1: t('marmotInvitation.retry') });
      } catch {
        Toast.show({ type: 'error', text1: t('marmotInvitation.error') });
      }
    },
    [pubkey, navigation, t, contactInfoMap],
  );
  const renderItem = useCallback(
    ({ item }: { item: PendingMarmotInvitation }) => {
      const info = contactInfoMap.get(item.rumor.pubkey.toLowerCase());
      return (
        <InvitationRow
          invitation={item}
          name={info?.name || item.rumor.pubkey.slice(0, 8)}
          picture={info?.picture}
          onAction={onAction}
        />
      );
    },
    [contactInfoMap, onAction],
  );
  if (!invitations.length) return null;
  return (
    <FlatList
      style={styles.section}
      data={invitations}
      keyExtractor={(item) => item.id}
      renderItem={renderItem}
    />
  );
}
