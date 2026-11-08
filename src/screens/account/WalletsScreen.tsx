import React, { useMemo, useState } from 'react';
import { Text } from 'react-native';
import { Plus } from 'lucide-react-native';
import ManagedWalletRow from '../../components/ManagedWalletRow';
import AccountScreenLayout from './AccountScreenLayout';
import SettingsRow from '../../components/SettingsRow';
import SettingsSection from '../../components/SettingsSection';
import WalletSettingsSheet from '../../components/WalletSettingsSheet';
import AddWalletWizard from '../../components/AddWalletWizard';
import DefaultOnchainWalletSection from '../../components/DefaultOnchainWalletSection';
import { useWallet } from '../../contexts/WalletContext';
import { useLocale } from '../../contexts/LocaleContext';
import { useThemeColors } from '../../contexts/ThemeContext';
import { createWalletsScreenStyles } from '../../styles/WalletsScreen.styles';
import { resolveWalletHealth } from '../../utils/walletHealthDisplay';

const WalletsScreen: React.FC = () => {
  const { t } = useLocale();
  const colors = useThemeColors();
  const styles = useMemo(() => createWalletsScreenStyles(colors), [colors]);
  const { wallets, removeWallet, updateWalletSettings, reorderWallet } = useWallet();
  const [settingsWalletId, setSettingsWalletId] = useState<string | null>(null);
  const [wizardOpen, setWizardOpen] = useState(false);
  // Count what the status dots show as green, so "Checking…" wallets aren't
  // claimed as connected before they've answered (#1768).
  const connectedCount = wallets.filter((w) => resolveWalletHealth(w) === 'responsive').length;

  return (
    <AccountScreenLayout title={t('walletsScreen.title')}>
      <Text style={styles.caption} testID="wallets-summary-row">
        {wallets.length === 0
          ? t('walletsScreen.noWallets')
          : t('walletsScreen.walletCount', { count: wallets.length, connected: connectedCount })}
      </Text>
      <SettingsSection scope="account" showHeading={false} testID="wallets-section">
        {wallets.map((wallet, index) => (
          <ManagedWalletRow
            key={wallet.id}
            wallet={wallet}
            index={index}
            walletCount={wallets.length}
            onOpenSettings={setSettingsWalletId}
            onRemove={removeWallet}
            onReorder={reorderWallet}
            onUpdateSettings={updateWalletSettings}
          />
        ))}
        <SettingsRow
          kind="navigate"
          icon={Plus}
          title={t('walletsScreen.addWallet')}
          onPress={() => setWizardOpen(true)}
          accessibilityLabel={t('walletsScreen.addWalletA11y')}
          testID="add-wallet-button"
        />
        <DefaultOnchainWalletSection />
      </SettingsSection>
      <WalletSettingsSheet walletId={settingsWalletId} onClose={() => setSettingsWalletId(null)} />
      <AddWalletWizard visible={wizardOpen} onClose={() => setWizardOpen(false)} />
    </AccountScreenLayout>
  );
};

export default WalletsScreen;
