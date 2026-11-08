// The inbox / conversation DM reads (#1759): one REQ per relay carrying every
// filter, finished by a quorum so a stuck relay can't hold the inbox.
import { SimplePool } from 'nostr-tools/pool';
import { AbstractRelay } from 'nostr-tools/abstract-relay';
import { withRelayHealth } from './healthAwarePool';
import { fetchDirectMessageEvents, fetchInboxDmEvents } from './nostrDmFetch';

jest.mock('./nostrPool', () => ({
  get pool() {
    return mockPool;
  },
  trackRelays: jest.fn(),
}));
jest.mock('./appRelayPrefs', () => ({ enabledAppRelays: () => [] }));
jest.mock('./nostrVerifyCache', () => ({
  hydrateVerifiedEventCache: jest.fn(async () => {}),
  flushVerifiedEventCache: jest.fn(async () => {}),
}));
jest.mock('./relayReqLimit', () => ({ discoverRelayReqLimit: async () => undefined }));
jest.mock('./relayHealth', () => ({
  RELAY_CONNECT_TIMEOUT_MS: 5000,
  noteNetworkActivity: jest.fn(),
  recordRelayFailure: jest.fn(),
  recordRelayConnectionObservation: jest.fn(),
  recordRelayPublish: jest.fn(),
  recordRelaySuccess: jest.fn(),
  selectHealthyRelays: (urls: string[]) => urls,
}));

class TestPool extends withRelayHealth(SimplePool) {}
let mockPool: TestPool;
const ME = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const URLS = ['wss://fast1.example/', 'wss://fast2.example/', 'wss://stuck.example/'];

let relays: Map<string, AbstractRelay>;
beforeEach(() => {
  jest.useFakeTimers();
  mockPool = new TestPool();
  relays = new Map(
    URLS.map((url) => {
      const relay = new AbstractRelay(url, { verifyEvent: (() => true) as never });
      jest.spyOn(relay, 'send').mockResolvedValue();
      return [url, relay];
    }),
  );
  jest
    .spyOn(mockPool, 'ensureRelay')
    .mockImplementation(async (url: string) => relays.get(url.replace(/\/?$/, '/'))!);
});
afterEach(() => {
  mockPool.destroy();
  jest.useRealTimers();
});

const subOf = (url: string) => {
  const subs = [...relays.get(url)!.openSubs.values()];
  expect(subs).toHaveLength(1);
  return subs[0];
};
const frame = (url: string, data: unknown[]) =>
  relays.get(url)!._onmessage({ data: JSON.stringify(data) } as MessageEvent);
const event = (id: string, kind: number, pubkey: string, p: string, created_at: number) => ({
  id: id.repeat(64).slice(0, 64),
  pubkey,
  sig: 'c'.repeat(128),
  kind,
  created_at,
  tags: [['p', p]],
  content: '',
});

test('inbox: one REQ per relay with three filters, no since on 1059, quorum beats a stuck relay', async () => {
  let done = false;
  const read = fetchInboxDmEvents(ME, URLS, { since: 10_000, limit: 50, quorum: true }).then(
    (r) => {
      done = true;
      return r;
    },
  );
  await jest.advanceTimersByTimeAsync(0);
  for (const url of URLS)
    expect(subOf(url).filters).toEqual([
      { kinds: [4], authors: [ME], limit: 50, since: 9_880 },
      { kinds: [4], '#p': [ME], limit: 50, since: 9_880 },
      // NIP-59 randomises wrap timestamps (#469): bounded by limit only.
      { kinds: [1059], '#p': [ME], limit: 50 },
    ]);
  const [fast1, fast2] = URLS;
  // A wrap whose randomised created_at is far older than the kind-4 cursor.
  frame(fast1, ['EVENT', subOf(fast1).id, event('1', 1059, PEER, ME, 100)]);
  frame(fast1, ['EOSE', subOf(fast1).id]);
  frame(fast2, ['EVENT', subOf(fast2).id, event('2', 4, PEER, ME, 10_500)]);
  frame(fast2, ['EVENT', subOf(fast2).id, event('3', 4, ME, PEER, 10_600)]);
  frame(fast2, ['EOSE', subOf(fast2).id]);
  await jest.advanceTimersByTimeAsync(1199);
  expect(done).toBe(false);
  await jest.advanceTimersByTimeAsync(1);
  const result = await read;
  expect(result.kind1059.map((e) => e.id[0])).toEqual(['1']);
  expect(result.kind4.map((e) => e.id[0]).sort()).toEqual(['2', '3']);
  // A relay was cut off: callers must not advance a kind-4 cursor from this.
  expect(result.complete).toBe(false);
  // The stuck relay's REQ is closed at the end of the grace, not at 8 s.
  expect(relays.get(URLS[2])!.openSubs.size).toBe(0);
});

