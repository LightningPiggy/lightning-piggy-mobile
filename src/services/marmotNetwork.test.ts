// The strict push transport's server-inbox (kind 10050) lookup. The pool is
// mocked: these tests never touch a real relay.
import { forgetAppRelayPrefs, setAppRelayEnabled } from './appRelayPrefs';
import { DEFAULT_RELAYS } from './nostrRelayDefaults';
import type { Event } from 'nostr-tools';
import { AppState, type AppStateStatus } from 'react-native';
import { MarmotWelcomeOutbox } from './marmotWelcomeOutbox';
import { createMemoryMarmotBackend } from './marmotStore';
import { boundGroupQueries } from './marmotGroupBackfill';
import {
  cleanPushRelays,
  createMarmotNetwork,
  createPushTransport,
  MAX_PUSH_INBOX_RELAYS,
  MAX_PUSH_RELAYS,
} from './marmotNetwork';
import { pool, trackRelays } from './nostrPool';
import { createMarmotGroupConnections } from './marmotGroupConnections';
import { onMarmotRelayReconnect } from './marmotRelayReconnect';
import { MARMOT_PUSH_SERVER_RELAYS } from './nostrRelayDefaults';
import {
  TEST_ACCOUNT_PUBKEYS,
  TEST_PUSH_DISABLED,
  TEST_RELAY_URL,
} from '../config/testRelayLockdown';
import { setCurrentUserPubkey } from './nostrActiveAccount';

const mockQuerySync = jest.fn();
const mockPublish = jest.fn();
const mockSubscribeMany = jest.fn();
const mockSubscribeMap = jest.fn();
jest.mock('./nostrPool', () => ({
  pool: {
    querySync: (...args: unknown[]) => mockQuerySync(...args),
    querySyncFilters: (...args: unknown[]) => mockQuerySync(...args),
    publish: (...args: unknown[]) => mockPublish(...args),
    subscribeMany: (...args: unknown[]) => mockSubscribeMany(...args),
    subscribeMap: (...args: unknown[]) => mockSubscribeMap(...args),
    resetTransports: jest.fn().mockResolvedValue(undefined),
  },
  trackRelays: jest.fn(),
}));

const SERVER = 'ee'.repeat(32);
const inboxEvent = (relays: string[], createdAt = 100) => ({
  kind: 10050,
  created_at: createdAt,
  tags: relays.map((r) => ['relay', r]),
});

beforeEach(() => {
  setCurrentUserPubkey(null);
  mockQuerySync.mockReset();
  jest.useRealTimers();
});

afterEach(() => setCurrentUserPubkey(null));

describe('push lockdown', () => {
  const testPubkey = [...TEST_ACCOUNT_PUBKEYS][0];
  const wrap = { kind: 1059, pubkey: 'e'.repeat(64) } as Event;
  beforeEach(() => {
    mockQuerySync.mockResolvedValue([]);
    mockPublish.mockReset().mockReturnValue([]);
    jest.mocked(trackRelays).mockClear();
  });

  it('skips inbox lookup and anonymous publications for the active locked test account', async () => {
    const transport = createPushTransport(() => []);
    setCurrentUserPubkey(testPubkey);
    expect(await transport.inboxRelays(SERVER)).toEqual([]);
    expect(await transport.publish(['wss://relay.primal.net'], wrap)).toBe(TEST_PUSH_DISABLED);
    expect(mockQuerySync).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(trackRelays).not.toHaveBeenCalled();
  });

  it('retains the initiating test account after signing switches the active account', async () => {
    setCurrentUserPubkey(testPubkey);
    const transport = createPushTransport(() => [], testPubkey);
    await Promise.resolve().then(() => setCurrentUserPubkey('a'.repeat(64)));
    expect(await transport.inboxRelays(SERVER)).toEqual([]);
    expect(await transport.publish(['wss://relay.primal.net'], wrap)).toBe(TEST_PUSH_DISABLED);
    expect(mockQuerySync).not.toHaveBeenCalled();
    expect(mockPublish).not.toHaveBeenCalled();
    expect(trackRelays).not.toHaveBeenCalled();
  });

  it('keeps ordinary-account publications unchanged', async () => {
    setCurrentUserPubkey('a'.repeat(64));
    await createPushTransport(() => []).publish(['wss://relay.primal.net'], wrap);
    expect(mockPublish).toHaveBeenCalledWith(['wss://relay.primal.net'], wrap);
  });
});

