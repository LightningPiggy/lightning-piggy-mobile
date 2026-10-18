import { enabledAppRelays } from '../services/appRelayPrefs';
import MarketShortcutBadge from './MarketShortcutBadge';
import { useMarketShortcutCounts } from '../contexts/MarketShortcutsContext';
import React, { useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Image } from 'expo-image';
import {
  Package,
  Store,
  User,
  UserRound,
  Wallet,
  Settings,
  MessageCircle,
  Palette as PaletteIcon,
  Bell,
  ShieldCheck,
  Info,
  LogOut,
  QrCode,
  MoreHorizontal,
} from 'lucide-react-native';
import QrSheet from './QrSheet';
import NostrLoginSheet from './NostrLoginSheet';
import AccountSwitcherSheet from './AccountSwitcherSheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import type { DrawerContentComponentProps } from '@react-navigation/drawer';
import { DrawerContentScrollView } from '@react-navigation/drawer';
import { useNostr, OWN_PROFILE_CACHE_KEY_BASE } from '../contexts/NostrContext';
import { perAccountKey } from '../services/perAccountStorage';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import * as nostrService from '../services/nostrService';
import type { NostrProfile } from '../types/nostr';
import type { Palette } from '../styles/palettes';
import { createAccountDrawerContentStyles } from '../styles/AccountDrawerContent.styles';
import { appVersionLabel } from '../utils/appVersion';
import { isSupportedImageUrl } from '../utils/imageUrl';
import { unregisterWatcherBeforeSignOut } from '../services/watcherPush';
import { useSignOutConfirm } from '../hooks/useSignOutConfirm';
import type { AccountDrawerParamList } from '../navigation/types';

interface SectionRow {
  name: keyof AccountDrawerParamList | 'MarketMyOrders' | 'MarketMyShop';
  badge?: 'buyer' | 'seller';
  label: string;
  icon: React.ReactNode;
  testID: string;
  /** Divider above this row: ends the "Your account" group. */
  dividerBefore?: boolean;
}

const buildSectionRows = (colors: Palette, t: ReturnType<typeof useTranslation>): SectionRow[] => [
  {
    name: 'AccountProfile',
    label: t('accountDrawerContent.profile'),
    icon: <User size={22} color={colors.textBody} />,
    testID: 'drawer-row-profile',
  },
  {
    name: 'AccountWallets',
    label: t('accountDrawerContent.wallets'),
    icon: <Wallet size={22} color={colors.textBody} />,
    testID: 'drawer-row-wallets',
  },
  {
    name: 'MarketMyOrders',
    label: t('market.sell.hub.orders'),
    icon: <Package size={22} color={colors.brandPink} />,
    testID: 'account-menu-orders',
    badge: 'buyer',
  },
  {
    name: 'MarketMyShop',
    label: t('market.sell.myShop'),
    icon: <Store size={22} color={colors.brandPink} />,
    testID: 'account-menu-shop',
    badge: 'seller',
  },
  {
    name: 'AccountMessages',
    label: t('messageSettingsScreen.title'),
    icon: <MessageCircle size={22} color={colors.textBody} />,
    testID: 'drawer-row-messages',
  },
  {
    name: 'AccountNotifications',
    label: t('accountDrawerContent.notifications'),
    icon: <Bell size={22} color={colors.textBody} />,
    testID: 'drawer-row-notifications',
  },
  {
    name: 'AccountSecurity',
    label: t('accountDrawerContent.security'),
    icon: <ShieldCheck size={22} color={colors.textBody} />,
    testID: 'drawer-row-security',
  },
  {
    name: 'AccountAdvanced',
    label: t('advancedScreen.title'),
    icon: <Settings size={22} color={colors.textBody} />,
    testID: 'drawer-row-advanced',
  },
  {
    name: 'AccountDisplayLanguage',
    label: t('accountDrawerContent.displayLanguage'),
    dividerBefore: true,
    icon: <PaletteIcon size={22} color={colors.textBody} />,
    testID: 'drawer-row-display-language',
  },
  {
    name: 'AccountAbout',
    label: t('accountDrawerContent.about'),
    icon: <Info size={22} color={colors.textBody} />,
    testID: 'drawer-row-about',
  },
];

