import {
  AUTHOR_FEED_EOSE_WAIT_MS,
  fetchAuthorFeedPage,
  subscribeAuthorFeed,
} from './authorFeedService';
const mockQuery = jest.fn();
const mockStatus = jest.fn();

const mockSubscribeMany = jest.fn();
jest.mock('./nostrPool', () => ({
  pool: {
    listConnectionStatus: () => mockStatus(),
    subscribeMany: (...args: unknown[]) => mockSubscribeMany(...args),
  },
  trackRelays: jest.fn(),
}));
// Relays whose URL says "parked" count as parked by the health breaker (#1326).
jest.mock('./relayHealth', () => ({
  selectHealthyRelays: (urls: string[]) => urls.filter((u) => !u.includes('parked')),
}));
jest.mock('./relayQuery', () => ({
  querySyncAbortable: (...args: unknown[]) => mockQuery(...args),
}));

const PK = 'a'.repeat(64);
const ev = (id: string, created_at: number, pubkey = PK) => ({
  id,
  pubkey,
  kind: 1,
  created_at,
  content: '',
  tags: [],
  sig: 's',
});

beforeEach(() => {
  mockQuery.mockReset();
  mockStatus.mockReset();
});

it('sends a bounded until filter and keeps only this author, newest first', async () => {
  mockQuery.mockResolvedValue([ev('old', 1), ev('new', 2), ev('other', 3, 'b'.repeat(64))]);
  mockStatus.mockReturnValue(new Map([['wss://a.example/', true]]));
  const page = await fetchAuthorFeedPage({
    authorPubkey: PK,
    relays: ['wss://a.example'],
    until: 100,
  });
  const [, , filter, opts] = mockQuery.mock.calls[0];
  expect(filter).toMatchObject({ authors: [PK], until: 100, limit: 30 });
  // Notes, NIP-22 comments (#1337) and picture / video events in one filter.
  expect([...filter.kinds].sort((a: number, b: number) => a - b)).toEqual([1, 20, 21, 22, 1111]);
  expect(opts).toMatchObject({ rejectOnAllRelaysFailure: true });
  expect(page.events.map((e) => e.id)).toEqual(['new', 'old']);
  expect(page.complete).toBe(true);
});

it('is not complete when one relay failed, even if the others answered fast', async () => {
  mockQuery.mockResolvedValue([]);
  mockStatus.mockReturnValue(
    new Map([
      ['wss://a.example/', true],
      ['wss://b.example/', false],
    ]),
  );
  const page = await fetchAuthorFeedPage({
    authorPubkey: PK,
    relays: ['wss://a.example', 'wss://b.example'],
    until: 100,
  });
  expect(page.complete).toBe(false);
});

it('is not complete when aborted', async () => {
  const controller = new AbortController();
  controller.abort();
  mockQuery.mockResolvedValue([]);
  mockStatus.mockReturnValue(new Map([['wss://a.example', true]]));
  const page = await fetchAuthorFeedPage({
    authorPubkey: PK,
    relays: ['wss://a.example'],
    until: 100,
    signal: controller.signal,
  });
  expect(page.complete).toBe(false);
});

