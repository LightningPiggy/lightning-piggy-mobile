import { AbstractRelay, type AbstractRelayConstructorOptions } from 'nostr-tools/abstract-relay';
import { AbstractSimplePool } from 'nostr-tools/abstract-pool';
import { guardPool, guardRelay } from './relaySocketGuard';
import { withResumableSubscriptions } from './resumablePool';

/**
 * Mirrors React Native's WebSocket: close() while CONNECTING only flips
 * readyState (the native socket isn't registered yet), and a late native
 * open still sets OPEN and dispatches `open`.
 */
class FakeSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeSocket[] = [];
  readyState = 0;
  /** The underlying connection was really torn down. */
  closedNatively = false;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: unknown) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: unknown) => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  close() {
    if (this.readyState >= 2) return;
    const wasOpen = this.readyState === 1;
    this.readyState = 2;
    if (wasOpen) {
      this.closedNatively = true;
      this.readyState = 3;
      this.onclose?.({});
    }
  }
  /** The native handshake completes. */
  open() {
    this.readyState = 1;
    this.onopen?.({});
  }
  send() {}
}

function relay(): AbstractRelay {
  return guardRelay(unguardedRelay());
}
function unguardedRelay(): AbstractRelay {
  return new AbstractRelay('wss://relay.example.com', {
    verifyEvent: (() => true) as unknown as AbstractRelayConstructorOptions['verifyEvent'],
    websocketImplementation: FakeSocket as unknown as typeof WebSocket,
  });
}
const latest = () => FakeSocket.instances[FakeSocket.instances.length - 1];
const flush = () => new Promise((resolve) => jest.requireActual('timers').setImmediate(resolve));

beforeEach(() => {
  jest.useFakeTimers();
  FakeSocket.instances = [];
});
afterEach(() => jest.useRealTimers());

it('closes a socket that opens after its connect timed out', async () => {
  const r = relay();
  const connecting = r.connect({ timeout: 5000 });
  const ws = latest();
  jest.advanceTimersByTime(5000);
  await expect(connecting).rejects.toBe('connection timed out');
  await flush();
  ws.open();
  expect(ws.closedNatively).toBe(true);
  expect(r.connected).toBe(false);
});

it('closes a socket that opens after its connect was aborted', async () => {
  const r = relay();
  const abort = new AbortController();
  const connecting = r.connect({ abort: abort.signal });
  const ws = latest();
  abort.abort();
  await expect(connecting).rejects.toBeDefined();
  await flush();
  ws.open();
  expect(ws.closedNatively).toBe(true);
});

it('leaves a connect that succeeds in time alone', async () => {
  const r = relay();
  const connecting = r.connect({ timeout: 5000 });
  latest().open();
  await expect(connecting).resolves.toBeUndefined();
  jest.advanceTimersByTime(10_000);
  expect(r.connected).toBe(true);
  expect(latest().closedNatively).toBe(false);
});

it("keeps a retired socket's late events away from the relay's newer connection", async () => {
  const r = relay();
  const first = r.connect({ timeout: 5000 });
  const old = latest();
  jest.advanceTimersByTime(5000);
  await expect(first).rejects.toBe('connection timed out');
  await flush();
  const second = r.connect({ timeout: 5000 });
  latest().open();
  await second;
  old.onclose?.({});
  old.onerror?.({});
  expect(r.connected).toBe(true);
});

it('closes a socket that opens after the relay was closed mid-connect', async () => {
  const r = relay();
  const connecting = r.connect();
  const ws = latest();
  r.close();
  ws.open();
  // The pending connect settles as before rather than hanging...
  await expect(connecting).resolves.toBeUndefined();
  // ...and the socket is then closed instead of staying open untracked.
  expect(ws.closedNatively).toBe(true);
  expect(r.connected).toBe(false);
});

it('lets an aborted relay connect again once its abandoned socket closes', async () => {
  const r = relay();
  const abort = new AbortController();
  const first = r.connect({ abort: abort.signal });
  const old = latest();
  abort.abort();
  await expect(first).rejects.toBeDefined();
  await flush();
  // nostr-tools keeps the rejected attempt cached until the socket closes.
  old.open();
  expect(old.closedNatively).toBe(true);
  const second = r.connect({ timeout: 5000 });
  expect(latest()).not.toBe(old);
  latest().open();
  await expect(second).resolves.toBeUndefined();
  expect(r.connected).toBe(true);
});

it('does not guard a relay nobody asked it to', async () => {
  const r = unguardedRelay();
  const connecting = r.connect({ timeout: 5000 });
  const ws = latest();
  jest.advanceTimersByTime(5000);
  await expect(connecting).rejects.toBe('connection timed out');
  ws.open();
  // The upstream leak this module exists for.
  expect(ws.closedNatively).toBe(false);
});