describe('createPushTransport().inboxRelays', () => {
  it("queries our push servers' relays first, bounded, and returns the newest 10050", async () => {
    mockQuerySync.mockResolvedValue([
      inboxEvent(['wss://old.example'], 50),
      inboxEvent(['wss://relay.ditto.pub', 'wss://relay.eu.whitenoise.chat'], 100),
    ]);
    const transport = createPushTransport(() => ['wss://user-read.example']);
    expect(await transport.inboxRelays(SERVER)).toEqual([
      'wss://relay.ditto.pub',
      'wss://relay.eu.whitenoise.chat',
    ]);
    const [relays, filter, opts] = mockQuerySync.mock.calls[0];
    expect(relays.slice(0, MARMOT_PUSH_SERVER_RELAYS.length)).toEqual(MARMOT_PUSH_SERVER_RELAYS);
    expect(relays).toEqual(
      expect.arrayContaining([
        'wss://relay.ditto.pub',
        'wss://relay.eu.whitenoise.chat',
        'wss://user-read.example',
      ]),
    );
    expect(filter).toEqual({ kinds: [10050], authors: [SERVER], limit: 1 });
    expect(opts.maxWait).toBeGreaterThan(0);
    // Tracked, so sign-out closes the lookup's sockets too.
    expect(trackRelays).toHaveBeenCalledWith(relays);
  });

  it('caches a found list, and shares one lookup between concurrent triggers', async () => {
    mockQuerySync.mockResolvedValue([inboxEvent(['wss://relay.ditto.pub'])]);
    const transport = createPushTransport(() => []);
    const [a, b] = await Promise.all([
      transport.inboxRelays(SERVER),
      transport.inboxRelays(SERVER),
    ]);
    expect(a).toEqual(['wss://relay.ditto.pub']);
    expect(b).toEqual(a);
    expect(await transport.inboxRelays(SERVER)).toEqual(a);
    expect(mockQuerySync).toHaveBeenCalledTimes(1);
  });

  it('re-asks after a miss only once the short miss window has passed', async () => {
    jest.useFakeTimers({ now: 1_000_000 });
    mockQuerySync.mockResolvedValueOnce([]);
    const transport = createPushTransport(() => []);
    expect(await transport.inboxRelays(SERVER)).toEqual([]);
    expect(await transport.inboxRelays(SERVER)).toEqual([]);
    expect(mockQuerySync).toHaveBeenCalledTimes(1);
    jest.setSystemTime(1_000_000 + 61_000);
    mockQuerySync.mockResolvedValueOnce([inboxEvent(['wss://relay.coinos.io'])]);
    expect(await transport.inboxRelays(SERVER)).toEqual(['wss://relay.coinos.io']);
    expect(mockQuerySync).toHaveBeenCalledTimes(2);
  });

  it('a failed lookup is not cached', async () => {
    mockQuerySync.mockRejectedValueOnce(new Error('offline'));
    const transport = createPushTransport(() => []);
    await expect(transport.inboxRelays(SERVER)).rejects.toThrow('offline');
    mockQuerySync.mockResolvedValueOnce([inboxEvent(['wss://relay.primal.net'])]);
    expect(await transport.inboxRelays(SERVER)).toEqual(['wss://relay.primal.net']);
  });
});

