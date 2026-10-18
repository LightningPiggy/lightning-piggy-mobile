import { getOutgoingOrderRows, hasIncomingOrder } from '../services/dmDb';
import { serializeOrder, parseOrderEvent } from '../utils/orderEvents';
import {
  admitOrderLifecycle,
  getDroppedOrderLifecycleCount,
  admitUnfollowedOrder,
  isBoundedOrderRumor,
  ORDER_RUMOR_RATE_LIMIT,
  ORDER_RUMOR_MAX_CHARS,
} from './orderRumorIngest';

jest.mock('../services/dmDb', () => ({
  getOutgoingOrderRows: jest.fn(),
  hasIncomingOrder: jest.fn().mockResolvedValue(false),
}));

it('caps the shared live/backfill account budget and permits retries in the next window', () => {
  for (let i = 0; i < ORDER_RUMOR_RATE_LIMIT; i++) {
    expect(admitUnfollowedOrder('rate-test', 1000)).toBe(true);
  }
  expect(admitUnfollowedOrder('rate-test', 1001)).toBe(false);
  expect(admitUnfollowedOrder('another-account', 1001)).toBe(true);
  expect(admitUnfollowedOrder('rate-test', 61000)).toBe(true);
});

it('caps content and tags, rejecting unrelated website reactions and reposts', () => {
  const order = {
    kind: 16,
    content: '',
    tags: [
      ['type', '2'],
      ['order', 'o'],
    ],
  };
  expect(isBoundedOrderRumor(order)).toBe(true);
  expect(isBoundedOrderRumor({ ...order, content: 'x'.repeat(ORDER_RUMOR_MAX_CHARS) })).toBe(false);
  expect(
    isBoundedOrderRumor({
      ...order,
      tags: [...order.tags, ['address', 'x'.repeat(ORDER_RUMOR_MAX_CHARS)]],
    }),
  ).toBe(false);
  expect(isBoundedOrderRumor({ ...order, tags: [...order.tags, ['k', '1']] })).toBe(false);
  expect(isBoundedOrderRumor({ ...order, kind: 17 })).toBe(false);
  expect(isBoundedOrderRumor({ ...order, kind: 14 })).toBe(false);
});

it.each(['2', '3', '4', 'receipt'])(
  'requires a placed order and its actual seller for lifecycle %s',
  async (type) => {
    const owner = `buyer-${type}`;
    const rumor = {
      kind: type === 'receipt' ? 17 : 16,
      content: '',
      tags: [
        ['order', 'purchase'],
        ...(type === 'receipt' ? [['subject', 'order-receipt']] : [['type', type]]),
      ],
    };
    const original = {
      owner,
      sender: owner,
      fromMe: true,
      conversation: 'seller',
      content: serializeOrder(
        parseOrderEvent({
          kind: 16,
          content: '',
          tags: [
            ['type', '1'],
            ['order', 'purchase'],
          ],
        })!,
      ),
    };
    (getOutgoingOrderRows as jest.Mock).mockResolvedValue([]);
    expect(await admitOrderLifecycle(owner, 'seller', false, rumor)).toBe(false);
    expect(getDroppedOrderLifecycleCount(owner)).toBe(1);
    (getOutgoingOrderRows as jest.Mock).mockResolvedValue([original]);
    expect(await admitOrderLifecycle(owner, 'impostor', false, rumor)).toBe(false);
    expect(
      await admitOrderLifecycle(owner, 'seller', false, {
        ...rumor,
        tags: [['order', 'different'], ...rumor.tags.slice(1)],
      }),
    ).toBe(false);
    expect(await admitOrderLifecycle(owner, 'seller', false, rumor)).toBe(true);
    expect(getOutgoingOrderRows).toHaveBeenLastCalledWith(owner, 'seller', ['purchase']);
    expect(getDroppedOrderLifecycleCount(owner)).toBe(3);
    (getOutgoingOrderRows as jest.Mock).mockResolvedValue([
      {
        ...original,
        content: serializeOrder(
          parseOrderEvent({
            kind: 16,
            content: '',
            tags: [
              ['type', '2'],
              ['order', 'purchase'],
            ],
          })!,
        ),
      },
    ]);
    expect(await admitOrderLifecycle(owner, 'seller', false, rumor)).toBe(false);
  },
);

it.each(['receipt', 'cancelled'])(
  'admits buyer %s against incoming history without a local invoice',
  async (type) => {
    const owner = 'seller-role';
    const partner = 'buyer';
    const rumor = {
      kind: type === 'receipt' ? 17 : 16,
      content: '',
      tags: [
        ['order', 'sold-order'],
        ...(type === 'receipt'
          ? [['subject', 'order-receipt']]
          : [
              ['type', '3'],
              ['status', 'cancelled'],
            ]),
      ],
    };
    (getOutgoingOrderRows as jest.Mock).mockResolvedValue([]);
    (hasIncomingOrder as jest.Mock).mockImplementation(
      async (account, buyer, id) => account === owner && buyer === partner && id === 'sold-order',
    );
    expect(await admitOrderLifecycle(owner, partner, false, rumor)).toBe(true);
    expect(hasIncomingOrder).toHaveBeenLastCalledWith(owner, partner, 'sold-order');
    expect(await admitOrderLifecycle(owner, 'impostor', false, rumor)).toBe(false);
    expect(await admitOrderLifecycle('other-account', partner, false, rumor)).toBe(false);
    expect(
      await admitOrderLifecycle(owner, partner, false, {
        ...rumor,
        tags: [['order', 'unknown'], ...rumor.tags.slice(1)],
      }),
    ).toBe(false);
    for (const tags of [
      [['type', '2']],
      [
        ['type', '3'],
        ['status', 'paid'],
      ],
      [['type', '4']],
    ]) {
      expect(
        await admitOrderLifecycle(owner, partner, false, {
          kind: 16,
          content: '',
          tags: [['order', 'sold-order'], ...tags],
        }),
      ).toBe(false);
    }
  },
);
