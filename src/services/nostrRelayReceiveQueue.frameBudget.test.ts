import { pool } from './nostrPool';
import { addRelayFrameBudget, clearRelayFrameBudget } from './nostrRelayReceiveQueue';
import type { VerifiedEvent } from 'nostr-tools/pure';

// The raw-frame budget for outbox-owned sockets (#1390): counted where the
// socket's message arrives, BEFORE any parsing, so an escaped "EVENT"
// (valid JSON for EVENT, which the SDK's raw `"EVENT"` scan misses) counts too.
jest.mock('./relayHealth', () => ({
  hydrateRelayHealth: jest.fn(),
  selectHealthyRelays: (urls: string[]) => urls,
  RELAY_CONNECT_TIMEOUT_MS: 5000,
  recordRelaySuccess: jest.fn(),
  recordRelayConnectionObservation: jest.fn(),
  noteNetworkActivity: jest.fn(),
}));
jest.mock('./nostrVerifyCache', () => ({
  hydrateVerifiedEventCache: jest.fn(async () => {}),
  flushVerifiedEventCache: jest.fn(async () => {}),
}));

class FakeSocket {
  static OPEN = 1;
  static sockets: FakeSocket[] = [];
  readyState = 1;
  onopen?: () => void;
  onmessage?: (message: MessageEvent) => void;
  send = jest.fn();
  close = jest.fn();
  constructor() {
    FakeSocket.sockets.push(this);
  }
}

const escapedEvent = (n: number) =>
  JSON.stringify([
    'EVENT',
    'feed',
    { kind: 1, id: n.toString(16).padStart(64, '0'), pubkey: 'b'.repeat(64), created_at: n },
  ]).replace('EVENT', '\\u0045VENT');

async function connect(url: string) {
  const index = FakeSocket.sockets.length;
  const connecting = pool.ensureRelay(url);
  FakeSocket.sockets[index].onopen!();
  const relay = await connecting;
  return { relay, socket: FakeSocket.sockets[index] };
}

let originalSocket: typeof WebSocket;
let originalVerifier: typeof pool.verifyEvent;
const verify = jest.fn((e: unknown): e is VerifiedEvent => !!e);
beforeEach(() => {
  jest.useFakeTimers();
  FakeSocket.sockets = [];
  verify.mockClear();
  originalSocket = global.WebSocket;
  originalVerifier = pool.verifyEvent;
  global.WebSocket = FakeSocket as unknown as typeof WebSocket;
  pool.verifyEvent = (event): event is VerifiedEvent => verify(event);
});
afterEach(() => {
  pool.close(['wss://outbox-flood/', 'wss://own-relay/']);
  clearRelayFrameBudget('wss://outbox-flood/');
  global.WebSocket = originalSocket;
  pool.verifyEvent = originalVerifier;
  jest.clearAllTimers();
  jest.useRealTimers();
});

it('an outbox-owned socket past its frame budget is closed before verifying the excess', async () => {
  const { relay, socket } = await connect('wss://outbox-flood/');
  const onExceeded = jest.fn();
  addRelayFrameBudget(relay.url, 5, onExceeded);
  relay.subscribe([{ kinds: [1] }], { id: 'feed', onevent: jest.fn() });
  for (let n = 1; n <= 200; n++) socket.onmessage!({ data: escapedEvent(n) } as MessageEvent);
  await jest.advanceTimersByTimeAsync(50);
  // Only the budgeted frames ever reached parse / verify.
  expect(verify.mock.calls.length).toBeLessThanOrEqual(5);
  expect(onExceeded).toHaveBeenCalledTimes(1);
  expect(socket.close).toHaveBeenCalled();
});

it("the viewer's own relays (no budget) are never counted", async () => {
  const { relay, socket } = await connect('wss://own-relay/');
  const onevent = jest.fn();
  relay.subscribe([{ kinds: [1] }], { id: 'feed', onevent });
  for (let n = 1; n <= 20; n++) socket.onmessage!({ data: escapedEvent(n) } as MessageEvent);
  await jest.advanceTimersByTimeAsync(50);
  expect(verify).toHaveBeenCalledTimes(20);
  expect(socket.close).not.toHaveBeenCalled();
});