// #1338: push-trigger destinations come from other members' records and the
// push server's 10050 — connected to automatically, so only public wss://.
describe('push relay destination policy', () => {
  it('cleanPushRelays keeps public wss only, deduped and capped', () => {
    expect(
      cleanPushRelays([
        'wss://relay.ditto.pub',
        'ws://relay.ditto.pub',
        'ws://192.168.1.1/',
        'wss://10.0.0.1',
        'wss://127.1',
        'wss://user:pw@relay.example.com',
        'wss://printer.local',
        42,
        'wss://relay.ditto.pub',
        'wss://relay.primal.net',
      ]),
    ).toEqual(['wss://relay.ditto.pub', 'wss://relay.primal.net']);
    const many = Array.from({ length: MAX_PUSH_RELAYS + 4 }, (_, i) => `wss://r${i}.example.com`);
    expect(cleanPushRelays(many)).toHaveLength(MAX_PUSH_RELAYS);
  });

  it("drops private / plaintext relays from a push server's 10050, capped", async () => {
    const listed = [
      'ws://192.168.1.1/',
      'ws://plain.example.com',
      'wss://[::1]',
      ...Array.from({ length: MAX_PUSH_INBOX_RELAYS + 2 }, (_, i) => `wss://in${i}.example.com`),
    ];
    mockQuerySync.mockResolvedValue([inboxEvent(listed)]);
    const relays = await createPushTransport(() => []).inboxRelays(SERVER);
    expect(relays).toHaveLength(MAX_PUSH_INBOX_RELAYS);
    expect(relays.every((r) => r.startsWith('wss://in'))).toBe(true);
  });

  it('never publishes a trigger to a private or plaintext relay', async () => {
    const publish = mockPublish;
    publish.mockReset();
    publish.mockReturnValue([]);
    const transport = createPushTransport(() => []);
    await transport.publish(['ws://192.168.1.1/', 'wss://127.0.0.1'], {} as never);
    expect(publish).not.toHaveBeenCalled();
    await transport.publish(['ws://192.168.1.1/', 'wss://relay.ditto.pub'], {} as never);
    expect(publish).toHaveBeenCalledWith(['wss://relay.ditto.pub'], {});
  });
});

