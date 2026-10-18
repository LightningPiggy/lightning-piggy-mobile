import { orderNotificationTarget } from './orderNotificationTarget';
import type { OrderEventType } from './orderEvents';

it.each(['order', 'receipt', 'payment', 'status', 'shipping'] as OrderEventType[])(
  'routes %s according to the viewer role and message direction',
  (type) => {
    const buyerAuthored = type === 'order' || type === 'receipt';
    for (const fromMe of [true, false]) {
      expect(orderNotificationTarget({ type, orderId: 'o' }, 'peer', fromMe)).toEqual(
        buyerAuthored !== fromMe
          ? { shopOrderId: 'o', shopBuyerPubkey: 'peer' }
          : { myOrderId: 'o', orderSellerPubkey: 'peer' },
      );
    }
  },
);

it('opens the conversation for cancellation, which either role may author', () => {
  expect(
    orderNotificationTarget({ type: 'status', status: 'cancelled', orderId: 'o' }, 'peer', false),
  ).toEqual({ conversationPubkey: 'peer', conversationProtocol: 'nip17' });
});
