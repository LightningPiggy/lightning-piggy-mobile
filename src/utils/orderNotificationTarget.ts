import type { ParsedOrderEvent } from './orderEvents';

/** Gamma's buyer authors orders/receipts; the merchant authors payment and
 * fulfillment updates. Cancellation can come from either side, so open its
 * conversation rather than guessing which marketplace role owns it. */
export function orderNotificationTarget(
  order: Pick<ParsedOrderEvent, 'type' | 'orderId' | 'status'>,
  partner: string,
  fromMe: boolean,
) {
  if (order.type === 'status' && order.status === 'cancelled')
    return { conversationPubkey: partner, conversationProtocol: 'nip17' as const };
  const buyerAuthored = order.type === 'order' || order.type === 'receipt';
  const viewerIsSeller = buyerAuthored !== fromMe;
  return viewerIsSeller
    ? { shopOrderId: order.orderId, shopBuyerPubkey: partner }
    : { myOrderId: order.orderId, orderSellerPubkey: partner };
}