describe('createMarmotNetwork().publish', () => {
  const relays = ['wss://a.example', 'wss://b.example'];
  const event: Event = {
    id: 'a'.repeat(64),
    pubkey: 'b'.repeat(64),
    sig: 'c'.repeat(128),
    created_at: 1,
    kind: 1059,
    tags: [['p', 'd'.repeat(64)]],
    content: '',
  };

  beforeEach(() => {
    jest.useFakeTimers();
    mockPublish.mockReset();
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('reports connection failures as refused alongside real acknowledgements', async () => {
    mockPublish.mockReturnValue([
      Promise.resolve('connection failure: offline'),
      Promise.resolve(''),
    ]);
    const result = await createMarmotNetwork(() => []).publish(relays, event);
    expect(result[relays[0]]).toMatchObject({
      ok: false,
      message: expect.stringContaining('offline'),
    });
    expect(result[relays[1]]).toEqual({ from: relays[1], ok: true, message: '' });
  });

  it('keeps unreachable invitations queued through retries until a relay acknowledges', async () => {
    mockPublish.mockImplementation(() =>
      relays.map(() => Promise.resolve('connection failure: offline')),
    );
    const outbox = new MarmotWelcomeOutbox(createMemoryMarmotBackend());
    const network = outbox.wrapNetwork(createMarmotNetwork(() => []));
    const { failed } = await outbox.capture(() => network.publish(relays, event));
    expect(failed).toHaveLength(1);
    expect(await outbox.resend(failed)).toEqual(failed);
    await outbox.enqueue('group', failed);
    await outbox.flush();
    expect(await outbox.pending()).toHaveLength(1);
    mockPublish.mockReturnValue([
      Promise.resolve('connection failure: offline'),
      Promise.resolve('saved'),
    ]);
    await outbox.flush();
    expect(await outbox.pending()).toHaveLength(0);
  });
});

// Simulate Doze silently losing sockets and individual relay failures on the
// per-relay (non-group) routes, e.g. a Welcome gift-wrap subscription.
describe('Marmot subscription lifecycle', () => {
  const inbox = { kinds: [1059], '#p': ['me'], limit: 200, since: 100 };
  let onState: (state: AppStateStatus) => void;
  let remove: jest.Mock;
  let close: jest.Mock;
  let stop: () => void;
  let next: jest.Mock;
  beforeEach(() => {
    jest.useFakeTimers();
    remove = jest.fn();
    close = jest.fn();
    mockSubscribeMany.mockReset().mockReturnValue({ close });
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_name, cb) => {
      onState = cb;
      return { remove };
    });
    next = jest.fn();
    const network = createMarmotNetwork(() => []);
    stop = network
      .subscription(['wss://one.example', 'wss://two.example'], inbox)
      .subscribe({ next }).unsubscribe;
  });
  afterEach(() => {
    stop();
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
  it('dedupes events across relay routes and suppresses stale deliveries', async () => {
    const event = { id: 'same-id' };
    const oldEvent = mockSubscribeMany.mock.calls[0][2].onevent;
    mockSubscribeMany.mock.calls[0][2].onevent(event);
    mockSubscribeMany.mock.calls[1][2].onevent(event);
    expect(next).toHaveBeenCalledTimes(1);
    onState('active');
    await jest.advanceTimersByTimeAsync(3_000);
    oldEvent({ id: 'stale' });
    expect(next).toHaveBeenCalledTimes(1);
  });
  it('reopens after silent background loss, staggered by three seconds', async () => {
    const before = mockSubscribeMany.mock.calls.length;
    onState('background');
    jest.advanceTimersByTime(5 * 60_000);
    onState('active');
    expect(mockSubscribeMany).toHaveBeenCalledTimes(before);
    await jest.advanceTimersByTimeAsync(3_000);
    expect(mockSubscribeMany.mock.calls.length).toBeGreaterThan(before);
    expect(close).toHaveBeenCalled();
    expect(mockSubscribeMany.mock.calls.at(-1)[1]).toEqual(inbox);
  });
  it('retries a failed relay even when another relay remains healthy', () => {
    const before = mockSubscribeMany.mock.calls.length;
    mockSubscribeMany.mock.calls[0][2].onclose(['connection closed']);
    jest.advanceTimersByTime(5_000);
    expect(mockSubscribeMany).toHaveBeenCalledTimes(before + 1);
    expect(mockSubscribeMany.mock.calls.at(-1)[0]).toEqual(['wss://one.example']);
  });
  it('hands relay retries to session reconnect, retaining backoff and recovery notifications across new routes', () => {
    stop();
    mockSubscribeMany.mockClear();
    let since = 100;
    const reconnect = jest.fn(() => {
      stop();
      since++;
      stop = arm();
    });
    const network = createMarmotNetwork(() => [], reconnect);
    const arm = () =>
      network.subscription(['wss://one.example'], { ...inbox, since }).subscribe({ next })
        .unsubscribe;
    stop = arm();
    const recovered = jest.fn();
    const removeListener = onMarmotRelayReconnect(recovered);
    try {
      mockSubscribeMany.mock.calls[0][2].oneose();
      expect(recovered).not.toHaveBeenCalled();
      mockSubscribeMany.mock.calls[0][2].onclose(['offline']);
      jest.advanceTimersByTime(5_000);
      expect(reconnect).toHaveBeenCalledTimes(1);
      const reopened = mockSubscribeMany.mock.calls[1][2];
      reopened.oneose();
      reopened.oneose();
      expect(recovered).toHaveBeenCalledTimes(1);
      reopened.onclose(['still offline']);
      jest.advanceTimersByTime(9_999);
      expect(reconnect).toHaveBeenCalledTimes(1);
      jest.advanceTimersByTime(1);
      expect(reconnect).toHaveBeenCalledTimes(2);
    } finally {
      removeListener();
    }
  });
  it('notifies recovery once on replay or EOSE, ignoring initial and stale routes', () => {
    const recovered = jest.fn();
    const removeListener = onMarmotRelayReconnect(recovered);
    try {
      const initial = mockSubscribeMany.mock.calls[0][2];
      initial.oneose();
      expect(recovered).not.toHaveBeenCalled();
      initial.onclose(['offline']);
      jest.advanceTimersByTime(5_000);
      initial.oneose();
      expect(recovered).not.toHaveBeenCalled();
      const reopened = mockSubscribeMany.mock.calls.at(-1)[2];
      reopened.onevent({ id: 'replay' });
      reopened.oneose();
      expect(recovered).toHaveBeenCalledTimes(1);
      reopened.onclose(['offline again']);
      jest.advanceTimersByTime(5_000);
      mockSubscribeMany.mock.calls.at(-1)[2].oneose();
      expect(recovered).toHaveBeenCalledTimes(2);
    } finally {
      removeListener();
    }
  });
  it('ignores old close callbacks and cancels resume/retry work on unsubscribe', async () => {
    const oldClose = mockSubscribeMany.mock.calls[0][2].onclose;
    onState('active');
    await jest.advanceTimersByTimeAsync(3_000);
    const before = mockSubscribeMany.mock.calls.length;
    oldClose(['stale close']);
    jest.advanceTimersByTime(5_000);
    expect(mockSubscribeMany).toHaveBeenCalledTimes(before);
    mockSubscribeMany.mock.calls.at(-1)[2].onclose(['drop']);
    onState('active');
    stop();
    jest.advanceTimersByTime(10 * 60_000);
    expect(mockSubscribeMany).toHaveBeenCalledTimes(before);
    expect(remove).toHaveBeenCalledTimes(1);
  });
  it('cancels queued resume work when backgrounded again', () => {
    const before = mockSubscribeMany.mock.calls.length;
    onState('active');
    onState('background');
    jest.advanceTimersByTime(10_000);
    expect(mockSubscribeMany).toHaveBeenCalledTimes(before);
  });
});

// Group kind-445 routing is merged into one REQ per relay (#1399); it has no
// per-route AppState handling, so the network itself must restore #1440's
// resume + reconnect behaviour and the relay-reconnect notification.
describe('merged group subscription lifecycle', () => {
  let onState: (state: AppStateStatus) => void;
  let remove: jest.Mock;
  const group = (h: string) => ({ kinds: [445], '#h': [h], limit: 500 });
  beforeEach(() => {
    jest.useFakeTimers();
    remove = jest.fn();
    mockQuerySync.mockResolvedValue([]);
    mockSubscribeMap.mockReset().mockImplementation(() => ({ close: jest.fn() }));
    jest.mocked(pool.resetTransports).mockClear();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_name, cb) => {
      onState = cb;
      return { remove };
    });
  });
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });
  it('replaces every group relay transport after the resume stagger, then reconnects the session once', async () => {
    const next = jest.fn();
    const reconnect = jest.fn(() => connections.reconnect());
    const network = createMarmotNetwork(() => [], reconnect);
    const connections = createMarmotGroupConnections(() => {
      const subs = ['one', 'two'].map((h) =>
        network.subscription([`wss://${h}.example`], group(h)).subscribe({ next }),
      );
      return { unsubscribe: () => subs.forEach((sub) => sub.unsubscribe()) };
    });
    connections.start();
    await jest.advanceTimersByTimeAsync(10);
    expect(mockSubscribeMap).toHaveBeenCalledTimes(2);
    onState('background');
    onState('active');
    await jest.advanceTimersByTimeAsync(2_999);
    expect(pool.resetTransports).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(1);
    expect(pool.resetTransports).toHaveBeenCalledTimes(1);
    expect(pool.resetTransports).toHaveBeenCalledWith(['wss://one.example', 'wss://two.example']);
    expect(reconnect).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(10);
    // The reconnected session armed fresh merged REQs on both relays.
    expect(mockSubscribeMap).toHaveBeenCalledTimes(4);
    connections.unsubscribe();
    expect(remove).toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(5_000);
    expect(jest.getTimerCount()).toBe(0);
  });
  it('a lost group socket re-arms, recovers each group, and notifies relay reconnect listeners', async () => {
    const recovered = jest.fn();
    const removeListener = onMarmotRelayReconnect(recovered);
    const network = createMarmotNetwork(() => []);
    const owner = network.subscription(['wss://one.example'], group('a')).subscribe({});
    try {
      await jest.advanceTimersByTimeAsync(10);
      expect(mockSubscribeMap).toHaveBeenCalledTimes(1);
      const first = mockSubscribeMap.mock.calls[0][1];
      first.onReqOpen();
      await jest.advanceTimersByTimeAsync(100);
      expect(mockQuerySync).toHaveBeenCalled();
      expect(recovered).not.toHaveBeenCalled();
      first.onclose(['connection closed']);
      await jest.advanceTimersByTimeAsync(1_010);
      expect(mockSubscribeMap).toHaveBeenCalledTimes(2);
      const requests = mockQuerySync.mock.calls.length;
      mockSubscribeMap.mock.calls[1][1].onReqOpen();
      await jest.advanceTimersByTimeAsync(100);
      expect(mockQuerySync.mock.calls.length).toBeGreaterThan(requests);
      expect(recovered).toHaveBeenCalledTimes(1);
    } finally {
      removeListener();
      owner.unsubscribe();
    }
    expect(remove).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(5_000);
    expect(jest.getTimerCount()).toBe(0);
  });
});

