import { AbstractRelay } from 'nostr-tools/abstract-relay';
import type { Filter } from 'nostr-tools/filter';
import type { VerifiedEvent } from 'nostr-tools/pure';
import {
  INBOX_BURST,
  RECEIVE_QUEUE_MAX_BYTES,
  RelayReceiveQueue,
  isInboxSubscription,
  paceRelayReceive,
} from './nostrRelayReceiveQueue';
import { hydrateVerifiedEventCache } from './nostrVerifyCache';
import { RECEIVE_PERF_WINDOW_MS, takeReceiveWindow } from './relayReceivePerf';
import { reqPriority } from './relayReqBudget';

// Priority lanes (#1758): inbox subscriptions (kind 4 / 1059) drain ahead of
// other features' relay traffic, without starving it or reordering a
// subscription's own frames.
jest.mock('./nostrVerifyCache', () => ({
  hydrateVerifiedEventCache: jest.fn(async () => {}),
  flushVerifiedEventCache: jest.fn(async () => {}),
}));

const message = (data: unknown[]) => ({ data: JSON.stringify(data) }) as MessageEvent;
const event = (kind: number, content: string) => ({ kind, content, created_at: 1, tags: [] });

function pacedRelay() {
  const relay = new AbstractRelay('wss://lanes/', { verifyEvent: (e): e is VerifiedEvent => !!e });
  jest.spyOn(relay, 'send').mockResolvedValue();
  paceRelayReceive(relay, new RelayReceiveQueue());
  const order: string[] = [];
  const open = (id: string, kinds: number[]) =>
    relay.subscribe([{ kinds }], {
      id,
      onevent: (e) => order.push(`${id}:${e.content}`),
      oneose: () => order.push(`${id}:EOSE`),
      eoseTimeout: 60_000,
    });
  return { relay, order, open };
}
const only = (order: string[], id: string) => order.filter((entry) => entry.startsWith(`${id}:`));

