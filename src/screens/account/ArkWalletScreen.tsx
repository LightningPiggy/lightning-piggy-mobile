import React, { useMemo, useState } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import AccountScreenLayout from './AccountScreenLayout';
import BrandedSpinner from '../../components/BrandedSpinner';
import ArkButton from '../../components/ark/ArkButton';
import ArkOnboarding from '../../components/ark/ArkOnboarding';
import ArkBalanceCard from '../../components/ark/ArkBalanceCard';
import ArkReceivePanel from '../../components/ark/ArkReceivePanel';
import ArkSendPanel from '../../components/ark/ArkSendPanel';
import ArkCoinsPanel from '../../components/ark/ArkCoinsPanel';
import ArkBackupPanel from '../../components/ark/ArkBackupPanel';
import ArkHistoryList from '../../components/ark/ArkHistoryList';
import { useThemeColors } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LocaleContext';
import { useArkWallet } from '../../hooks/useArkWallet';
import { createArkWalletStyles } from '../../styles/ArkWallet.styles';

const PANELS = ['receive', 'send', 'coins', 'backup'] as const;
type Panel = (typeof PANELS)[number];

/**
 * Settings → Advanced → Ark wallet (signet, experimental). Only reachable
 * in builds made with EXPO_PUBLIC_ENABLE_ARK=1. See BARK_PLAN.md.
 */
const ArkWalletScreen: React.FC = () => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createArkWalletStyles(colors), [colors]);
  const ark = useArkWallet();
  const [panel, setPanel] = useState<Panel>('receive');
  const { overview, reload } = ark;

  let content: React.ReactNode;
  if (ark.status === 'unavailable') {
    content = <Text style={styles.errorText}>{t('arkWallet.unavailable')}</Text>;
  } else if (ark.status === 'loading') {
    content = (
      <View style={styles.centered}>
        <BrandedSpinner size="large" />
      </View>
    );
  } else if (ark.status === 'none') {
    content = (
      <ArkOnboarding
        styles={styles}
        busy={ark.busy}
        onCreate={ark.create}
        onRestore={ark.restore}
      />
    );
  } else if (ark.status === 'error' || !overview) {
    content = (
      <View style={styles.centered}>
        <Text style={styles.errorText} testID="ark-load-error">
          {t('arkWallet.loadFailed', { error: ark.error ?? '' })}
        </Text>
        <ArkButton
          styles={styles}
          label={t('arkWallet.retry')}
          onPress={() => void reload()}
          testID="ark-retry"
        />
      </View>
    );
  } else {
    const onChanged = () => void reload();
    content = (
      <>
        <ArkBalanceCard styles={styles} overview={overview} />
        <View style={styles.tabs} accessibilityRole="tablist">
          {PANELS.map((p) => (
            <TouchableOpacity
              key={p}
              onPress={() => setPanel(p)}
              style={[styles.tab, panel === p && styles.tabActive]}
              accessibilityRole="tab"
              accessibilityState={{ selected: panel === p }}
              accessibilityLabel={t(`arkWallet.tabs.${p}`)}
              testID={`ark-tab-${p}`}
            >
              <Text style={[styles.tabText, panel === p && styles.tabTextActive]}>
                {t(`arkWallet.tabs.${p}`)}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
        {panel === 'receive' && (
          <ArkReceivePanel
            styles={styles}
            arkAddress={overview.arkAddress}
            onReceived={onChanged}
          />
        )}
        {panel === 'send' && (
          <ArkSendPanel styles={styles} spendableSats={overview.spendableSats} onSent={onChanged} />
        )}
        {panel === 'coins' && (
          <ArkCoinsPanel styles={styles} overview={overview} onChanged={onChanged} />
        )}
        {panel === 'backup' && (
          <ArkBackupPanel
            styles={styles}
            totalSats={overview.spendableSats + overview.pendingSats + overview.onchainSats}
            onRemove={ark.remove}
          />
        )}
        <ArkHistoryList styles={styles} items={overview.history} />
      </>
    );
  }

  return (
    <AccountScreenLayout title={t('arkWallet.title')} parent="AccountAdvanced">
      <View style={styles.banner}>
        <Text style={styles.bannerText}>{t('arkWallet.signetBanner')}</Text>
      </View>
      {content}
    </AccountScreenLayout>
  );
};

export default ArkWalletScreen;