/**
 * Custom drawer content: Primal/Damus-style sidebar with an enlarged
 * avatar header, per-section rows, a sign-out row pinned above the
 * version footer. See issue #100 for the UX spec.
 */
const AccountDrawerContent: React.FC<DrawerContentComponentProps> = (props) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createAccountDrawerContentStyles(colors), [colors]);
  const sectionRows = useMemo(() => buildSectionRows(colors, t), [colors, t]);
  const counts = useMarketShortcutCounts();
  const insets = useSafeAreaInsets();
  const { isLoggedIn, profile, logout, identities, pubkey, signerType, switchIdentity, relays } =
    useNostr();
  const confirmSignOut = useSignOutConfirm();
  const [signingOut, setSigningOut] = useState(false);
  const [qrSheetOpen, setQrSheetOpen] = useState(false);
  const [loginSheetOpen, setLoginSheetOpen] = useState(false);
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [profileById, setProfileById] = useState<Record<string, NostrProfile>>({});

  // Up to 3 small avatars to the right of the active one (#288). Sort
  // by most-recently-used so the user's "other" identity sits closest
  // to the active one.
  const otherIdentities = useMemo(() => {
    return identities
      .filter((id) => id.pubkey !== pubkey)
      .sort((a, b) => b.lastUsedAt - a.lastUsedAt)
      .slice(0, 3);
  }, [identities, pubkey]);

  // `nostr:nprofile1…` for the QR / NFC share of MY own profile (#755) —
  // embeds my NIP-65 write (outbox) relays (capped 2) so a cold-contact
  // scanner resolves me on niche relays. Falls back to app defaults when
  // I have no published write relays.
  const ownNprofileRef = useMemo(() => {
    if (!pubkey) return undefined;
    const writeRelays = relays.filter((r) => r.write).map((r) => r.url);
    const hints = nostrService.buildOwnProfileRelayHints(writeRelays, 2);
    return `nostr:${nostrService.nprofileEncode(pubkey, hints)}`;
  }, [pubkey, relays]);

  // Lazy-fetch kind-0 for the small switcher avatars. The active
  // identity already has its profile in `profile`; only the others
  // need fan-out. Two phases mirror AccountSwitcherSheet: (1) seed
  // from each identity's per-account own-profile cache in
  // AsyncStorage so the avatars render instantly, then (2) fan out
  // for any still missing.
  useEffect(() => {
    if (otherIdentities.length === 0) return;
    let cancelled = false;
    (async () => {
      // Phase 1 — synchronous-feel cache seed from AsyncStorage.
      const cacheReads = await Promise.all(
        otherIdentities.map(async (id) => {
          if (profileById[id.pubkey]) return null;
          try {
            const raw = await AsyncStorage.getItem(
              perAccountKey(OWN_PROFILE_CACHE_KEY_BASE, id.pubkey),
            );
            if (!raw) return null;
            const parsed = JSON.parse(raw) as NostrProfile;
            return { pubkey: id.pubkey, profile: parsed };
          } catch {
            return null;
          }
        }),
      );
      if (cancelled) return;
      const seeded: Record<string, NostrProfile> = {};
      for (const r of cacheReads) {
        if (r) seeded[r.pubkey] = r.profile;
      }
      if (Object.keys(seeded).length > 0) {
        setProfileById((prev) => ({ ...seeded, ...prev }));
      }

      // Phase 2 — relay fan-out for identities still missing.
      const targetRelays = relays.filter((r) => r.read).map((r) => r.url);
      const fanOut =
        targetRelays.length > 0
          ? targetRelays
          : enabledAppRelays('default', nostrService.DEFAULT_RELAYS);
      for (const id of otherIdentities) {
        if (cancelled) return;
        if (seeded[id.pubkey] || profileById[id.pubkey]) continue;
        try {
          const fetched = await nostrService.fetchProfile(id.pubkey, fanOut);
          if (cancelled) return;
          if (fetched) setProfileById((prev) => ({ ...prev, [id.pubkey]: fetched }));
        } catch {
          // best-effort: row falls back to the placeholder avatar
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // profileById intentionally omitted — see AccountSwitcherSheet for the same pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [otherIdentities, relays]);

  const displayName = profile?.displayName || profile?.name || '';
  const truncatedNpub = profile?.npub
    ? `${profile.npub.slice(0, 12)}…${profile.npub.slice(-6)}`
    : '';

  const handleSwitchTo = (targetPubkey: string) => {
    if (targetPubkey === pubkey) return;
    switchIdentity(targetPubkey).catch((e) => {
      if (__DEV__) console.warn('[Drawer] switchIdentity failed:', e);
    });
  };

  // Open the Back up your key screen for `targetPubkey` (#1223).
  const openKeyBackup = (targetPubkey: string) => {
    setSwitcherOpen(false);
    props.navigation.closeDrawer();
    props.navigation.navigate('AccountKeyBackup', { pubkey: targetPubkey });
  };

  const handleSignOut = () => {
    if (!isLoggedIn || !pubkey) return;
    void confirmSignOut({
      pubkey,
      signerType,
      displayName: displayName || truncatedNpub || t('accountDrawerContent.accountFallback'),
      otherAccountCount: identities.filter((i) => i.pubkey !== pubkey).length,
      onBackup: () => openKeyBackup(pubkey),
      onConfirm: async () => {
        setSigningOut(true);
        try {
          // While the signer exists: drop this phone from the notification watcher.
          await unregisterWatcherBeforeSignOut(pubkey);
          await logout();
        } finally {
          setSigningOut(false);
        }
      },
    });
  };

  return (
    <View style={[styles.container, { paddingTop: insets.top }]}>
      <DrawerContentScrollView
        {...props}
        contentContainerStyle={styles.scrollContent}
        scrollIndicatorInsets={{ right: 1 }}
      >
        {/* Header — large active avatar on the left, small switcher
            avatars stacked flush-right adjacent to the ⋯ button. Small
            avatars are sized so 4-5 fit comfortably; ⋯ opens
            AccountSwitcherSheet for the full list. (#288) */}
        <View style={styles.header}>
          <View style={styles.headerAvatarRow}>
            <View style={styles.avatarLarge}>
              {profile?.picture && isSupportedImageUrl(profile.picture) ? (
                <Image
                  source={{ uri: profile.picture }}
                  style={styles.avatarImage}
                  cachePolicy="memory-disk"
                  recyclingKey={profile.picture}
                  autoplay={false}
                />
              ) : (
                <View style={[styles.avatarImage, styles.avatarPlaceholder]}>
                  <UserRound size={28} color={colors.textBody} strokeWidth={1.75} />
                </View>
              )}
            </View>
            {isLoggedIn && otherIdentities.length > 0 && (
              <View style={styles.switcherAvatars}>
                {otherIdentities.map((id) => {
                  const prof = profileById[id.pubkey];
                  const idPrefix = id.pubkey.slice(0, 8);
                  return (
                    <TouchableOpacity
                      accessibilityRole="button"
                      key={id.pubkey}
                      style={styles.avatarSmall}
                      onPress={() => handleSwitchTo(id.pubkey)}
                      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                      accessibilityLabel={t('accountDrawerContent.switchToAccount', {
                        name:
                          prof?.displayName ||
                          prof?.name ||
                          t('accountDrawerContent.accountFallback'),
                      })}
                      testID={`drawer-account-switch-${idPrefix}`}
                    >
                      {prof?.picture && isSupportedImageUrl(prof.picture) ? (
                        <Image
                          source={{ uri: prof.picture }}
                          style={styles.avatarSmallImage}
                          cachePolicy="memory-disk"
                          recyclingKey={prof.picture}
                          autoplay={false}
                        />
                      ) : (
                        <View style={[styles.avatarSmallImage, styles.avatarPlaceholder]}>
                          <UserRound size={14} color={colors.textBody} strokeWidth={1.75} />
                        </View>
                      )}
                    </TouchableOpacity>
                  );
                })}
              </View>
            )}
            {isLoggedIn && (
              <TouchableOpacity
                accessibilityRole="button"
                style={styles.moreButton}
                onPress={() => setSwitcherOpen(true)}
                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                accessibilityLabel={t('accountDrawerContent.manageAccounts')}
                testID="account-switcher-button"
              >
                <MoreHorizontal size={22} color={colors.textBody} />
              </TouchableOpacity>
            )}
          </View>
          {isLoggedIn ? (
            <>
              <View style={styles.nameRow}>
                <Text
                  style={[styles.headerName, styles.flex1]}
                  numberOfLines={1}
                  testID="drawer-display-name"
                >
                  {displayName}
                </Text>
                {profile?.npub && (
                  <TouchableOpacity
                    accessibilityRole="button"
                    onPress={() => {
                      props.navigation.closeDrawer();
                      setQrSheetOpen(true);
                    }}
                    hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                    accessibilityLabel={t('accountDrawerContent.showNpubQr')}
                    testID="drawer-npub-qr"
                  >
                    <QrCode size={28} color={colors.textSupplementary} />
                  </TouchableOpacity>
                )}
              </View>
              {truncatedNpub !== '' && (
                <Text style={styles.headerNpub} numberOfLines={1}>
                  {truncatedNpub}
                </Text>
              )}
            </>
          ) : (
            <TouchableOpacity
              accessibilityRole="button"
              style={styles.signInButton}
              onPress={() => {
                props.navigation.closeDrawer();
                setLoginSheetOpen(true);
              }}
              accessibilityLabel={t('accountDrawerContent.signInOrCreate')}
              testID="drawer-sign-in"
            >
              <Text style={styles.signInButtonText}>{t('accountDrawerContent.signInButton')}</Text>
            </TouchableOpacity>
          )}
        </View>

        <View style={styles.divider} />

        {/* Section rows */}
        {sectionRows.map((row) => (
          <React.Fragment key={row.name}>
            {row.dividerBefore && <View style={styles.divider} />}
            <TouchableOpacity
              accessibilityRole="button"
              style={styles.row}
              onPress={() => {
                props.navigation.closeDrawer();
                if (row.name === 'MarketMyOrders' || row.name === 'MarketMyShop') {
                  props.navigation.navigate('MainTabs', {
                    screen: 'Explore',
                    params: { screen: row.name, initial: false },
                  });
                } else props.navigation.navigate(row.name);
              }}
              accessibilityLabel={
                row.badge && counts[row.badge] > 0
                  ? `${row.label}, ${counts[row.badge]}`
                  : row.label
              }
              testID={row.testID}
            >
              <View style={styles.rowIcon}>{row.icon}</View>
              <Text style={styles.rowLabel}>{row.label}</Text>
              {row.badge ? (
                <MarketShortcutBadge count={counts[row.badge]} testID={`${row.testID}-badge`} />
              ) : null}
            </TouchableOpacity>
          </React.Fragment>
        ))}

        <View style={styles.divider} />

        {/* Sign Out — explicit row above the footer */}
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityState={{ disabled: !isLoggedIn || signingOut }}
          style={[styles.row, (!isLoggedIn || signingOut) && styles.rowDisabled]}
          onPress={handleSignOut}
          disabled={!isLoggedIn || signingOut}
          accessibilityLabel={t('accountDrawerContent.signOutOf', {
            name: displayName || t('accountDrawerContent.accountFallback'),
          })}
          testID="drawer-sign-out"
        >
          <View style={styles.rowIcon}>
            <LogOut size={22} color={isLoggedIn ? colors.red : colors.textSupplementary} />
          </View>
          <Text
            style={[styles.rowLabel, { color: isLoggedIn ? colors.red : colors.textSupplementary }]}
          >
            {t('accountDrawerContent.signOutOf', {
              name: displayName || t('accountDrawerContent.accountFallback'),
            })}
          </Text>
        </TouchableOpacity>
      </DrawerContentScrollView>

      {/* Footer — pinned version string */}
      <View style={[styles.footer, { paddingBottom: Math.max(insets.bottom, 16) }]}>
        <Text style={styles.versionText} testID="drawer-version">
          v{appVersionLabel}
        </Text>
      </View>

      {profile?.npub && (
        <QrSheet
          visible={qrSheetOpen}
          onClose={() => setQrSheetOpen(false)}
          npub={profile.npub}
          nostrRef={ownNprofileRef}
          lightningAddress={profile.lud16 ?? null}
          defaultMode="npub"
        />
      )}

      <NostrLoginSheet visible={loginSheetOpen} onClose={() => setLoginSheetOpen(false)} />

      <AccountSwitcherSheet
        visible={switcherOpen}
        onClose={() => setSwitcherOpen(false)}
        onBackupKey={openKeyBackup}
      />
    </View>
  );
};

export default AccountDrawerContent;
