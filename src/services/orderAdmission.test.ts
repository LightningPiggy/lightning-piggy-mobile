import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  acceptOrderRumor,
  completeOrderRumors,
  orderBudgetKey,
  releaseOrderRumors,
} from './orderAdmission';
import { resetSellerStore } from './sellerEventStore';
import { rumorEventId, type DecodedRumor } from '../utils/nip17Unwrap';
const OWNER = 'a'.repeat(64);
const rumor = (n: number): DecodedRumor => ({
  kind: 16,
  pubkey: 'b'.repeat(64),
  created_at: n,
  content: '',
  tags: [
    ['p', OWNER],
    ['order', String(n)],
    ['type', '1'],
  ],
});
beforeEach(async () => {
  releaseOrderRumors(
    OWNER,
    Array.from({ length: 100 }, (_, n) => rumor(n)),
  );
  await AsyncStorage.clear();
  resetSellerStore();
});
it('serializes simultaneous admissions and persists rejection counts', async () => {
  const admitted = await Promise.all(
    Array.from({ length: 20 }, (_, n) => acceptOrderRumor(OWNER, rumor(n), false)),
  );
  expect(admitted.filter(Boolean)).toHaveLength(5);
  const budget = JSON.parse((await AsyncStorage.getItem(orderBudgetKey(OWNER)))!);
  expect(budget.accepted).toHaveLength(5);
  expect(budget.dropped).toBe(15);
  expect(await acceptOrderRumor(OWNER, rumor(50), false)).toBe(false);
});
it('uses receipt time, rejects malformed orders, and never budgets outgoing copies', async () => {
  expect(await acceptOrderRumor(OWNER, { ...rumor(1), tags: [] }, false)).toBe(false);
  for (let n = 0; n < 8; n++) expect(await acceptOrderRumor(OWNER, rumor(n), true)).toBe(true);
  expect(await AsyncStorage.getItem(orderBudgetKey(OWNER))).toBeNull();
});
it('recovers corrupted persisted counters and fails closed on storage failure', async () => {
  await AsyncStorage.setItem(orderBudgetKey(OWNER), '{bad');
  expect(await acceptOrderRumor(OWNER, rumor(1), false)).toBe(true);
  expect(JSON.parse((await AsyncStorage.getItem(orderBudgetKey(OWNER)))!).accepted).toHaveLength(1);
  await AsyncStorage.clear();
  jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk'));
  expect(await acceptOrderRumor(OWNER, rumor(2), false)).toBe(false);
  jest.restoreAllMocks();
});

it('recovers uncommitted reservations across restart without spending more budget', async () => {
  // Simulate startup after a process died between reservation and payload writes.
  await AsyncStorage.setItem(
    orderBudgetKey(OWNER),
    JSON.stringify({
      accepted: [{ id: rumorEventId(rumor(1)), sender: rumor(1).pubkey, at: Date.now() }],
      dropped: 0,
      droppedSince: Date.now(),
    }),
  );
  expect(await acceptOrderRumor(OWNER, rumor(1), false)).toBe(true);
  const budget = JSON.parse((await AsyncStorage.getItem(orderBudgetKey(OWNER)))!);
  expect(budget.accepted).toHaveLength(1);
  expect(budget.dropped).toBe(0);
  await completeOrderRumors(OWNER, [rumor(1)]);
  expect(await acceptOrderRumor(OWNER, rumor(1), false)).toBe(false);
});

it('keeps a failed completion retryable', async () => {
  expect(await acceptOrderRumor(OWNER, rumor(1), false)).toBe(true);
  jest.spyOn(AsyncStorage, 'setItem').mockRejectedValueOnce(new Error('disk'));
  await completeOrderRumors(OWNER, [rumor(1)]);
  expect(await acceptOrderRumor(OWNER, rumor(1), false)).toBe(true);
  jest.restoreAllMocks();
});

it('admits one of 100 pending copies across simultaneous callers', async () => {
  const results = await Promise.all(
    Array.from({ length: 100 }, () => acceptOrderRumor(OWNER, rumor(1), false)),
  );
  expect(results.filter(Boolean)).toHaveLength(1);
  const budget = JSON.parse((await AsyncStorage.getItem(orderBudgetKey(OWNER)))!);
  expect(budget.accepted).toHaveLength(1);
  expect(budget.dropped).toBe(0);
});