describe('subscribeAuthorFeed', () => {
  type Handlers = { onevent: (e: unknown) => void; oneose: () => void; onclose: () => void };
  const open = () => {
    const close = jest.fn();
    mockSubscribeMany.mockReturnValueOnce({ close });
    const calls = { onEvent: jest.fn(), onEose: jest.fn(), onUnavailable: jest.fn() };
    const unsubscribe = subscribeAuthorFeed({
      authorPubkey: PK,
      relays: ['wss://a.example'],
      ...calls,
    });
    const handlers = mockSubscribeMany.mock.calls.at(-1)![2] as Handlers;
    return { ...calls, handlers, unsubscribe };
  };

  it('reports unavailable when every relay closes before anything arrives', () => {
    const s = open();
    s.handlers.oneose(); // the pool also signals EOSE for failed relays
    s.handlers.onclose();
    expect(s.onUnavailable).toHaveBeenCalledTimes(1);
  });

  it('a relay that answered "nothing" and disconnected later is not unavailable', async () => {
    const s = open();
    s.handlers.oneose(); // real EOSE: no posts
    await Promise.resolve(); // a later tick
    s.handlers.onclose(); // the socket drops afterwards
    expect(s.onEose).toHaveBeenCalledTimes(1);
    expect(s.onUnavailable).not.toHaveBeenCalled();
  });

  it('waits for real EOSE rather than the SDK default timeout', () => {
    open();
    const params = mockSubscribeMany.mock.calls.at(-1)![2] as { maxWait?: number };
    expect(params.maxWait).toBe(AUTHOR_FEED_EOSE_WAIT_MS);
  });

  it('is not unavailable once an event arrived, or when we closed it ourselves', () => {
    const got = open();
    got.handlers.onevent(ev('x', 1));
    got.handlers.onclose();
    expect(got.onUnavailable).not.toHaveBeenCalled();
    const ours = open();
    ours.unsubscribe();
    ours.handlers.onclose();
    expect(ours.onUnavailable).not.toHaveBeenCalled();
  });

  it('reports a real answer from one relay while another stays silent', async () => {
    const closes = [jest.fn(), jest.fn()];
    closes.forEach((close) => mockSubscribeMany.mockReturnValueOnce({ close }));
    const calls = {
      onEvent: jest.fn(),
      onEose: jest.fn(),
      onAnswered: jest.fn(),
      onUnavailable: jest.fn(),
    };
    const unsubscribe = subscribeAuthorFeed({
      authorPubkey: PK,
      relays: ['wss://a.example', 'wss://b.example'],
      ...calls,
    });
    // One subscription per relay, each for that relay only.
    const [a, b] = mockSubscribeMany.mock.calls.slice(-2) as [string[], unknown, Handlers][];
    expect([a[0], b[0]]).toEqual([['wss://a.example'], ['wss://b.example']]);
    a[2].oneose(); // relay A: really answered, no posts
    await Promise.resolve();
    expect(calls.onAnswered).toHaveBeenCalledTimes(1);
    expect(calls.onEose).not.toHaveBeenCalled(); // relay B is still silent
    b[2].oneose();
    expect(calls.onEose).toHaveBeenCalledTimes(1);
    unsubscribe();
    closes.forEach((close) => expect(close).toHaveBeenCalled());
  });

  it('a relay that failed (EOSE and close together) is not an answer', async () => {
    mockSubscribeMany.mockReturnValueOnce({ close: jest.fn() });
    mockSubscribeMany.mockReturnValueOnce({ close: jest.fn() });
    const calls = { onEvent: jest.fn(), onAnswered: jest.fn(), onUnavailable: jest.fn() };
    subscribeAuthorFeed({
      authorPubkey: PK,
      relays: ['wss://a.example', 'wss://b.example'],
      ...calls,
    });
    const [a, b] = mockSubscribeMany.mock.calls.slice(-2) as [string[], unknown, Handlers][];
    a[2].oneose();
    a[2].onclose();
    await Promise.resolve();
    expect(calls.onAnswered).not.toHaveBeenCalled();
    expect(calls.onUnavailable).not.toHaveBeenCalled(); // relay B may still answer
    b[2].oneose();
    b[2].onclose();
    await Promise.resolve();
    expect(calls.onUnavailable).toHaveBeenCalledTimes(1);
  });

  it("a silent relay's SDK timeout EOSE is not an answer; a real empty EOSE is", async () => {
    const now = jest.spyOn(performance, 'now').mockReturnValue(0);
    try {
      mockSubscribeMany.mockReturnValueOnce({ close: jest.fn() });
      mockSubscribeMany.mockReturnValueOnce({ close: jest.fn() });
      const calls = { onEvent: jest.fn(), onEose: jest.fn(), onAnswered: jest.fn() };
      subscribeAuthorFeed({
        authorPubkey: PK,
        relays: ['wss://a.example', 'wss://b.example'],
        ...calls,
      });
      const [a, b] = mockSubscribeMany.mock.calls.slice(-2) as [string[], unknown, Handlers][];
      // Relay A stays connected and silent until the SDK fakes its EOSE.
      now.mockReturnValue(AUTHOR_FEED_EOSE_WAIT_MS);
      a[2].oneose();
      await Promise.resolve();
      expect(calls.onAnswered).not.toHaveBeenCalled();
      // A real EOSE (well before the timeout) still counts.
      now.mockReturnValue(AUTHOR_FEED_EOSE_WAIT_MS - 1);
      b[2].oneose();
      await Promise.resolve();
      expect(calls.onAnswered).toHaveBeenCalledTimes(1);
      expect(calls.onEose).toHaveBeenCalledTimes(1);
    } finally {
      now.mockRestore();
    }
  });

  it('skips parked relays and opens one subscription per distinct relay', () => {
    mockSubscribeMany.mockReturnValue({ close: jest.fn() });
    const before = mockSubscribeMany.mock.calls.length;
    subscribeAuthorFeed({
      authorPubkey: PK,
      relays: ['wss://a.example', 'wss://a.example/', 'wss://parked.example', 'wss://b.example'],
      onEvent: jest.fn(),
    });
    const relays = mockSubscribeMany.mock.calls.slice(before).map((c) => c[0]);
    expect(relays).toEqual([['wss://a.example'], ['wss://b.example']]);
    mockSubscribeMany.mockReset();
  });
});
