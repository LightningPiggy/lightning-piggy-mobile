import { finalizeEvent, getPublicKey, type Filter } from 'nostr-tools';
import { fetchFollowLists, followListRelays, FOLLOW_LIST_RELAYS } from './followListsFetcher';
import { verifyEventCached, __resetVerifiedEventCache } from './nostrVerifyCache';

jest.mock('./nostrVerifyCache', () => {
  const actual = jest.requireActual('./nostrVerifyCache');
  return { ...actual, verifyEventCached: jest.fn(actual.verifyEventCached) };
});

jest.mock('../contexts/nostrDecryptPacing', () => ({
  createYieldScheduler: () => ({
    maybeYield: () => Promise.resolve(),
    dispose: () => {},
    yieldCount: 0,
  }),
}));
jest.mock('./nostrPool', () => ({ pool: { ensureRelay: jest.fn() }, trackRelays: jest.fn() }));
jest.mock('./marketListingsPool', () => {
  const ensureRelay = jest.fn();
  const release = jest.fn();
  return {
    acquireMarketListingsPool: () => ({ pool: { ensureRelay }, release }),
    __mocks: { ensureRelay, release },
  };
});
jest.mock('./nostrCrypto', () => {
  const actual = jest.requireActual('./nostrCrypto');
  const pure = jest.requireActual('nostr-tools/pure');
  return { ...actual, nostrGetEventHash: pure.getEventHash, nostrVerifyEvent: pure.verifyEvent };
});
const { ensureRelay, release } = (
  jest.requireMock('./marketListingsPool') as {
    __mocks: { ensureRelay: jest.Mock; release: jest.Mock };
  }
).__mocks;

interface Sub {
  filters: Filter[];
  c: { onevent: (e: unknown) => void; oneose: () => void };
}
let subs: Sub[];
const flush = async () => {
  for (let i = 0; i < 50; i++) await Promise.resolve();
};
const keyOf = (n: number) => new Uint8Array(32).fill(n);
const friend = (n: number) => getPublicKey(keyOf(n));
const contacts = (n: number, createdAt: number, follows: string[]) =>
  finalizeEvent(
    { kind: 3, created_at: createdAt, content: '', tags: follows.map((p) => ['p', p]) },
    keyOf(n),
  );
const hex = (n: number) => n.toString(16).padStart(64, '0');

beforeEach(() => {
  subs = [];
  __resetVerifiedEventCache();
  release.mockClear();
  (verifyEventCached as jest.Mock).mockClear();
  ensureRelay.mockReset();
  ensureRelay.mockImplementation((url: string) =>
    url === 'wss://purplepag.es'
      ? Promise.resolve({
          subscribe: (filters: Filter[], c: Sub['c']) => {
            subs.push({ filters, c });
            return { close: jest.fn() };
          },
        })
      : Promise.reject(new Error('offline')),
  );
});

it('plans contact-list indexers first, then the user relays, capped', () => {
  const relays = followListRelays(['wss://relay.damus.io/', 'https://nope', ...FOLLOW_LIST_RELAYS]);
  expect(relays.slice(0, 3)).toEqual(FOLLOW_LIST_RELAYS);
  expect(relays).toContain('wss://relay.damus.io');
  expect(relays).not.toContain('https://nope');
});

it('returns each friend’s newest verified follow list, from one bounded kind-3 filter', async () => {
  const pending = fetchFollowLists([friend(1), friend(2), friend(3)], []);
  await flush();
  const [sub] = subs;
  expect(sub.filters).toEqual([
    { kinds: [3], authors: [friend(1), friend(2), friend(3)], limit: 3 },
  ]);
  sub.c.onevent(contacts(1, 100, [hex(10)]));
  sub.c.onevent(contacts(1, 200, [hex(11), hex(12), 'not-a-key']));
  // A forged newer revision is dropped rather than trusted.
  sub.c.onevent({ ...contacts(2, 300, [hex(99)]), sig: '0'.repeat(128) });
  // Unsolicited authors are ignored.
  sub.c.onevent(contacts(4, 100, [hex(42)]));
  sub.c.oneose();
  const lists = await pending;
  expect(lists).toEqual({ [friend(1)]: [hex(11), hex(12)] });
  expect(release).toHaveBeenCalled();
});

it('rejects when aborted, so a cut-short batch is never cached as complete', async () => {
  const controller = new AbortController();
  const pending = fetchFollowLists([friend(1)], [], controller.signal);
  await flush();
  subs[0].c.onevent(contacts(1, 100, [hex(10)]));
  controller.abort();
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
});