beforeEach(() => {
  jest.useFakeTimers();
  takeReceiveWindow(Date.now() + RECEIVE_PERF_WINDOW_MS); // start each test with an empty window
});
afterEach(() => {
  jest.restoreAllMocks();
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('processes inbox frames before normal frames that were queued ahead of them', async () => {
  const { relay, order, open } = pacedRelay();
  open('group', [445]);
  open('dm', [1059]);
  for (let i = 0; i < 20; i++) relay._onmessage(message(['EVENT', 'group', event(445, `${i}`)]));
  relay._onmessage(message(['EVENT', 'dm', event(1059, 'hello')]));
  relay._onmessage(message(['EOSE', 'dm']));
  await jest.advanceTimersByTimeAsync(10);
  expect(order.slice(0, 2)).toEqual(['dm:hello', 'dm:EOSE']);
  expect(only(order, 'group')).toEqual(Array.from({ length: 20 }, (_, i) => `group:${i}`));
  relay.close();
});

it('never starves the normal lane: one normal job after every INBOX_BURST inbox jobs', async () => {
  const queue = new RelayReceiveQueue();
  const order: string[] = [];
  for (let i = 0; i < 5; i++) queue.enqueue(() => void order.push('normal'), 0, 'normal');
  for (let i = 0; i < 40; i++) queue.enqueue(() => void order.push('inbox'), 0, 'inbox');
  await jest.advanceTimersByTimeAsync(10);
  expect(order).toHaveLength(45);
  const normalAt = order.flatMap((lane, i) => (lane === 'normal' ? [i] : []));
  expect(normalAt).toEqual([1, 2, 3, 4, 5].map((n) => n * (INBOX_BURST + 1) - 1));
});

it("keeps each subscription's frames in order (EVENT before its EOSE) in both lanes", async () => {
  const { relay, order, open } = pacedRelay();
  open('zaps', [9735]);
  open('dm', [4]);
  // Interleave both subscriptions on one socket, inbox outnumbering the burst.
  for (let i = 0; i < 12; i++) {
    relay._onmessage(message(['EVENT', 'zaps', event(9735, `${i}`)]));
    relay._onmessage(message(['EVENT', 'dm', event(4, `${i}`)]));
  }
  relay._onmessage(message(['EOSE', 'dm']));
  relay._onmessage(message(['EOSE', 'zaps']));
  relay._onmessage(message(['EVENT', 'dm', event(4, 'live')]));
  await jest.advanceTimersByTimeAsync(10);
  const sequence = (id: string) => [...Array.from({ length: 12 }, (_, i) => `${id}:${i}`)];
  expect(only(order, 'dm')).toEqual([...sequence('dm'), 'dm:EOSE', 'dm:live']);
  expect(only(order, 'zaps')).toEqual([...sequence('zaps'), 'zaps:EOSE']);
  // The inbox finished first even though zaps arrived first.
  expect(order.indexOf('dm:EOSE')).toBeLessThan(order.indexOf('zaps:EOSE'));
  relay.close();
});

it('a barrier (snapshot deadline) runs only after every earlier job in both lanes', async () => {
  const queue = new RelayReceiveQueue();
  const order: string[] = [];
  queue.enqueue(() => void order.push('normal-1'), 0, 'normal');
  queue.enqueue(() => void order.push('inbox-1'), 0, 'inbox');
  queue.enqueueBarrier(() => void order.push('barrier'));
  queue.enqueue(() => void order.push('inbox-2'), 0, 'inbox');
  queue.enqueue(() => void order.push('normal-2'), 0, 'normal');
  await jest.advanceTimersByTimeAsync(10);
  const at = (name: string) => order.indexOf(name);
  expect(at('barrier')).toBeGreaterThan(at('normal-1'));
  expect(at('barrier')).toBeGreaterThan(at('inbox-1'));
  // Work queued after the barrier, in either lane, never overtakes it.
  expect(at('normal-2')).toBeGreaterThan(at('barrier'));
  expect(at('inbox-2')).toBeGreaterThan(at('barrier'));
  expect(order).toHaveLength(5);
});

it('a barrier BEHIND a normal backlog holds newer inbox work until it has run', async () => {
  // e.g. a snapshot deadline queued behind a 500-event zap / group backfill:
  // post-deadline inbox frames must not run 4:1 ahead of that backlog,
  // extending the snapshot and delaying finish().
  const queue = new RelayReceiveQueue();
  const order: string[] = [];
  queue.enqueue(() => void order.push('inbox-old'), 0, 'inbox');
  for (let i = 0; i < 10; i++) queue.enqueue(() => void order.push(`normal-${i}`), 0, 'normal');
  queue.enqueueBarrier(() => void order.push('barrier'));
  for (let i = 0; i < 10; i++) queue.enqueue(() => void order.push(`inbox-new-${i}`), 0, 'inbox');
  queue.enqueue(() => void order.push('normal-after'), 0, 'normal');
  await jest.advanceTimersByTimeAsync(10);
  expect(order.slice(0, 12)).toEqual([
    'inbox-old',
    ...Array.from({ length: 10 }, (_, i) => `normal-${i}`),
    'barrier',
  ]);
  // Past the barrier, the inbox goes first again.
  expect(order[12]).toBe('inbox-new-0');
  expect(order).toHaveLength(23);
});

it('a barrier at the head of the normal lane waits for OLDER inbox work only', async () => {
  const queue = new RelayReceiveQueue();
  const order: string[] = [];
  queue.enqueue(() => void order.push('inbox-old'), 0, 'inbox');
  queue.enqueueBarrier(() => void order.push('barrier'));
  queue.enqueue(() => void order.push('normal'), 0, 'normal');
  await jest.advanceTimersByTimeAsync(10);
  expect(order).toEqual(['inbox-old', 'barrier', 'normal']);
});

it('an unattributable (escaped) frame fences its socket: later frames cannot overtake it', async () => {
  const { relay, order, open } = pacedRelay();
  open('dm', [1059]);
  // More inbox frames than one burst, so normal-lane jobs get fairness turns.
  for (let i = 0; i < 3 * INBOX_BURST; i++)
    relay._onmessage(message(['EVENT', 'dm', event(1059, `${i}`)]));
  // Valid JSON for EVENT, but the cheap classifier can't read it: it goes to
  // the normal lane as a barrier, and the socket's later frames follow it.
  relay._onmessage({
    data: JSON.stringify(['EVENT', 'dm', event(1059, 'escaped')]).replace('EVENT', '\\u0045VENT'),
  } as MessageEvent);
  relay._onmessage(message(['EOSE', 'dm']));
  await jest.advanceTimersByTimeAsync(10);
  expect(order).toEqual([
    ...Array.from({ length: 3 * INBOX_BURST }, (_, i) => `dm:${i}`),
    'dm:escaped',
    'dm:EOSE',
  ]);
  relay.close();
});

it('the fence survives a reconnect while the demoted frames are still queued', async () => {
  const { relay, order, open } = pacedRelay();
  open('group', [445]);
  open('dm', [1059]);
  for (let i = 0; i < 5; i++) relay._onmessage(message(['EVENT', 'group', event(445, `${i}`)]));
  relay._onmessage({
    data: JSON.stringify(['EVENT', 'dm', event(1059, 'escaped')]).replace('EVENT', '\\u0045VENT'),
  } as MessageEvent);
  // connect() assigns a fresh WebSocket; the escaped frame is still queued.
  (relay as unknown as { ws: object }).ws = {};
  relay._onmessage(message(['EOSE', 'dm']));
  await jest.advanceTimersByTimeAsync(10);
  expect(only(order, 'dm')).toEqual(['dm:escaped', 'dm:EOSE']);
  // Once every demoted frame has run, the relay's inbox frames go first again.
  order.length = 0;
  for (let i = 0; i < 5; i++) relay._onmessage(message(['EVENT', 'group', event(445, `x${i}`)]));
  relay._onmessage(message(['EVENT', 'dm', event(1059, 'later')]));
  await jest.advanceTimersByTimeAsync(10);
  expect(order[0]).toBe('dm:later');
  relay.close();
});

it('the lanes share the byte cap, and overflow still closes the socket', async () => {
  const queue = new RelayReceiveQueue();
  expect(queue.enqueue(() => {}, RECEIVE_QUEUE_MAX_BYTES, 'normal')).toBe(true);
  expect(queue.enqueue(() => {}, 1, 'inbox')).toBe(false);
  expect(queue.enqueueBarrier(() => {}, 1)).toBe(false);
  await jest.advanceTimersByTimeAsync(1);

  const { relay, open } = pacedRelay();
  open('dm', [1059]);
  const close = jest.spyOn(relay, 'close');
  // ~8 MiB of UTF-16 in one inbox frame: over the cap on its own.
  relay._onmessage(
    message(['EVENT', 'dm', event(1059, 'x'.repeat(RECEIVE_QUEUE_MAX_BYTES / 2 + 1))]),
  );
  expect(close).toHaveBeenCalledTimes(1);
});

it('classifies inbox subscriptions exactly like the REQ budget (priority 0)', () => {
  const cases: Filter[][] = [
    [{ kinds: [4] }],
    [{ kinds: [1059], '#p': ['a'] }],
    [{ kinds: [0] }, { kinds: [4, 7] }],
    [{ kinds: [445] }],
    [{ kinds: [9735], limit: 500 }],
    [{ kinds: [7] }],
    [{ authors: ['a'] }],
  ];
  for (const filters of cases)
    expect(isInboxSubscription(filters)).toBe(reqPriority(filters) === 0);
});

it('reports per-lane queue wait and inbox EOSE→handler latency once per window', async () => {
  const { relay, open } = pacedRelay();
  open('group', [445]);
  open('dm', [1059]);
  relay._onmessage(message(['EVENT', 'group', event(445, 'g')]));
  relay._onmessage(message(['EVENT', 'dm', event(1059, 'd')]));
  relay._onmessage(message(['EOSE', 'dm']));
  await jest.advanceTimersByTimeAsync(10);
  // Not before the window closes (never a line per event)…
  expect(takeReceiveWindow(Date.now())).toBeUndefined();
  const line = takeReceiveWindow(Date.now() + RECEIVE_PERF_WINDOW_MS);
  expect(line).toMatch(/^\[Perf\] relay receive window=\d+ms wait inbox n=2 p50=\d+ms max=\d+ms/);
  expect(line).toContain('normal n=1');
  expect(line).toMatch(/inbox EOSE→handler n=1 p50=\d+ms max=\d+ms · hydration gate=0ms$/);
  // …and the window resets once reported.
  expect(takeReceiveWindow(Date.now() + 2 * RECEIVE_PERF_WINDOW_MS)).toBeUndefined();
  relay.close();
});

it('attributes a cold-start hydration gate: inbox waits it out, later normal frames do not', async () => {
  // The device shape behind `inbox p50≈1s · normal p50≈0.2s`: the live inbox
  // backfill arrived while the first drain awaited verify-cache hydration, so
  // every lane waited; normal traffic only arrived after it had finished.
  jest
    .mocked(hydrateVerifiedEventCache)
    .mockImplementationOnce(() => new Promise<void>((resolve) => setTimeout(resolve, 1000)));
  const { relay, order, open } = pacedRelay();
  open('group', [445]);
  open('dm', [1059]);
  for (let i = 0; i < 10; i++) relay._onmessage(message(['EVENT', 'dm', event(1059, `${i}`)]));
  relay._onmessage(message(['EOSE', 'dm']));
  await jest.advanceTimersByTimeAsync(900);
  expect(order).toEqual([]); // nothing runs, in any lane, until hydration
  await jest.advanceTimersByTimeAsync(200);
  expect(order.at(-1)).toBe('dm:EOSE');
  relay._onmessage(message(['EVENT', 'group', event(445, 'late')]));
  await jest.advanceTimersByTimeAsync(10);
  expect(order.at(-1)).toBe('group:late');
  const line = takeReceiveWindow(Date.now() + RECEIVE_PERF_WINDOW_MS)!;
  const inboxP50 = Number(/wait inbox n=11 p50=(\d+)ms/.exec(line)?.[1]);
  const normalMax = Number(/normal n=1 p50=\d+ms max=(\d+)ms/.exec(line)?.[1]);
  const gate = Number(/hydration gate=(\d+)ms$/.exec(line)?.[1]);
  expect(gate).toBeGreaterThanOrEqual(1000);
  expect(inboxP50).toBeGreaterThanOrEqual(1000);
  expect(normalMax).toBeLessThanOrEqual(100);
  relay.close();
});
