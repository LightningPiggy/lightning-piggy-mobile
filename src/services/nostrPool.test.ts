import { AbstractRelay } from 'nostr-tools/abstract-relay';
import { SimplePool } from 'nostr-tools/pool';
import type { Event, VerifiedEvent } from 'nostr-tools';
import {
  claimPendingRelease,
  connectedRelays,
  pool,
  pooledRelayUrls,
  pruneIdleRelays,
  releaseNewIdleRelays,
  trackRelays,
} from './nostrPool';
import {
  __resetOutboxLeasesForTests,
  leasedOutboxRelayCount,
  leaseOutboxRelays,
} from './authorOutboxRelays';

jest.mock('./relayHealth', () => ({
  hydrateRelayHealth: jest.fn(),
  selectHealthyRelays: (urls: string[]) => urls,
  noteNetworkActivity: jest.fn(),
  recordRelayPublish: jest.fn(),
}));

const relays = (pool as unknown as { relays: Map<string, AbstractRelay> }).relays;
const created: AbstractRelay[] = [];
function addRelay(url: string): AbstractRelay {
  const relay = new AbstractRelay(url, { verifyEvent: (event): event is VerifiedEvent => !!event });
  created.push(relay);
  jest.spyOn(relay, 'send').mockResolvedValue();
  relays.set(url, relay);
  trackRelays([url]);
  return relay;
}
beforeEach(() => {
  relays.clear();
  connectedRelays.clear();
});
afterEach(() => {
  created.splice(0).forEach((relay) => relay.close());
  relays.clear();
});

it('removes normalized idle URLs while retaining active relay bookkeeping', () => {
  addRelay('wss://hint/');
  trackRelays(['wss://HINT:443/']);
  const active = addRelay('wss://active/');
  active.prepareSubscription([{ kinds: [1], limit: 1 }], {});
  active.idleSince = undefined;
  pruneIdleRelays();
  expect([...connectedRelays]).toEqual(['wss://active/']);
});

it('preserves an idle socket until a pending EVENT receives its acknowledgement', async () => {
  const relay = addRelay('wss://publish/');
  const publish = relay.publish({ id: 'event' } as Event);
  const outcome = publish.catch((error: Error) => error.message);
  expect(relay.idleSince).toBeDefined();
  pruneIdleRelays();
  expect(relays.has(relay.url)).toBe(true);
  expect(connectedRelays.has(relay.url)).toBe(true);
  relay._onmessage({ data: JSON.stringify(['OK', 'event', true, 'saved']) } as MessageEvent);
  await expect(outcome).resolves.toBe('saved');
  pruneIdleRelays();
  expect(relays.has(relay.url)).toBe(false);
});

it('preserves outstanding COUNT requests even when the relay is marked idle', async () => {
  const relay = addRelay('wss://count/');
  const outcome = relay.count([{ kinds: [1], limit: 1 }], { id: 'count' }).catch(() => -1);
  pruneIdleRelays();
  expect(relays.has(relay.url)).toBe(true);
  relay._onmessage({ data: JSON.stringify(['COUNT', 'count', { count: 3 }]) } as MessageEvent);
  await expect(outcome).resolves.toBe(3);
  pruneIdleRelays();
  expect(relays.has(relay.url)).toBe(false);
});

it.each([false, true])(
  'preserves overlapping pool publishes during AUTH signing and releases after settlement (reject: %s)',
  async (reject) => {
    const relay = addRelay('wss://auth/');
    const pending: { resolve: (message: string) => void; reject: (error: Error) => void }[] = [];
    const publish = jest
      .spyOn(SimplePool.prototype, 'publish')
      .mockImplementation((urls) =>
        urls.map(() => new Promise((resolve, reject) => pending.push({ resolve, reject }))),
      );
    try {
      const first = pool.publish(['wss://AUTH:443'], {} as Event)[0];
      const second = pool.publish(['wss://auth/'], {} as Event)[0];
      const outcomes = Promise.allSettled([first, second]);
      pruneIdleRelays();
      expect(relays.has(relay.url)).toBe(true);
      pending[0].resolve('saved');
      await first;
      pruneIdleRelays();
      expect(relays.has(relay.url)).toBe(true);
      if (reject) pending[1].reject(new Error('AUTH failed'));
      else pending[1].resolve('saved');
      await outcomes;
      pruneIdleRelays();
      expect(relays.has(relay.url)).toBe(false);
    } finally {
      pending.forEach(({ resolve }) => resolve('cleanup'));
      publish.mockRestore();
    }
  },
);

it('prunes only the listed relays when given URLs, keeping other idle sockets', () => {
  addRelay('wss://outbox/');
  addRelay('wss://other/');
  pruneIdleRelays(['wss://OUTBOX:443']);
  expect([...relays.keys()]).toEqual(['wss://other/']);
  expect([...connectedRelays]).toEqual(['wss://other/']);
  // An empty or unparsable list prunes nothing (never "everything").
  pruneIdleRelays([]);
  pruneIdleRelays(['::not a url::']);
  expect([...relays.keys()]).toEqual(['wss://other/']);
});

