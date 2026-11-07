import React, { useCallback, useMemo, useState } from 'react';
import { useFocusEffect, useNavigation } from '@react-navigation/native';
import { Link2, ShieldCheck, KeyRound } from 'lucide-react-native';
import SettingsRow from '../../components/SettingsRow';
import AccountScreenLayout from './AccountScreenLayout';
import type { AccountDrawerNavigation } from '../../navigation/types';
import { useTranslation } from '../../contexts/LocaleContext';
import { useTrustGraph } from '../../contexts/TrustGraphContext';
import { useNostr } from '../../contexts/NostrContext';
import { useAccountState } from '../../contexts/useAccountState';
import { getLinkPreviewEnabled, setLinkPreviewEnabled } from '../../services/linkPreviewPreference';
import { useSettingsPicker } from '../../hooks/useSettingsPicker';
import { useInvitationDeviceSummary } from '../../hooks/useInvitationDeviceSummary';
import { invitationDeviceSummaryLabel } from '../../utils/invitationDeviceSummary';
import { Text } from 'react-native';
import { useThemeColors } from '../../contexts/ThemeContext';
import { createSharedAccountStyles } from './sharedStyles';
import type { WotTier } from '../../services/wotSettingsService';
import AmberPermissionSection from '../../components/AmberPermissionSection';
import SettingsSection from '../../components/SettingsSection';
import WebOfTrustBottomSheet from '../../components/WebOfTrustBottomSheet';

// Same names as the Web of Trust sheet this row opens (and the filter chip
// on Messages, Map and Events).
const TIER_TITLE = {
  friends: 'webOfTrustBottomSheet.friendsTitle',
  fof: 'webOfTrustBottomSheet.fofTitle',
  all: 'webOfTrustBottomSheet.allTitle',
} as const;

/**
 * Settings → Messages: everything here follows the signed-in account. The
 * trust row is the one shared Web of Trust filter — the same setting as the
 * chip on Messages, Map, Events and Groups — so it's labelled as a "whose
 * content you see" filter, not as a rule about who may message you.
 */
const MessageSettingsScreen: React.FC = () => {
  const t = useTranslation();
  const colors = useThemeColors();
  const shared = useMemo(() => createSharedAccountStyles(colors), [colors]);
  const navigation = useNavigation<AccountDrawerNavigation>();
  const { wotTier, setWotTier } = useTrustGraph();
  const { pubkey } = useNostr();
  // Per account (#1231): reload for the active account, ignore a late answer
  // for one we've switched away from.
  const [linkPreviewOn, setLinkPreviewOn] = useAccountState<boolean>(pubkey, true);
  const deviceSummary = invitationDeviceSummaryLabel(useInvitationDeviceSummary());
  // Friends of friends is built on demand (#565): picking it starts the build
  // and opens the Web of Trust sheet so its progress and Cancel are visible.
  const [wotSheetVisible, setWotSheetVisible] = useState(false);
  const openPicker = useSettingsPicker(pubkey, (value) => {
    if (value !== 'friends' && value !== 'fof' && value !== 'all') return;
    setWotTier(value as WotTier);
    if (value === 'fof' && wotTier !== 'fof') setWotSheetVisible(true);
  });
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void getLinkPreviewEnabled(pubkey).then((enabled) => {
        if (alive) setLinkPreviewOn(enabled);
      });
      return () => {
        alive = false;
      };
    }, [pubkey, setLinkPreviewOn]),
  );
  const handleToggleLinkPreview = async (next: boolean) => {
    setLinkPreviewOn(next);
    await setLinkPreviewEnabled(next, pubkey);
  };
  return (
    <AccountScreenLayout title={t('messageSettingsScreen.title')}>
      <AmberPermissionSection />
      <SettingsSection scope="account" testID="messages-account">
        <SettingsRow
          kind="navigate"
          icon={ShieldCheck}
          title={t('messageSettingsScreen.trustTitle')}
          subtitle={t(TIER_TITLE[wotTier])}
          subtitleTestID="messages-trust-tier-value"
          testID="messages-trust-tier"
          details={[
            t('messageSettingsScreen.trustHint'),
            t('webOfTrustBottomSheet.explainer'),
            t('webOfTrustBottomSheet.gateHint'),
          ].join('\n\n')}
          onPress={() =>
            openPicker({
              title: t('messageSettingsScreen.trustTitle'),
              selectedValue: wotTier,
              testID: 'messages-trust-picker',
              options: (['friends', 'fof', 'all'] as const).map((value) => ({
                value,
                label: t(TIER_TITLE[value]),
                subtitle: t(`webOfTrustBottomSheet.${value}Subtitle`),
                testID: `wot-tier-${value}-chip`,
              })),
            })
          }
          accessibilityLabel={t('messageSettingsScreen.trustRowA11y', {
            tier: t(TIER_TITLE[wotTier]),
          })}
        />
        <SettingsRow
          kind="toggle"
          icon={Link2}
          title={t('securityScreen.showLinkPreviews')}
          value={t(linkPreviewOn ? 'settingsScreens.on' : 'settingsScreens.off')}
          testID="messages-link-previews"
          details={t('securityScreen.linkPreviewsHint')}
          toggle={{
            value: linkPreviewOn,
            onValueChange: handleToggleLinkPreview,
            accessibilityLabel: t('securityScreen.showLinkPreviewsA11y'),
            testID: 'security-link-preview-toggle',
          }}
        />
        <SettingsRow
          kind="navigate"
          icon={KeyRound}
          title={t('invitationKeys.title')}
          value={t(deviceSummary.key, deviceSummary.options)}
          subtitleTestID="nostr-invitation-keys-value"
          details={t('invitationKeys.description')}
          testID="nostr-invitation-keys"
          onPress={() => navigation.navigate('AccountInvitationKeys')}
        />
      </SettingsSection>
      <Text style={shared.fieldHint}>{t('settingsScreens.linkPrivacy')}</Text>
      <WebOfTrustBottomSheet visible={wotSheetVisible} onClose={() => setWotSheetVisible(false)} />
    </AccountScreenLayout>
  );
};
export default MessageSettingsScreen;
