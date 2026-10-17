import {
  createRouteLeaveTracker,
  isForAnotherAccount,
  resolveWrapConversation,
} from './notificationWrapResolver';

const PK = 'a'.repeat(64);
const PARTNER = 'b'.repeat(64);

it('resolves a wrap once the app has stored its decrypted message (#1154)', async () => {
  let calls = 0;
  const lookup = jest.fn(async () =>
    ++calls < 3 ? null : { conversation: PARTNER, wireKind: 14 },
  );
  await expect(resolveWrapConversation(PK, 'wrap', { intervalMs: 1, lookup })).resolves.toEqual({
    pubkey: PARTNER,
    protocol: 'nip17',
  });
  expect(lookup).toHaveBeenCalledWith(PK, 'wrap');
});

it('fetches the wrap itself after the first miss instead of waiting on a refresh (#1325)', async () => {
  let stored = false;
  const lookup = jest.fn(async () => (stored ? { conversation: PARTNER, wireKind: 14 } : null));
  const fetchNow = jest.fn(async () => {
    stored = true;
  });
  await expect(
    resolveWrapConversation(PK, 'wrap', { intervalMs: 10_000, lookup, fetchNow }),
  ).resolves.toEqual({ pubkey: PARTNER, protocol: 'nip17' });
  // One fetch, then an immediate second look: no poll interval was waited.
  expect(fetchNow).toHaveBeenCalledTimes(1);
  expect(lookup).toHaveBeenCalledTimes(2);
});

it('does not wait past the deadline for a stalled direct fetch', async () => {
  const lookup = jest.fn(async () => null);
  const fetchNow = jest.fn(() => new Promise<void>(() => {})); // never settles
  const started = Date.now();
  await expect(
    resolveWrapConversation(PK, 'wrap', { timeoutMs: 30, intervalMs: 5, lookup, fetchNow }),
  ).resolves.toBeNull();
  expect(Date.now() - started).toBeLessThan(1000);
});

it('gives up after the timeout, or as soon as the result is no longer wanted', async () => {
  const lookup = jest.fn(async () => null);
  await expect(
    resolveWrapConversation(PK, 'wrap', { timeoutMs: 20, intervalMs: 5, lookup }),
  ).resolves.toBeNull();
  await expect(
    resolveWrapConversation(PK, 'wrap', { lookup, shouldStop: () => true }),
  ).resolves.toBeNull();
});

it("doesn't count the tap's own pending tab switch as moving on, but sees any later leave", () => {
  const tracker = createRouteLeaveTracker('Messages');
  tracker.onRoute('Home'); // navigate() hasn't landed yet
  expect(tracker.movedOn()).toBe(false);
  tracker.onRoute('Messages');
  expect(tracker.movedOn()).toBe(false);
  tracker.onRoute('Explore'); // left — recorded at the transition, not at a poll
  tracker.onRoute('Messages'); // even if they come back before the next poll
  expect(tracker.movedOn()).toBe(true);
});

it('treats a message alert for another signed-in account as not openable here', () => {
  expect(isForAnotherAccount({ kind: 'dm', owner: PK }, PARTNER)).toBe(true);
  expect(isForAnotherAccount({ kind: 'group', owner: PK }, PARTNER)).toBe(true);
  expect(isForAnotherAccount({ kind: 'dm', owner: PK.toUpperCase() }, PK)).toBe(false);
  expect(isForAnotherAccount({ kind: 'dm' }, PK)).toBe(false); // older alerts: no owner
  expect(isForAnotherAccount({ kind: 'payment', owner: PK }, PARTNER)).toBe(false);
});

it('falls back to chat for an unparseable marketplace row', async () => {
  expect(
    await resolveWrapConversation(PK, 'wrap', {
      lookup: async () => ({ conversation: PARTNER, wireKind: 16 }),
    }),
  ).toEqual({ pubkey: PARTNER, protocol: 'nip17' });
});

it.each([
  ['order', 16, { shopOrderId: 'original-order', shopBuyerPubkey: PARTNER }],
  ['receipt', 17, { shopOrderId: 'original-order', shopBuyerPubkey: PARTNER }],
  ['payment', 16, { myOrderId: 'original-order', orderSellerPubkey: PARTNER }],
  ['status', 16, { myOrderId: 'original-order', orderSellerPubkey: PARTNER }],
  ['shipping', 16, { myOrderId: 'original-order', orderSellerPubkey: PARTNER }],
] as const)(
  'preserves the account role for a background %s alert',
  async (orderType, wireKind, target) => {
    expect(
      await resolveWrapConversation(PK, 'wrap', {
        lookup: async () => ({
          conversation: PARTNER,
          wireKind,
          orderId: 'original-order',
          orderType,
          fromMe: false,
        }),
      }),
    ).toEqual({ pubkey: PARTNER, protocol: 'nip17', ...target });
  },
);
