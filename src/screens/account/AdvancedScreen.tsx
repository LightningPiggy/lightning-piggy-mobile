import React from 'react';
import { View } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import { Bitcoin, FlaskConical, Gauge, MessageCircle, Radio, Ship } from 'lucide-react-native';
import AccountScreenLayout from './AccountScreenLayout';
import { Alert } from '../../components/BrandedAlert';
import SettingsSection from '../../components/SettingsSection';
import SettingsRow from '../../components/SettingsRow';
import NativeCryptoSection from '../../components/NativeCryptoSection';
import DeviceNoticesSection from '../../components/DeviceNoticesSection';
import { useGroups } from '../../contexts/GroupsContext';
import { useTheme } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LocaleContext';
import { isArkEnabled } from '../../services/arkConfig';
import type { AccountDrawerNavigation } from '../../navigation/types';

/** Advanced settings, grouped by where preferences are stored. */
const AdvancedScreen: React.FC = () => {
  const t = useTranslation();
  const navigation = useNavigation<AccountDrawerNavigation>();
  const { outgoingBubbleStyle } = useTheme();
  const { secretMode, setSecretMode } = useGroups();
  const toggleSecretMode = (enabled: boolean) => {
    if (!enabled) {
      setSecretMode(false);
      return;
    }
    Alert.alert(t('advancedScreen.secretConfirmTitle'), t('advancedScreen.secretConfirmBody'), [
      { text: t('linkAction.cancel'), style: 'cancel' },
      { text: t('advancedScreen.enableSecret'), onPress: () => setSecretMode(true) },
    ]);
  };
  return (
    <AccountScreenLayout title={t('advancedScreen.title')}>
      <SettingsSection scope="account" testID="advanced-account">
        <SettingsRow
          kind="navigate"
          icon={Radio}
          title={t('nostrScreen.title')}
          subtitle={t('advancedScreen.nostrNetworkSubtitle')}
          testID="advanced-nostr-network"
          onPress={() => navigation.navigate('AccountNostr')}
        />
        <View testID="advanced-experimental-features">
          <SettingsRow
            kind="toggle"
            icon={FlaskConical}
            title={t('advancedScreen.secretMode')}
            subtitle={t('settingsRows.experimentalSubtitle')}
            testID="advanced-secret-mode"
            details={t('advancedScreen.secretHint')}
            toggle={{
              value: secretMode,
              onValueChange: toggleSecretMode,
              testID: 'advanced-secret-mode-toggle',
            }}
          />
        </View>
      </SettingsSection>
      <SettingsSection scope="phone" testID="advanced-phone">
        <SettingsRow
          kind="navigate"
          icon={Bitcoin}
          title={t('onChainScreen.title')}
          subtitle={t('advancedScreen.bitcoinNetworkSubtitle')}
          testID="advanced-bitcoin-network"
          onPress={() => navigation.navigate('AccountOnChain')}
        />
        {isArkEnabled() && (
          <SettingsRow
            kind="navigate"
            icon={Ship}
            title={t('arkWallet.title')}
            subtitle={t('arkWallet.settingsSubtitle')}
            testID="advanced-ark-wallet"
            onPress={() => navigation.navigate('AccountArk')}
          />
        )}
        <NativeCryptoSection />
        <DeviceNoticesSection />
        {__DEV__ && (
          <SettingsRow
            kind="navigate"
            icon={MessageCircle}
            title={t('advancedScreen.bubbleStyle')}
            subtitle={t(`advancedScreen.bubbleStyle${outgoingBubbleStyle}`)}
            testID="advanced-bubble-style-row"
            onPress={() => navigation.navigate('AccountBubbleStyle')}
          />
        )}
        {(__DEV__ || process.env.EXPO_PUBLIC_KEEP_PERF_LOGS === '1') && (
          <SettingsRow
            kind="navigate"
            icon={Gauge}
            title={t('hermesProfiler.title')}
            subtitle={t('settingsRows.profilerSubtitle')}
            testID="advanced-profiler"
            onPress={() => navigation.navigate('AccountProfiler')}
          />
        )}
      </SettingsSection>
    </AccountScreenLayout>
  );
};
export default AdvancedScreen;
