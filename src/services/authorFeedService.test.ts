import { fetchAuthorFeedPage, subscribeAuthorFeed } from './authorFeedService';
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
});