it('releases only the sockets a batch opened, never ones pooled before it', () => {
  addRelay('wss://already/');
  const before = pooledRelayUrls();
  addRelay('wss://one-off/');
  const busy = addRelay('wss://busy/');
  busy.prepareSubscription([{ kinds: [1], limit: 1 }], {});
  busy.idleSince = undefined;
  releaseNewIdleRelays(['wss://already', 'wss://one-off', 'wss://busy'], before);
  expect([...relays.keys()].sort()).toEqual(['wss://already/', 'wss://busy/']);
});

it('never prunes a socket that is still connecting', () => {
  const relay = addRelay('wss://connecting/');
  const state = relay as unknown as { connectionPromise?: Promise<void> };
  state.connectionPromise = new Promise(() => {});
  pruneIdleRelays();
  expect(relays.has(relay.url)).toBe(true);
  state.connectionPromise = undefined;
  pruneIdleRelays();
  expect(relays.has(relay.url)).toBe(false);
});

it("releases a one-off socket when another send's last publish to it settles", async () => {
  const relay = addRelay('wss://shared-outbox/');
  const pending: ((message: string) => void)[] = [];
  const publish = jest
    .spyOn(SimplePool.prototype, 'publish')
    .mockImplementation((urls) => urls.map(() => new Promise((resolve) => pending.push(resolve))));
  try {
    // Send A opened the socket; send B publishes to it too.
    const first = pool.publish(['wss://shared-outbox'], {} as Event)[0];
    const second = pool.publish(['wss://shared-outbox'], {} as Event)[0];
    pending[0]('saved');
    await first;
    // A finishes and releases what it opened, but B is still publishing.
    releaseNewIdleRelays(['wss://shared-outbox'], new Set());
    expect(relays.has(relay.url)).toBe(true);
    pending[1]('saved');
    await second;
    await new Promise((r) => setTimeout(r, 0));
    expect(relays.has(relay.url)).toBe(false);
  } finally {
    pending.forEach((resolve) => resolve('cleanup'));
    publish.mockRestore();
  }
});

it('leaves sockets never marked for release open after their publishes drain', async () => {
  const relay = addRelay('wss://long-lived/');
  const publish = jest
    .spyOn(SimplePool.prototype, 'publish')
    .mockImplementation((urls) => urls.map(() => Promise.resolve('saved')));
  try {
    await pool.publish(['wss://long-lived'], {} as Event)[0];
    await new Promise((r) => setTimeout(r, 0));
    expect(relays.has(relay.url)).toBe(true);
  } finally {
    publish.mockRestore();
  }
});

it('closes a socket marked for release once its last read ends, not only after a publish (#1390)', async () => {
  const relay = addRelay('wss://outbox-read/');
  const sub = relay.subscribe([{ kinds: [1], limit: 1 }], {});
  // Still reading: the release is deferred, not dropped.
  releaseNewIdleRelays(['wss://outbox-read'], new Set());
  expect(relays.has(relay.url)).toBe(true);
  sub.close();
  await new Promise((r) => setTimeout(r, 0));
  expect(relays.has(relay.url)).toBe(false);
});

it('a pending release claimed back is not closed when it next goes idle (M1)', async () => {
  const relay = addRelay('wss://reclaimed/');
  const sub = relay.subscribe([{ kinds: [1], limit: 1 }], {});
  releaseNewIdleRelays(['wss://reclaimed'], new Set());
  expect(claimPendingRelease('wss://reclaimed')).toBe(true);
  expect(claimPendingRelease('wss://reclaimed')).toBe(false);
  sub.close();
  await new Promise((r) => setTimeout(r, 0));
  expect(relays.has(relay.url)).toBe(true);
});

it('sockets never marked for release stay open when their reads end', async () => {
  const relay = addRelay('wss://own-relay/');
  relay.subscribe([{ kinds: [1], limit: 1 }], {}).close();
  await new Promise((r) => setTimeout(r, 0));
  expect(relays.has(relay.url)).toBe(true);
});

it('an outbox read cancelled mid-connect still closes the socket and frees the cap once it connects', async () => {
  __resetOutboxLeasesForTests();
  const lease = leaseOutboxRelays(['wss://slow-outbox/']);
  const relay = addRelay('wss://slow-outbox/');
  // Still connecting when the read is cancelled and the lease released.
  let connected!: () => void;
  const state = relay as unknown as { connectionPromise?: Promise<void>; _connected: boolean };
  state.connectionPromise = new Promise<void>((resolve) => (connected = resolve));
  lease.release();
  expect(relays.has(relay.url)).toBe(true);
  expect(leasedOutboxRelayCount()).toBe(1);
  // The connection succeeds (nostr-tools leaves `idleSince` alone here).
  state.connectionPromise = undefined;
  state._connected = true;
  connected();
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  expect(relays.has(relay.url)).toBe(false);
  expect(leasedOutboxRelayCount()).toBe(0);
});
