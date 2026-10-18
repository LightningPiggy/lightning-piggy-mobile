import React, { useCallback, useMemo, useState, useSyncExternalStore } from 'react';
import { FlatList, Text, TouchableOpacity, View } from 'react-native';
import { UsersRound } from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { useNostr } from '../contexts/NostrContext';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import {
  acceptNip171Invitation,
  declineNip171Invitation,
  nip171Invitations,
  subscribeNip171Groups,
  type Nip171Invitation,
} from '../services/nip171Groups';
import { nip171GroupId } from '../utils/nip171';
// Same look as Marmot invitations: one "requests" style above the inbox.
import { createMarmotInvitationsStyles } from '../styles/MarmotInvitations.styles';
import { Toast } from './BrandedToast';

const InvitationRow = React.memo(function InvitationRow({
  invitation,
  onAction,
}: {
  invitation: Nip171Invitation;
  onAction: (groupPubkey: string, accept: boolean) => Promise<void>;
}) {
  const t = useTranslation();
  const colors = useThemeColors();
  const styles = useMemo(() => createMarmotInvitationsStyles(colors), [colors]);
  const [busy, setBusy] = useState(false);
  const id8 = invitation.groupPubkey.slice(0, 8);
  const act = async (accept: boolean) => {
    setBusy(true);
    try {
      await onAction(invitation.groupPubkey, accept);
    } finally {
      setBusy(false);
    }
  };
  return (
    <View style={styles.row} testID={`nip171-invite-row-${id8}`}>
      <View style={styles.identity}>
        <View style={styles.avatar}>
          <UsersRound size={22} color={colors.textSupplementary} />
        </View>
        <View style={styles.details}>
          <Text style={styles.name}>{t('marmotInvitation.pending')}</Text>
          <Text style={styles.subtitle} numberOfLines={1}>
            {t('nip171Invitation.group')} · {id8}
          </Text>
        </View>
      </View>
      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.button}
          disabled={busy}
          onPress={() => void act(true)}
          accessibilityRole="button"
          accessibilityLabel={t('marmotInvitation.accept')}
          testID={`nip171-invite-accept-${id8}`}
        >
          <Text style={styles.buttonText}>{t('marmotInvitation.accept')}</Text>
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.button}
          disabled={busy}
          onPress={() => void act(false)}
          accessibilityRole="button"
          accessibilityLabel={t('marmotInvitation.decline')}
          testID={`nip171-invite-decline-${id8}`}
        >
          <Text style={styles.buttonText}>{t('marmotInvitation.decline')}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
});

/**
 * NIP-171 group invitations: tickets for groups the user hasn't accepted.
 * Nothing about the group is fetched until they do (a lookup would tell
 * relays they were invited).
 */
export function Nip171Invitations() {
  const { pubkey } = useNostr();
  const getSnapshot = useCallback(() => nip171Invitations(pubkey), [pubkey]);
  const invitations = useSyncExternalStore(subscribeNip171Groups, getSnapshot);
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createMarmotInvitationsStyles(colors), [colors]);
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const onAction = useCallback(
    async (groupPubkey: string, accept: boolean) => {
      if (!pubkey) return;
      try {
        if (!accept) {
          await declineNip171Invitation(pubkey, groupPubkey);
          return;
        }
        if (!(await acceptNip171Invitation(pubkey, groupPubkey))) {
          Toast.show({ type: 'info', text1: t('nip171Invitation.full') });
          return;
        }
        navigation.navigate('GroupConversation', { groupId: nip171GroupId(groupPubkey) });
      } catch {
        Toast.show({ type: 'error', text1: t('marmotInvitation.error') });
      }
    },
    [pubkey, navigation, t],
  );
  const renderItem = useCallback(
    ({ item }: { item: Nip171Invitation }) => (
      <InvitationRow invitation={item} onAction={onAction} />
    ),
    [onAction],
  );
  if (!invitations.length) return null;
  return (
    <FlatList
      style={styles.section}
      data={invitations}
      keyExtractor={(item) => item.groupPubkey}
      renderItem={renderItem}
    />
  );
}