it('another lease tops up the same budget', async () => {
  const { relay, socket } = await connect('wss://outbox-flood/');
  const onExceeded = jest.fn();
  addRelayFrameBudget(relay.url, 3, onExceeded);
  addRelayFrameBudget(relay.url, 3, onExceeded);
  relay.subscribe([{ kinds: [1] }], { id: 'feed', onevent: jest.fn() });
  for (let n = 1; n <= 6; n++) socket.onmessage!({ data: escapedEvent(n) } as MessageEvent);
  await jest.advanceTimersByTimeAsync(50);
  expect(onExceeded).not.toHaveBeenCalled();
  socket.onmessage!({ data: escapedEvent(7) } as MessageEvent);
  await jest.advanceTimersByTimeAsync(50);
  expect(onExceeded).toHaveBeenCalledTimes(1);
});

it('a blown budget dies with its socket: the next socket to that URL receives normally', async () => {
  const first = await connect('wss://outbox-flood/');
  const onExceeded = jest.fn();
  addRelayFrameBudget(first.relay.url, 5, onExceeded);
  first.relay.subscribe([{ kinds: [1] }], { id: 'feed', onevent: jest.fn() });
  for (let n = 1; n <= 50; n++) first.socket.onmessage!({ data: escapedEvent(n) } as MessageEvent);
  await jest.advanceTimersByTimeAsync(50);
  expect(onExceeded).toHaveBeenCalledTimes(1);
  expect(first.socket.close).toHaveBeenCalled();
  // Even before its leases are forgotten (the grant still stands), a fresh
  // socket to the same URL — e.g. a DM delivery or a read — receives: the
  // blown budget belonged to the closed socket, not to the URL.
  verify.mockClear();
  const second = await connect('wss://outbox-flood/');
  expect(second.relay).not.toBe(first.relay);
  second.relay.subscribe([{ kinds: [1] }], { id: 'feed', onevent: jest.fn() });
  for (let n = 1; n <= 5; n++) second.socket.onmessage!({ data: escapedEvent(n) } as MessageEvent);
  await jest.advanceTimersByTimeAsync(50);
  expect(verify).toHaveBeenCalledTimes(5);
  expect(second.socket.close).not.toHaveBeenCalled();
  // Once the leases are gone (forget clears the grant), nothing is counted at all.
  clearRelayFrameBudget('wss://outbox-flood/');
  for (let n = 6; n <= 30; n++) second.socket.onmessage!({ data: escapedEvent(n) } as MessageEvent);
  await jest.advanceTimersByTimeAsync(50);
  expect(verify).toHaveBeenCalledTimes(30);
  expect(second.socket.close).not.toHaveBeenCalled();
});

it("a closed socket's partial count never carries over to the next socket", async () => {
  const onExceeded = jest.fn();
  addRelayFrameBudget('wss://outbox-flood/', 5, onExceeded);
  const first = await connect('wss://outbox-flood/');
  first.relay.subscribe([{ kinds: [1] }], { id: 'feed', onevent: jest.fn() });
  // 4 of 5 used, then the socket closes for an unrelated reason.
  for (let n = 1; n <= 4; n++) first.socket.onmessage!({ data: escapedEvent(n) } as MessageEvent);
  await jest.advanceTimersByTimeAsync(50);
  first.relay.close();
  // The grant still stands (a lease is open): the new socket gets all 5 afresh.
  verify.mockClear();
  const second = await connect('wss://outbox-flood/');
  second.relay.subscribe([{ kinds: [1] }], { id: 'feed', onevent: jest.fn() });
  for (let n = 1; n <= 5; n++) second.socket.onmessage!({ data: escapedEvent(n) } as MessageEvent);
  await jest.advanceTimersByTimeAsync(50);
  expect(verify).toHaveBeenCalledTimes(5);
  expect(onExceeded).not.toHaveBeenCalled();
  second.socket.onmessage!({ data: escapedEvent(6) } as MessageEvent);
  await jest.advanceTimersByTimeAsync(50);
  expect(onExceeded).toHaveBeenCalledTimes(1);
});
