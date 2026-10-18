import { enabledAppRelays } from '../services/appRelayPrefs';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import {
  BottomSheetBackdrop,
  type BottomSheetBackdropProps,
  BottomSheetScrollView,
} from '@gorhom/bottom-sheet';
import { BottomSheetModal } from './AccessibleBottomSheetModal';
import { Image } from 'expo-image';
import { Plus, UserPlus, UserRound, X, Check } from 'lucide-react-native';
import * as nip19 from 'nostr-tools/nip19';
import AsyncStorage from '@react-native-async-storage/async-storage';
import NostrLoginSheet from './NostrLoginSheet';
import { useNostr, OWN_PROFILE_CACHE_KEY_BASE } from '../contexts/NostrContext';
import { perAccountKey } from '../services/perAccountStorage';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import * as nostrService from '../services/nostrService';
import { isSupportedImageUrl } from '../utils/imageUrl';
import { unregisterWatcherBeforeSignOut } from '../services/watcherPush';
import { createAccountSwitcherSheetStyles } from '../styles/AccountSwitcherSheet.styles';
import { useSignOutConfirm } from '../hooks/useSignOutConfirm';
import type { NostrProfile } from '../types/nostr';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Open the Back up your key screen for an account (#1223). */
  onBackupKey: (pubkey: string) => void;
}