describe('guardPool', () => {
  function pool() {
    return guardPool(
      new AbstractSimplePool({
        verifyEvent: (() => true) as unknown as AbstractRelayConstructorOptions['verifyEvent'],
        websocketImplementation: FakeSocket as unknown as typeof WebSocket,
        maxWaitForConnection: 3000,
      }),
    );
  }

  it('closes a late socket of a relay the pool created itself', async () => {
    const p = pool();
    const connecting = p.ensureRelay('wss://relay.example.com', { connectionTimeout: 5000 });
    const ws = latest();
    jest.advanceTimersByTime(5000);
    await expect(connecting).rejects.toBe('connection timed out');
    await flush();
    ws.open();
    expect(ws.closedNatively).toBe(true);
  });

  it('keeps guarding after destroy() swaps in a new relay map', async () => {
    const p = pool();
    p.destroy();
    const connecting = p.ensureRelay('wss://relay.example.com', { connectionTimeout: 5000 });
    const ws = latest();
    jest.advanceTimersByTime(5000);
    await expect(connecting).rejects.toBe('connection timed out');
    await flush();
    ws.open();
    expect(ws.closedNatively).toBe(true);
  });
});

it("closes a late socket when the relay's own close() already flipped it to CLOSING", () => {
  // The Alby SDK's bundled nostr-tools closes the socket unconditionally.
  class EagerCloseRelay extends AbstractRelay {
    close() {
      super.close();
      (this as unknown as { ws?: FakeSocket }).ws?.close();
    }
  }
  const r = guardRelay(
    new EagerCloseRelay('wss://relay.example.com', {
      verifyEvent: (() => true) as unknown as AbstractRelayConstructorOptions['verifyEvent'],
      websocketImplementation: FakeSocket as unknown as typeof WebSocket,
    }),
  );
  void r.connect();
  const ws = latest();
  r.close();
  expect(ws.readyState).toBe(2);
  ws.open();
  expect(ws.closedNatively).toBe(true);
});

it("gives a per-attempt view of a pool its own relay map without replacing the pool's", () => {
  const relays = new Map<string, AbstractRelay>([['wss://a.example.com/', relay()]]);
  const p = guardPool({ relays });
  const attempt = Object.create(p) as typeof p;
  expect(attempt.relays).toBe(relays);
  attempt.relays = new Map();
  const b = unguardedRelay();
  attempt.relays.set('wss://b.example.com/', b);
  expect(p.relays).toBe(relays);
  expect(p.relays.size).toBe(1);
  // Relays created through the attempt's map are guarded too.
  void b.connect({ timeout: 5000 });
  const ws = latest();
  jest.advanceTimersByTime(5000);
  return flush().then(() => {
    ws.open();
    expect(ws.closedNatively).toBe(true);
  });
});

it('keeps every relay of the resumable pool tracked, so destroy() closes them all', async () => {
  const Pool = withResumableSubscriptions(AbstractSimplePool);
  const p = guardPool(
    new Pool({
      verifyEvent: (() => true) as unknown as AbstractRelayConstructorOptions['verifyEvent'],
      websocketImplementation: FakeSocket as unknown as typeof WebSocket,
      maxWaitForConnection: 3000,
    }),
  );
  const a = p.ensureRelay('wss://a.example.com', { connectionTimeout: 5000 });
  latest().open();
  await a;
  const b = p.ensureRelay('wss://b.example.com', { connectionTimeout: 5000 });
  latest().open();
  await b;
  expect((p as unknown as { relays: Map<string, unknown> }).relays.size).toBe(2);
  p.destroy();
  expect(FakeSocket.instances.every((ws) => ws.closedNatively)).toBe(true);
});

describe("a late old socket never evicts the SDK pool's replacement relay", () => {
  const url = 'wss://relay.example.com/';
  function sdkPool() {
    return guardPool(
      new AbstractSimplePool({
        verifyEvent: (() => true) as unknown as AbstractRelayConstructorOptions['verifyEvent'],
        websocketImplementation: FakeSocket as unknown as typeof WebSocket,
        maxWaitForConnection: 3000,
      }),
    );
  }
  const relaysOf = (p: object) => (p as unknown as { relays: Map<string, AbstractRelay> }).relays;

  it.each(['close', 'abort'])('after %s mid-connect', async (how) => {
    const p = sdkPool();
    const abort = new AbortController();
    const first = p.ensureRelay(url, { abort: abort.signal });
    first.catch(() => {});
    const old = latest();
    if (how === 'close') p.close([url]);
    else {
      abort.abort();
      await expect(first).rejects.toBeDefined();
    }
    await flush();
    const second = p.ensureRelay(url, { connectionTimeout: 5000 });
    const replacementSocket = latest();
    replacementSocket.open();
    const replacement = await second;
    old.open();
    await flush();
    expect(old.closedNatively).toBe(true);
    expect(relaysOf(p).get(url)).toBe(replacement);
    p.destroy();
    expect(replacementSocket.closedNatively).toBe(true);
  });
});
