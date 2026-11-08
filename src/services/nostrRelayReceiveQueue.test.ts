import { AbstractRelay } from 'nostr-tools/abstract-relay';
import { finalizeEvent, type VerifiedEvent } from 'nostr-tools/pure';
import { RelayReceiveQueue, paceRelayReceive } from './nostrRelayReceiveQueue';
import {
  verifyEventCached,
  __resetVerifiedEventCache,
  flushVerifiedEventCache,
} from './nostrVerifyCache';

jest.mock('./nostrVerifyCache', () => ({
  ...jest.requireActual('./nostrVerifyCache'),
  hydrateVerifiedEventCache: jest.fn(async () => {}),
  flushVerifiedEventCache: jest.fn(async () => {}),
}));

const message = (data: unknown[]) => ({ data: JSON.stringify(data) }) as MessageEvent;
const key = new Uint8Array(32).fill(7);

beforeEach(() => jest.useFakeTimers());
afterEach(() => {
  __resetVerifiedEventCache();
  jest.restoreAllMocks();
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('shares a budget across sockets: 1,300 34ms verification units each hand back the thread', async () => {
  const queue = new RelayReceiveQueue();
  const costs: number[] = [];
  let burst = 0;
  let workClock = 0;
  jest.spyOn(performance, 'now').mockImplementation(() => workClock);
  // Advancing fake clock simulates indivisible Pixel/Hermes crypto, while
  // timer callbacks model touch dispatch getting a turn between units.
  const schedule = global.setTimeout;
  jest.spyOn(global, 'setTimeout').mockImplementation(((callback: () => void, delay?: number) =>
    schedule(() => {
      costs.push(burst);
      burst = 0;
      callback();
    }, delay)) as typeof setTimeout);
  for (let i = 0; i < 1300; i++) {
    queue.enqueue(() => {
      burst += 34;
      workClock += 34;
    });
  }
  await jest.advanceTimersByTimeAsync(1500);
  costs.push(burst);
  expect(costs.filter(Boolean)).toHaveLength(1300);
  expect(Math.max(...costs)).toBe(34);
});

it('budget gate lets cheap work share a slice without a timer per event', async () => {
  const queue = new RelayReceiveQueue();
  const run = jest.fn();
  for (let i = 0; i < 10; i++) queue.enqueue(run);
  await jest.advanceTimersByTimeAsync(1);
  expect(run).toHaveBeenCalledTimes(10);
  expect(jest.getTimerCount()).toBe(0);
});

it('SDK receives only valid signatures, in order before EOSE (including timeout)', async () => {
  const relay = new AbstractRelay('wss://test/', {
    verifyEvent: verifyEventCached as (e: unknown) => e is VerifiedEvent,
  });
  jest.spyOn(relay, 'send').mockResolvedValue();
  paceRelayReceive(relay, new RelayReceiveQueue());
  const delivered: string[] = [];
  const event = finalizeEvent({ kind: 4, created_at: 1, tags: [], content: 'valid' }, key);
  const sub = relay.subscribe([{ kinds: [4] }], {
    id: 'dm',
    onevent: (e) => delivered.push(e.content),
    oneose: () => delivered.push('EOSE'),
    eoseTimeout: 1,
  });
  relay._onmessage(message(['EVENT', sub.id, { ...event, content: 'forged' }]));
  relay._onmessage(message(['EVENT', sub.id, { ...event, sig: '0'.repeat(128) }]));
  relay._onmessage(message(['EVENT', sub.id, event]));
  relay._onmessage(message(['EOSE', sub.id]));
  expect(delivered).toEqual([]);
  await jest.advanceTimersByTimeAsync(200);
  expect(delivered).toEqual(['valid', 'EOSE']);
  relay.close();
});

it('closed subscriptions discard queued events and control replies bypass the backlog', async () => {
  const relay = new AbstractRelay('wss://test/', { verifyEvent: (e): e is VerifiedEvent => !!e });
  jest.spyOn(relay, 'send').mockResolvedValue();
  paceRelayReceive(relay, new RelayReceiveQueue());
  const onevent = jest.fn();
  const sub = relay.prepareSubscription([{ kinds: [4] }], { id: 'dm', onevent });
  relay._onmessage(message(['EVENT', sub.id, { kind: 4 }]));
  const count = relay.count([], { id: 'count' });
  relay._onmessage(message(['COUNT', 'count', { count: 5 }]));
  sub.close();
  await expect(count).resolves.toBe(5);
  await jest.advanceTimersByTimeAsync(10);
  expect(onevent).not.toHaveBeenCalled();
  relay.close();
});

it('bounds queued receive memory', async () => {
  const queue = new RelayReceiveQueue();
  expect(queue.enqueue(() => {}, 8 * 1024 * 1024)).toBe(true);
  expect(queue.enqueue(() => {}, 1)).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
});

it('EOSE never awaits verify-cache persistence (it runs in the background)', async () => {
  // The queue never waits on a storage write: verifyEventCached schedules it.
  const relay = new AbstractRelay('wss://test/', { verifyEvent: (e): e is VerifiedEvent => !!e });
  jest.spyOn(relay, 'send').mockResolvedValue();
  paceRelayReceive(relay, new RelayReceiveQueue());
  const eose = jest.fn();
  const sub = relay.prepareSubscription([{ kinds: [4] }], { id: 'dm', oneose: eose });
  relay._onmessage(message(['EOSE', sub.id]));
  await jest.advanceTimersByTimeAsync(1);
  expect(eose).toHaveBeenCalledTimes(1);
  expect(flushVerifiedEventCache).not.toHaveBeenCalled();
  relay.close();
});

it('preserves wire EOSE before later events', async () => {
  const relay = new AbstractRelay('wss://test/', {
    verifyEvent: verifyEventCached as (e: unknown) => e is VerifiedEvent,
  });
  jest.spyOn(relay, 'send').mockResolvedValue();
  paceRelayReceive(relay, new RelayReceiveQueue());
  const delivered: string[] = [];
  const sub = relay.subscribe([{ kinds: [4] }], {
    id: 'dm',
    onevent: (e) => delivered.push(e.content),
    oneose: () => delivered.push('EOSE'),
    eoseTimeout: 10_000,
  });
  const event = (content: string) =>
    finalizeEvent({ kind: 4, created_at: 1, tags: [], content }, key);
  relay._onmessage(message(['EVENT', sub.id, event('before')]));
  relay._onmessage(message(['EOSE', sub.id]));
  relay._onmessage(message(['EVENT', sub.id, event('after')]));
  expect(delivered).toEqual([]);
  await jest.advanceTimersByTimeAsync(100);
  expect(delivered).toEqual(['before', 'EOSE', 'after']);
  relay.close();
});
