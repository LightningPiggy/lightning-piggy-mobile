import React, { useMemo } from 'react';
import { View, Text } from 'react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createOrderStatusChipStyles } from '../styles/OrderStatusChip.styles';
import type { BuyerOrderStatus } from '../utils/orderThreads';

/** Every order status either side shows (labels: `orderStatus.<status>`). */
export type OrderChipStatus = BuyerOrderStatus | 'needsInvoice' | 'invoiceSent';

type Tone = 'waiting' | 'action' | 'done' | 'moving' | 'stopped';
const TONE: Record<OrderChipStatus, Tone> = {
  awaitingInvoice: 'waiting',
  needsInvoice: 'waiting',
  invoiceExpired: 'stopped',
  payNow: 'action',
  invoiceSent: 'action',
  paid: 'done',
  completed: 'done',
  shipped: 'moving',
  cancelled: 'stopped',
};

interface Props {
  status: OrderChipStatus;
  testID?: string;
}

/** Small lifecycle chip: "Awaiting invoice", "Pay now", "Paid", … */
function OrderStatusChip({ status, testID }: Props): React.ReactElement {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createOrderStatusChipStyles(colors), [colors]);
  const tone = TONE[status];
  return (
    <View style={[styles.chip, styles[tone]]} testID={testID}>
      <Text style={[styles.text, styles[`${tone}Text`]]}>{t(`orderStatus.${status}`)}</Text>
    </View>
  );
}

export default React.memo(OrderStatusChip);