test('the app network merges connectAll group fan-out into one REQ on each usable relay', () => {
  jest.useFakeTimers();
  mockQuerySync.mockResolvedValue([]);
  mockSubscribeMap.mockReset().mockImplementation(() => ({ close: jest.fn() }));
  const network = createMarmotNetwork(() => []);
  const relays = ['wss://relay.primal.net', 'wss://relay.snort.social'];
  const owners = Array.from({ length: 20 }, (_, i) =>
    network
      .subscription(relays, {
        kinds: [445],
        '#h': [String(i)],
        limit: 500,
      })
      .subscribe({ next: jest.fn() }),
  );
  jest.runOnlyPendingTimers();
  expect(mockSubscribeMap).toHaveBeenCalledTimes(2);
  for (const [requests] of mockSubscribeMap.mock.calls) {
    expect(new Set(requests.map((r: { url: string }) => r.url)).size).toBe(1);
    expect(requests).toHaveLength(1);
    expect(requests[0].filter['#h']).toEqual(Array.from({ length: 20 }, (_, i) => String(i)));
    expect(requests[0].filter.limit).toBe(100);
  }
  owners.forEach((owner) => owner.unsubscribe());
  jest.clearAllTimers();
  jest.useRealTimers();
});

test('non-group filters open one reconnecting route per relay and filter', () => {
  mockSubscribeMany.mockReset().mockReturnValue({ close: jest.fn() });
  const network = createMarmotNetwork(() => []);
  const filters = [
    { kinds: [1059], '#p': ['me'], limit: 100 },
    { kinds: [4], '#p': ['me'], limit: 100, since: 10 },
  ];
  const sub = network.subscription(['wss://relay.primal.net'], filters).subscribe({});
  expect(mockSubscribeMany).toHaveBeenCalledTimes(2);
  expect(mockSubscribeMany.mock.calls.map(([relays, filter]) => [relays, filter])).toEqual(
    filters.map((filter) => [['wss://relay.primal.net'], filter]),
  );
  sub.unsubscribe();
});