test('inbox: abort resolves at once and closes every REQ', async () => {
  const controller = new AbortController();
  const read = fetchInboxDmEvents(ME, URLS, { signal: controller.signal, quorum: true });
  await jest.advanceTimersByTimeAsync(0);
  controller.abort();
  await expect(read).resolves.toEqual({ kind4: [], kind1059: [], complete: false });
  for (const relay of relays.values()) expect(relay.openSubs.size).toBe(0);
});

test('conversation: both kind-4 directions share one REQ per relay, and wait for every relay', async () => {
  let done = false;
  const read = fetchDirectMessageEvents(ME, PEER, URLS).then((r) => {
    done = true;
    return r;
  });
  await jest.advanceTimersByTimeAsync(0);
  for (const url of URLS)
    expect(subOf(url).filters).toEqual([
      { kinds: [4], authors: [ME], '#p': [PEER], limit: 200 },
      { kinds: [4], authors: [PEER], '#p': [ME], limit: 200 },
    ]);
  frame(URLS[0], ['EVENT', subOf(URLS[0]).id, event('4', 4, PEER, ME, 1)]);
  frame(URLS[0], ['EOSE', subOf(URLS[0]).id]);
  frame(URLS[1], ['EOSE', subOf(URLS[1]).id]);
  // A full read (#1759 review): no quorum cut — the slow relay's history
  // (e.g. a kind-4 we SENT from another device) is waited for.
  await jest.advanceTimersByTimeAsync(5000);
  expect(done).toBe(false);
  frame(URLS[2], ['EVENT', subOf(URLS[2]).id, event('7', 4, ME, PEER, 2)]);
  frame(URLS[2], ['EOSE', subOf(URLS[2]).id]);
  const { events, complete } = await read;
  expect(events.map((e) => e.id[0]).sort()).toEqual(['4', '7']);
  expect(complete).toBe(true);
});

test('inbox: complete when every relay answered or failed; known ids skipped before parse', async () => {
  const parse = jest.spyOn(JSON, 'parse');
  const known = event('5', 4, PEER, ME, 2);
  const read = fetchInboxDmEvents(ME, URLS, {
    isKnownEvent: (id) => id === known.id,
    quorum: true,
  });
  await jest.advanceTimersByTimeAsync(0);
  parse.mockClear();
  frame(URLS[0], ['EVENT', subOf(URLS[0]).id, known]);
  frame(URLS[0], ['EVENT', subOf(URLS[0]).id, event('6', 4, PEER, ME, 3)]);
  // Only the unknown event (and the EOSE / CLOSED control frames) got parsed.
  const parsedEvents = () =>
    parse.mock.results.filter((r) => Array.isArray(r.value) && r.value[0] === 'EVENT').length;
  expect(parsedEvents()).toBe(1);
  parse.mockRestore();
  frame(URLS[0], ['EOSE', subOf(URLS[0]).id]);
  frame(URLS[1], ['EOSE', subOf(URLS[1]).id]);
  // A relay that refuses the read is a failure, not a cut (pre-#1759 parity).
  frame(URLS[2], ['CLOSED', subOf(URLS[2]).id, 'restricted: no']);
  const result = await read;
  expect(result.kind4.map((e) => e.id[0])).toEqual(['6']);
  expect(result.complete).toBe(true);
});

test('inbox: a full read (pull-to-refresh / backfill) waits for the slow relay', async () => {
  let done = false;
  const read = fetchInboxDmEvents(ME, URLS).then((r) => {
    done = true;
    return r;
  });
  await jest.advanceTimersByTimeAsync(0);
  frame(URLS[0], ['EOSE', subOf(URLS[0]).id]);
  frame(URLS[1], ['EOSE', subOf(URLS[1]).id]);
  await jest.advanceTimersByTimeAsync(3000);
  expect(done).toBe(false);
  // The user's own relay answers late with a kind-4 sent from another device.
  frame(URLS[2], ['EVENT', subOf(URLS[2]).id, event('8', 4, ME, PEER, 5)]);
  frame(URLS[2], ['EOSE', subOf(URLS[2]).id]);
  const result = await read;
  expect(result.kind4.map((e) => e.id[0])).toEqual(['8']);
  expect(result.complete).toBe(true);
});
