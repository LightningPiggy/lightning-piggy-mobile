import React from 'react';
import { Text, View } from 'react-native';
import { useTranslation } from '../../contexts/LocaleContext';
import { formatSatsNumber } from '../../utils/marketPrice';
import type { ArkHistoryItem } from '../../utils/arkCoinHealth';
import type { ArkWalletStyles } from '../../styles/ArkWallet.styles';

interface Props {
  styles: ArkWalletStyles;
  items: ArkHistoryItem[];
}

const Row = React.memo(function Row({
  styles,
  item,
}: {
  styles: ArkWalletStyles;
  item: ArkHistoryItem;
}) {
  const t = useTranslation();
  const incoming = item.kind === 'received';
  const status = item.failed ? 'failed' : item.pending ? 'pending' : null;
  return (
    <View style={styles.historyRow} testID={`ark-history-${item.id}`}>
      <View>
        <Text style={styles.body}>{t(`arkWallet.history.${item.kind}`)}</Text>
        {status && <Text style={styles.hint}>{t(`arkWallet.history.${status}`)}</Text>}
      </View>
      <Text style={incoming ? styles.historyIn : styles.historyOut}>
        {(incoming ? '+' : item.kind === 'sent' || item.kind === 'exit' ? '−' : '') +
          t('arkWallet.satsAmount', { amount: formatSatsNumber(item.amountSats) })}
      </Text>
    </View>
  );
});

/** The latest Ark movements (bounded by `toArkHistory`, so a plain map is fine). */
export default function ArkHistoryList({ styles, items }: Props) {
  const t = useTranslation();
  return (
    <View style={styles.card} testID="ark-history">
      <Text style={styles.heading}>{t('arkWallet.historyTitle')}</Text>
      {items.length === 0 ? (
        <Text style={styles.hint}>{t('arkWallet.historyEmpty')}</Text>
      ) : (
        items.map((item) => <Row key={item.id} styles={styles} item={item} />)
      )}
    </View>
  );
}
