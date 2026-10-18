import React, { useMemo } from 'react';
import { Text } from 'react-native';
import { useWallet, useWalletLive } from '../contexts/WalletContext';
import { useLocale } from '../contexts/LocaleContext';
import { useThemeColors } from '../contexts/ThemeContext';
import { createFiatAmountStyles } from '../styles/FiatAmount.styles';
import { formatFiatApprox, formatInlineFiatApprox } from '../utils/fiat';

interface Props {
  sats: number | null | undefined;
  testID?: string;
  inline?: boolean;
}

/** Approximate value using the wallet's shared rate and chosen display currency. */
function FiatAmount({ sats, testID, inline = false }: Props): React.ReactElement | null {
  const { currency } = useWallet();
  const { btcPrice } = useWalletLive();
  const { formatLocale } = useLocale();
  const colors = useThemeColors();
  const styles = useMemo(() => createFiatAmountStyles(colors), [colors]);
  const formatter = inline ? formatInlineFiatApprox : formatFiatApprox;
  const label = sats == null ? null : formatter(sats, btcPrice, currency, formatLocale);
  return label ? (
    <Text style={styles.amount} testID={testID}>
      {label}
    </Text>
  ) : null;
}

export default React.memo(FiatAmount);