it.each([false, true])(
  'retains an older authenticated list after a forged newer revision, forged first: %s',
  async (forgedFirst) => {
    const pending = fetchFollowLists([friend(1)], []);
    await flush();
    const valid = contacts(1, 100, [hex(10)]);
    const forged = { ...contacts(1, 200, [hex(99)]), sig: '0'.repeat(128) };
    const events = forgedFirst ? [forged, valid] : [valid, forged];
    events.forEach((event) => subs[0].c.onevent(event));
    subs[0].c.oneose();
    expect(await pending).toEqual({ [friend(1)]: [hex(10)] });
    expect(verifyEventCached).toHaveBeenCalledTimes(2);
  },
);

it('uses the lowest authenticated id on timestamp ties and skips older revisions', async () => {
  const pending = fetchFollowLists([friend(1), friend(2)], []);
  await flush();
  const tied = [contacts(1, 200, [hex(10)]), contacts(1, 200, [hex(11)])].sort((a, b) =>
    a.id.localeCompare(b.id),
  );
  const forged = { ...tied[0], id: '0'.repeat(64), sig: '0'.repeat(128) };
  subs[0].c.onevent(tied[1]);
  subs[0].c.onevent(contacts(1, 100, [hex(12)]));
  subs[0].c.onevent(forged);
  subs[0].c.onevent(tied[0]);
  subs[0].c.oneose();
  expect(await pending).toEqual({ [friend(1)]: [tied[0].tags[0][1]] });
  expect(verifyEventCached).toHaveBeenCalledTimes(2);
});

it('rejects a candidate flood without verifying or caching a partial graph', async () => {
  const pending = fetchFollowLists([friend(1)], []);
  await flush();
  for (let i = 0; i < FOLLOW_LIST_RELAYS.length + 1; i++) {
    subs[0].c.onevent(contacts(1, i, [hex(10)]));
  }
  subs[0].c.oneose();
  await expect(pending).rejects.toThrow('Follow-list candidate budget exceeded');
  expect(verifyEventCached).not.toHaveBeenCalled();
  expect(release).toHaveBeenCalledTimes(1);
});

it('accepts an empty follow list only after a relay answers in full', async () => {
  const pending = fetchFollowLists([friend(1)], []);
  await flush();
  subs[0].c.oneose();
  await expect(pending).resolves.toEqual({});
});

it('rejects when every relay is offline and releases the pool', async () => {
  ensureRelay.mockRejectedValue(new Error('offline'));
  await expect(fetchFollowLists([friend(1)], [])).rejects.toThrow('No follow-list relay answered');
  expect(release).toHaveBeenCalledTimes(1);
});

it.each([false, true])(
  'rejects a timed-out batch even with partial events: %s',
  async (partial) => {
    jest.useFakeTimers();
    try {
      const pending = fetchFollowLists([friend(1)], []);
      const rejected = expect(pending).rejects.toThrow('No follow-list relay answered');
      await flush();
      if (partial) subs[0].c.onevent(contacts(1, 100, [hex(10)]));
      await jest.advanceTimersByTimeAsync(8000);
      await rejected;
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  },
);

it.each(['content', 'tag', 'total-tags', 'empty-values'])(
  'rejects oversized %s before retaining or verifying it',
  async (payload) => {
    const pending = fetchFollowLists([friend(1), friend(2)], []);
    await flush();
    const original = contacts(1, 100, [hex(10)]);
    const newer = {
      ...contacts(1, 200, [hex(99)]),
      ...(payload === 'content' ? { content: 'x'.repeat(2 * 1024 * 1024) } : {}),
      ...(payload === 'tag' ? { tags: [['p', hex(99), 'x'.repeat(512000)]] } : {}),
      ...(payload === 'total-tags'
        ? { tags: Array.from({ length: 100 }, () => ['x', 'x'.repeat(6000)]) }
        : {}),
      ...(payload === 'empty-values' ? { tags: [Array(200000).fill('')] } : {}),
    };
    subs[0].c.onevent(original);
    subs[0].c.onevent(newer);
    subs[0].c.onevent({ ...newer, pubkey: friend(2) });
    subs[0].c.oneose();
    expect(await pending).toEqual({ [friend(1)]: [hex(10)] });
    expect(verifyEventCached).toHaveBeenCalledTimes(1);
    expect(verifyEventCached).toHaveBeenCalledWith(original);
  },
);
