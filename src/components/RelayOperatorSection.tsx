import React, { useMemo, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Image } from 'expo-image';
import { UserRound } from 'lucide-react-native';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import { useNostrContacts } from '../contexts/NostrContext';
import { getActivePubkey } from '../services/walletStorageService';
import { openDirectChat } from '../utils/openDirectChat';
import { useTranslation, useLocale } from '../contexts/LocaleContext';
import { useThemeColors } from '../contexts/ThemeContext';
import { createRelayDetailsScreenStyles } from '../styles/RelayDetailsScreen.styles';
import type { RelayInformation } from '../services/relayInformation';
import { useRelayOperator } from '../hooks/useRelayOperator';
import { useSafeExternalLink } from '../hooks/useSafeExternalLink';
import { relayExternalLink } from '../utils/relayExternalLink';
import { shortNpub } from '../utils/shortNpub';
import ContactProfileSheet from './ContactProfileSheet';
import RelayOperatorTip from './RelayOperatorTip';

export default function RelayOperatorSection({ info }: { info: RelayInformation }) {
  const t = useTranslation();
  const { formatLocale } = useLocale();
  const colors = useThemeColors();
  const styles = useMemo(() => createRelayDetailsScreenStyles(colors), [colors]);
  const { profile, verifiedNip05 } = useRelayOperator(info.pubkey);
  const { contacts, followContact, unfollowContact } = useNostrContacts();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const openLink = useSafeExternalLink();
  const [open, setOpen] = useState(false);
  const [avatarFailed, setAvatarFailed] = useState(false);
  const [followingBusy, setFollowingBusy] = useState(false);
  const following = contacts.some((c) => c.pubkey === info.pubkey);
  const contact = info.pubkey
    ? {
        pubkey: info.pubkey,
        name: profile?.displayName || profile?.name || shortNpub(info.pubkey),
        picture: profile?.picture ?? null,
        banner: profile?.banner ?? null,
        about: profile?.about ?? null,
        nip05: verifiedNip05,
        lightningAddress: null,
        source: 'nostr' as const,
      }
    : null;
  const links = [
    'contact',
    'terms_of_service',
    'privacy_policy',
    'posting_policy',
    'payments_url',
  ] as const;
  const countries = info.relay_countries
    ?.map((code) => {
      const flag = [...code].map((c) => String.fromCodePoint(127397 + c.charCodeAt(0))).join('');
      let name = code;
      try {
        name = new Intl.DisplayNames([formatLocale], { type: 'region' }).of(code) ?? code;
      } catch {
        /* flags still identify countries on older engines */
      }
      return `${flag} ${name}`;
    })
    .join(', ');
  if (
    !contact &&
    !links.some((key) => info[key]) &&
    !countries &&
    !info.language_tags?.length &&
    !Object.values(info.fees ?? {}).some((fees) => fees?.length)
  )
    return null;
  return (
    <View style={styles.card} testID="relay-details-operator">
      <Text style={styles.heading}>{t('relayDetails.operator')}</Text>
      {contact && (
        <>
          <Text style={styles.label}>{t('relayDetails.runBy')}</Text>
          <TouchableOpacity
            style={styles.about}
            testID="relay-operator-profile"
            accessibilityRole="button"
            accessibilityLabel={contact.name}
            onPress={() => setOpen(true)}
          >
            {contact.picture && !avatarFailed ? (
              <Image
                source={{ uri: contact.picture }}
                style={styles.avatar}
                cachePolicy="memory-disk"
                onError={() => setAvatarFailed(true)}
              />
            ) : (
              <UserRound size={40} color={colors.white} />
            )}
            <View style={styles.aboutText}>
              <Text
                style={styles.value}
                testID={
                  profile?.name || profile?.displayName
                    ? 'relay-operator-resolved'
                    : 'relay-operator-fallback'
                }
              >
                {contact.name}
              </Text>
              {verifiedNip05 && <Text style={styles.value}>{verifiedNip05} ✓</Text>}
            </View>
          </TouchableOpacity>
          {/* Hidden only once a fresh profile shows no Lightning address. */}
          {profile?.hasLud16 !== false && (
            <RelayOperatorTip
              pubkey={contact.pubkey}
              name={contact.name}
              picture={contact.picture}
            />
          )}
        </>
      )}
      {links.map((key) => {
        const raw = info[key];
        if (!raw) return null;
        const link = relayExternalLink(raw);
        return (
          <View key={key}>
            <Text style={styles.label}>{t(`relayDetails.${key}`)}</Text>
            {link ? (
              <TouchableOpacity
                testID={`relay-link-${key}`}
                accessibilityRole="link"
                accessibilityLabel={raw}
                onPress={() => openLink(raw)}
              >
                <Text style={styles.link}>{raw}</Text>
              </TouchableOpacity>
            ) : (
              <Text selectable style={styles.value}>
                {raw}
              </Text>
            )}
          </View>
        );
      })}
      {info.fees &&
        Object.entries(info.fees).map(([type, fees]) =>
          fees?.length ? (
            <View key={type}>
              <Text style={styles.label}>{t(`relayDetails.${type}Fee`)}</Text>
              {fees.map((fee, i) => (
                <Text key={i} style={styles.value}>
                  {fee.amount} {fee.unit}
                  {fee.period ? ` · ${t('relayDetails.feePeriod', { seconds: fee.period })}` : ''}
                  {fee.kinds?.length
                    ? ` · ${t('relayDetails.feeKinds', { kinds: fee.kinds.join(', ') })}`
                    : ''}
                </Text>
              ))}
            </View>
          ) : null,
        )}
      {countries && (
        <View>
          <Text style={styles.label}>{t('relayDetails.countries')}</Text>
          <Text style={styles.value}>{countries}</Text>
        </View>
      )}
      {!!info.language_tags?.length && (
        <View>
          <Text style={styles.label}>{t('relayDetails.languages')}</Text>
          <Text style={styles.value}>{info.language_tags.join(', ')}</Text>
        </View>
      )}
      <ContactProfileSheet
        visible={open}
        onClose={() => setOpen(false)}
        contact={contact}
        onFollow={async () => {
          if (!info.pubkey || followingBusy) return;
          setFollowingBusy(true);
          try {
            await (following ? unfollowContact(info.pubkey) : followContact(info.pubkey));
          } finally {
            setFollowingBusy(false);
          }
        }}
        following={following}
        followingBusy={followingBusy}
        onMessage={
          contact
            ? () => {
                setOpen(false);
                void openDirectChat(navigation, getActivePubkey(), {
                  pubkey: contact.pubkey,
                  name: contact.name,
                  picture: contact.picture,
                });
              }
            : undefined
        }
        onViewFullProfile={
          contact
            ? () => {
                setOpen(false);
                navigation.navigate('ContactProfile', { contact });
              }
            : undefined
        }
      />
    </View>
  );
}