test('Welcome ownership filters share one fresh REQ per relay', async () => {
  mockQuerySync.mockResolvedValue([]);
  const filters = [
    { kinds: [30443], ids: ['kp'], limit: 1 },
    { kinds: [30443], authors: ['me'], limit: 1 },
  ];
  const sessionNetwork = boundGroupQueries(
    createMarmotNetwork(() => []),
    { watermarks: new Map(), persist: jest.fn() },
  );
  await sessionNetwork.request(['wss://relay.primal.net'], filters);
  expect(mockQuerySync).toHaveBeenCalledTimes(1);
  expect(mockQuerySync).toHaveBeenCalledWith(['wss://relay.primal.net'], filters, 6000);
});

test('session-owned Welcome lookup and anonymous publications stay on LAN after an account switch', async () => {
  const owner = [...TEST_ACCOUNT_PUBKEYS][0];
  setCurrentUserPubkey(owner);
  const network = createMarmotNetwork(() => ['wss://public.example'], undefined, owner);
  let finishLookup!: (events: ReturnType<typeof inboxEvent>[]) => void;
  mockQuerySync.mockReset().mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finishLookup = resolve;
      }),
  );
  mockPublish.mockReset().mockReturnValue([Promise.resolve('saved')]);
  const pending = network.getUserInboxRelays(SERVER);
  expect(mockQuerySync.mock.calls[0][0]).toEqual([TEST_RELAY_URL]);
  setCurrentUserPubkey('a'.repeat(64));
  finishLookup([inboxEvent(['wss://public.example'])]);
  const inbox = await pending;
  expect(inbox).toEqual([TEST_RELAY_URL]);
  for (const kind of [1059, 445, 443, 30443, 10051]) {
    await network.publish(['wss://public.example'], { kind, pubkey: SERVER } as Event);
    expect(mockPublish.mock.calls.at(-1)[0]).toEqual([TEST_RELAY_URL]);
  }
  mockQuerySync.mockResolvedValue([]);
  await network.request(
    ['wss://public.example'],
    [
      { kinds: [10051], authors: [SERVER], limit: 1 },
      { kinds: [10002], authors: [SERVER], limit: 1 },
    ],
  );
  expect(mockQuerySync.mock.calls.at(-1)[0]).toEqual([TEST_RELAY_URL]);
});