it('releases failed payload delivery without spending another budget slot', async () => {
  expect(await acceptOrderRumor(OWNER, rumor(1), false)).toBe(true);
  expect(await acceptOrderRumor(OWNER.toUpperCase(), rumor(1), false)).toBe(false);
  releaseOrderRumors(OWNER, [rumor(1)]);
  expect(await acceptOrderRumor(OWNER, rumor(1), false)).toBe(true);
  const budget = JSON.parse((await AsyncStorage.getItem(orderBudgetKey(OWNER)))!);
  expect(budget.accepted).toHaveLength(1);
});

it('scopes pending claims and completion to account and sender', async () => {
  const otherOwner = 'c'.repeat(64);
  const otherSender = { ...rumor(1), pubkey: 'd'.repeat(64) };
  expect(await acceptOrderRumor(OWNER, rumor(1), false)).toBe(true);
  expect(await acceptOrderRumor(otherOwner, rumor(1), false)).toBe(true);
  expect(await acceptOrderRumor(OWNER, otherSender, false)).toBe(true);
  await completeOrderRumors(OWNER, [rumor(1)]);
  expect(await acceptOrderRumor(otherOwner, rumor(1), false)).toBe(false);
  releaseOrderRumors(otherOwner, [rumor(1)]);
  releaseOrderRumors(OWNER, [otherSender]);
  expect(await acceptOrderRumor(otherOwner, rumor(1), false)).toBe(true);
  expect(await acceptOrderRumor(OWNER, otherSender, false)).toBe(true);
  await completeOrderRumors(otherOwner, [rumor(1)]);
  await completeOrderRumors(OWNER, [otherSender]);
});

it('budgets every inbound lifecycle rumor in a full window', async () => {
  for (let n = 0; n < 5; n++) await acceptOrderRumor(OWNER, rumor(n), false);
  for (const type of ['2', '3', '4']) {
    const update = {
      ...rumor(20),
      tags: [
        ['order', 'placed'],
        ['type', type],
      ],
    };
    expect(await acceptOrderRumor(OWNER, update, false)).toBe(false);
    await completeOrderRumors(OWNER, [update]);
  }
  expect(await acceptOrderRumor(OWNER, rumor(30), false)).toBe(false);
  expect(
    await acceptOrderRumor(
      OWNER,
      {
        ...rumor(31),
        kind: 17,
        tags: [
          ['order', '31'],
          ['subject', 'order-receipt'],
        ],
      },
      false,
    ),
  ).toBe(false);
  expect(JSON.parse((await AsyncStorage.getItem(orderBudgetKey(OWNER)))!).accepted).toHaveLength(5);
});

it('persists a daily bound for distinct buyer cancellations, including across restarts', async () => {
  const original = rumor(1);
  expect(await acceptOrderRumor(OWNER, original, false)).toBe(true);
  await completeOrderRumors(OWNER, [original]);
  let allowed = 0;
  for (let n = 0; n < 10; n++) {
    const cancellation = {
      ...rumor(100 + n),
      tags: [
        ['type', '3'],
        ['order', '1'],
        ['status', 'cancelled'],
      ],
    };
    if (await acceptOrderRumor(OWNER, cancellation, false)) {
      allowed++;
      await completeOrderRumors(OWNER, [cancellation]);
    }
  }
  expect(allowed).toBe(4);
  const budget = JSON.parse((await AsyncStorage.getItem(orderBudgetKey(OWNER)))!);
  expect(budget.accepted).toHaveLength(5);
  expect(budget.accepted.every((entry: { stored: boolean }) => entry.stored)).toBe(true);
  expect(budget.dropped).toBe(6);
});

it.each(['2', '3', '4'])(
  'deduplicates completed merchant type %s across fresh wraps and bounds updates',
  async (type) => {
    const update = {
      ...rumor(900),
      tags: [
        ['order', 'placed'],
        ['type', type],
      ],
    };
    expect(await acceptOrderRumor(OWNER, update, false)).toBe(true);
    await completeOrderRumors(OWNER, [update]);
    for (let n = 0; n < 1000; n++) expect(await acceptOrderRumor(OWNER, update, false)).toBe(false);
    let allowed = 0;
    for (let n = 0; n < 10; n++) {
      const next = { ...update, created_at: 1000 + n };
      if (await acceptOrderRumor(OWNER, next, false)) {
        allowed++;
        await completeOrderRumors(OWNER, [next]);
      }
    }
    expect(allowed).toBe(4);
  },
);
