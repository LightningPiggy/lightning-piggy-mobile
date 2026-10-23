import React from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from '../../contexts/LocaleContext';
import { formatSatsNumber } from '../../utils/marketPrice';
import type { ArkOverview } from '../../services/arkMaintenance';
import type { ArkWalletStyles } from '../../styles/ArkWallet.styles';

interface Props {
  styles: ArkWalletStyles;
  overview: ArkOverview;
}

function Detail({ styles, label, sats }: { styles: ArkWalletStyles; label: string; sats: number }) {
  const t = useTranslation();
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={styles.detailValue}>
        {t('arkWallet.satsAmount', { amount: formatSatsNumber(sats) })}
      </Text>
    </View>
  );
}

/** Spendable balance, what is still settling, and how fresh the coins are. */
export default function ArkBalanceCard({ styles, overview }: Props) {
  const t = useTranslation();
  const { expiry } = overview;
  const healthStyle =
    expiry.health === 'urgent'
      ? styles.healthUrgent
      : expiry.health === 'refreshSoon'
        ? styles.healthWarn
        : styles.healthOk;
  const healthText =
    expiry.health === 'none'
      ? null
      : expiry.daysLeft === null
        ? t(`arkWallet.health.${expiry.health}`)
        : t(`arkWallet.health.${expiry.health}Days`, { days: expiry.daysLeft });

  return (
    <View style={styles.card} testID="ark-balance-card">
      <Text style={styles.balanceLabel}>{t('arkWallet.spendable')}</Text>
      <Text style={styles.balance} testID="ark-balance">
        {t('arkWallet.satsAmount', { amount: formatSatsNumber(overview.spendableSats) })}
      </Text>
      {overview.pendingSats > 0 && (
        <Detail styles={styles} label={t('arkWallet.pending')} sats={overview.pendingSats} />
      )}
      {overview.exitingSats > 0 && (
        <Detail styles={styles} label={t('arkWallet.exiting')} sats={overview.exitingSats} />
      )}
      {overview.onchainSats > 0 && (
        <Detail styles={styles} label={t('arkWallet.onchain')} sats={overview.onchainSats} />
      )}
      {healthText && (
        <Text style={healthStyle} testID="ark-coin-health">
          {healthText}
        </Text>
      )}
    </View>
  );
}