test('session and push fallbacks retain owner preferences across an account switch', async () => {
  const owner = 'c'.repeat(64);
  await forgetAppRelayPrefs(owner);
  await setAppRelayEnabled(owner, 'default', DEFAULT_RELAYS[0], false);
  const network = createMarmotNetwork(() => [], undefined, owner);
  const push = createPushTransport(() => [], owner);
  setCurrentUserPubkey(null);
  mockQuerySync.mockResolvedValue([]);
  await network.getUserInboxRelays(SERVER);
  const networkTargets = mockQuerySync.mock.calls.at(-1)[0];
  expect(networkTargets).not.toContain(DEFAULT_RELAYS[0]);
  expect(networkTargets).toContain(DEFAULT_RELAYS[1]);
  await push.inboxRelays(SERVER);
  const pushTargets = mockQuerySync.mock.calls.at(-1)[0];
  expect(pushTargets).not.toContain(DEFAULT_RELAYS[0]);
  expect(pushTargets).toContain(DEFAULT_RELAYS[1]);
  await forgetAppRelayPrefs(owner);
});

it('invalidates cached fallback inbox targets after hydration and preference changes', async () => {
  const owner = 'a'.repeat(64);
  await forgetAppRelayPrefs(owner);
  setCurrentUserPubkey(owner);
  mockQuerySync.mockResolvedValue([]);
  const network = createMarmotNetwork(() => [], undefined, owner);
  expect(await network.getUserInboxRelays(SERVER)).toEqual([]);
  await setAppRelayEnabled(owner, 'default', DEFAULT_RELAYS[0], true);
  expect(await network.getUserInboxRelays(SERVER)).toContain(DEFAULT_RELAYS[0]);
  await setAppRelayEnabled(owner, 'default', DEFAULT_RELAYS[0], false);
  expect(await network.getUserInboxRelays(SERVER)).not.toContain(DEFAULT_RELAYS[0]);
  setCurrentUserPubkey(null);
  await forgetAppRelayPrefs(owner);
});