// Bottom sheet listing every signed-in identity. Triggered by the
// three-dot button in the drawer header (#288).
//
// Behaviour:
//  - Tap a row -> switch active identity (closes sheet).
//  - Tap "Add existing account" / "Create new account" -> opens
//    NostrLoginSheet; the new identity is appended to the registry
//    and made active by `loginWithNsec` / `loginWithAmber`.
//  - Tap the trailing X on a row -> confirm + sign out that identity
//    (other identities remain).
//
// Per-identity profile metadata is fetched lazily here so the cold
// sheet open doesn't wait for the relay round-trip — rows render
// immediately with the npub-prefix as a fallback.
const AccountSwitcherSheet: React.FC<Props> = ({ visible, onClose, onBackupKey }) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createAccountSwitcherSheetStyles(colors), [colors]);
  const sheetRef = useRef<BottomSheetModal>(null);
  const { identities, pubkey, signerType, switchIdentity, signOutIdentity, relays } = useNostr();
  const confirmSignOut = useSignOutConfirm();
  const [loginSheetOpen, setLoginSheetOpen] = useState(false);
  const [profileById, setProfileById] = useState<Record<string, NostrProfile>>({});

  useEffect(() => {
    if (visible) sheetRef.current?.present();
    else sheetRef.current?.dismiss();
  }, [visible]);

  // Lazy-load profile metadata for every signed-in identity. Two
  // phases: (1) seed from each identity's per-account own-profile
  // cache in AsyncStorage so names + avatars render INSTANTLY for
  // any identity that's been active before, then (2) fan out to
  // relays only for identities still missing. Without phase (1),
  // every sheet open paid a per-identity relay round-trip even
  // though the kind-0 was already on disk.
  useEffect(() => {
    if (!visible || identities.length === 0) return;
    let cancelled = false;
    (async () => {
      // Phase 1 — synchronous-feel cache seed from AsyncStorage.
      const cacheReads = await Promise.all(
        identities.map(async (id) => {
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

      // Phase 2 — relay fan-out for identities NOT in cache.
      const targetRelays = relays.filter((r) => r.read).map((r) => r.url);
      const fanOut =
        targetRelays.length > 0
          ? targetRelays
          : enabledAppRelays('default', nostrService.DEFAULT_RELAYS);
      for (const id of identities) {
        if (cancelled) return;
        if (seeded[id.pubkey] || profileById[id.pubkey]) continue;
        try {
          const fetched = await nostrService.fetchProfile(id.pubkey, fanOut);
          if (cancelled) return;
          if (fetched) {
            setProfileById((prev) => ({ ...prev, [id.pubkey]: fetched }));
          }
        } catch {
          // Best-effort — row falls back to npub-prefix display.
        }
      }
    })();
    return () => {
      cancelled = true;
    };
    // `profileById` is intentionally omitted from deps — including it
    // would re-fire the loop on every per-row resolve.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visible, identities, relays]);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />
    ),
    [],
  );

  const handleSwitch = useCallback(
    async (targetPubkey: string) => {
      if (targetPubkey === pubkey) {
        onClose();
        return;
      }
      onClose();
      await switchIdentity(targetPubkey);
    },
    [onClose, pubkey, switchIdentity],
  );

  const handleSignOut = useCallback(
    (targetPubkey: string, displayName: string) => {
      // The registry only knows nsec / amber; the active account's live
      // signer type also covers NIP-46.
      const targetSignerType =
        targetPubkey === pubkey
          ? signerType
          : identities.find((i) => i.pubkey === targetPubkey)?.signerType;
      void confirmSignOut({
        pubkey: targetPubkey,
        signerType: targetSignerType,
        displayName,
        otherAccountCount: identities.filter((i) => i.pubkey !== targetPubkey).length,
        onBackup: () => onBackupKey(targetPubkey),
        onConfirm: () => {
          // The active account can still sign: drop it from the
          // notification watcher first (no-op for another account).
          unregisterWatcherBeforeSignOut(targetPubkey)
            .then(() => signOutIdentity(targetPubkey))
            .catch((e) => {
              if (__DEV__) console.warn('[Account] signOutIdentity failed:', e);
            });
        },
      });
    },
    [confirmSignOut, identities, onBackupKey, pubkey, signerType, signOutIdentity],
  );

  const handleAddAccount = useCallback(() => {
    setLoginSheetOpen(true);
  }, []);

  // Sort: active first, then most-recently-used. Stable across
  // renders so rows don't shuffle while the sheet is open.
  const orderedIdentities = useMemo(() => {
    return [...identities].sort((a, b) => {
      if (a.pubkey === pubkey) return -1;
      if (b.pubkey === pubkey) return 1;
      return b.lastUsedAt - a.lastUsedAt;
    });
  }, [identities, pubkey]);

  return (
    <>
      <BottomSheetModal
        ref={sheetRef}
        onDismiss={onClose}
        backdropComponent={renderBackdrop}
        backgroundStyle={styles.sheetBackground}
        handleIndicatorStyle={styles.handleIndicator}
        enableDynamicSizing
      >
        <BottomSheetScrollView contentContainerStyle={styles.content}>
          <Text style={styles.title}>{t('accountSwitcherSheet.accounts')}</Text>
          <Text style={styles.subtitle}>{t('accountSwitcherSheet.subtitle')}</Text>

          {orderedIdentities.map((id) => {
            const prof = profileById[id.pubkey];
            const npub = (() => {
              try {
                return nip19.npubEncode(id.pubkey);
              } catch {
                return id.pubkey;
              }
            })();
            const display =
              prof?.displayName || prof?.name || `${npub.slice(0, 12)}…${npub.slice(-6)}`;
            const isActive = id.pubkey === pubkey;
            const idPrefix = id.pubkey.slice(0, 8);
            return (
              <View key={id.pubkey} style={styles.row}>
                <TouchableOpacity
                  style={styles.rowMain}
                  onPress={() => handleSwitch(id.pubkey)}
                  accessibilityLabel={t('accountSwitcherSheet.switchTo', { display })}
                  testID={`account-switcher-row-${idPrefix}`}
                >
                  <View style={styles.avatar}>
                    {prof?.picture && isSupportedImageUrl(prof.picture) ? (
                      <Image
                        source={{ uri: prof.picture }}
                        style={styles.avatarImage}
                        cachePolicy="memory-disk"
                        recyclingKey={prof.picture}
                        autoplay={false}
                      />
                    ) : (
                      <View style={[styles.avatarImage, styles.avatarPlaceholder]}>
                        <UserRound size={22} color={colors.textBody} strokeWidth={1.75} />
                      </View>
                    )}
                  </View>
                  <View style={styles.rowText}>
                    <View style={styles.nameRow}>
                      <Text style={styles.rowName} numberOfLines={1}>
                        {display}
                      </Text>
                      {isActive && (
                        <View style={styles.activeBadge}>
                          <Check size={12} color={colors.white} strokeWidth={3} />
                        </View>
                      )}
                    </View>
                    <Text style={styles.rowNpub} numberOfLines={1}>
                      {`${npub.slice(0, 14)}…${npub.slice(-6)}`}
                    </Text>
                  </View>
                </TouchableOpacity>
                <TouchableOpacity
                  style={styles.signOutButton}
                  onPress={() => handleSignOut(id.pubkey, display)}
                  hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                  accessibilityLabel={t('accountSwitcherSheet.signOutOf', { display })}
                  testID={`account-switcher-signout-${idPrefix}`}
                >
                  <X size={18} color={colors.textSupplementary} />
                </TouchableOpacity>
              </View>
            );
          })}

          <View style={styles.divider} />

          <TouchableOpacity
            style={styles.actionRow}
            onPress={handleAddAccount}
            accessibilityLabel={t('accountSwitcherSheet.addExistingAccount')}
            testID="account-switcher-add-existing"
          >
            <View style={styles.actionIcon}>
              <UserPlus size={22} color={colors.brandPink} />
            </View>
            <Text style={styles.actionLabel}>{t('accountSwitcherSheet.addExistingAccount')}</Text>
          </TouchableOpacity>

          <TouchableOpacity
            style={styles.actionRow}
            onPress={handleAddAccount}
            accessibilityLabel={t('accountSwitcherSheet.createNewAccount')}
            testID="account-switcher-create-new"
          >
            <View style={styles.actionIcon}>
              <Plus size={22} color={colors.brandPink} />
            </View>
            <Text style={styles.actionLabel}>{t('accountSwitcherSheet.createNewAccount')}</Text>
          </TouchableOpacity>
        </BottomSheetScrollView>
      </BottomSheetModal>

      {/* NostrLoginSheet handles BOTH "add existing" and "create new" flows — the user picks the path inside the sheet. The sheet's existing post-success handler calls loginWithNsec / loginWithAmber, which now appends to the identities registry instead of replacing the single active slot, so no NostrLoginSheet changes are needed. */}
      <NostrLoginSheet visible={loginSheetOpen} onClose={() => setLoginSheetOpen(false)} />
    </>
  );
};

export default AccountSwitcherSheet;
