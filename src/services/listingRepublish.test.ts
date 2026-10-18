import { loadAppRelayPrefs } from './appRelayPrefs';
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools';
import {
  listingTargetRelays,
  validListingCopies,
  fetchListingCoverage,
  newestSignedListing,
  republishListing,
} from './listingRepublish';
import { acquireMarketListingsPool } from './marketListingsPool';
import { querySyncAbortable } from './relayQuery';
import { TEST_ACCOUNT_PUBKEYS, TEST_RELAY_URL } from '../config/testRelayLockdown';
import * as lockdown from '../config/testRelayLockdown';
import { MARKET_RELAYS } from '../utils/marketListingsQuery';
jest.mock('./marketListingsPool', () => ({ acquireMarketListingsPool: jest.fn() }));
jest.mock('./relayQuery', () => ({ querySyncAbortable: jest.fn() }));
const key = new Uint8Array(32).fill(9);
const me = getPublicKey(key);
const sign = (created_at: number, d = 'item') =>
  finalizeEvent({ kind: 30402, tags: [['d', d]], content: '', created_at }, key);
const publish = jest.fn();
const release = jest.fn();
const signal = () => new AbortController().signal;
beforeEach(async () => {
  await loadAppRelayPrefs(me);
  jest.clearAllMocks();
  (acquireMarketListingsPool as jest.Mock).mockReturnValue({ pool: { publish }, release });
});
test('targets include every write relay and Market relay, deduplicated; lockdown is LAN only', () => {
  expect(
    listingTargetRelays(me, [
      { url: 'wss://write.example/', write: true },
      { url: MARKET_RELAYS[0], write: true },
      { url: 'wss://read.example', write: false },
    ]),
  ).toEqual(['wss://write.example', ...MARKET_RELAYS]);
  expect(
    listingTargetRelays([...TEST_ACCOUNT_PUBKEYS][0], [
      { url: 'wss://public.example', write: true },
    ]),
  ).toEqual([TEST_RELAY_URL]);
});
test('forged copies, other authors and kinds never become publish candidates, even with cached verification symbols', async () => {
  const valid = sign(10);
  const forged = { ...valid, content: 'forged' };
  expect(
    await validListingCopies(
      [forged, { ...valid, kind: 1 }, { ...valid, pubkey: 'other' }, valid],
      me,
    ),
  ).toEqual([valid]);
});
test('relay targets normalize hosts while preserving case-sensitive paths and query values', () => {
  expect(
    listingTargetRelays(me, [
      { url: ' WSS://Relay.Example/PrivateShop?token=AbCd ', write: true },
      { url: 'wss://relay.example/PrivateShop?token=AbCd', write: true },
      { url: 'wss://relay.example/privateShop?token=AbCd', write: true },
      { url: 'wss://relay.example/PrivateShop?token=abcd', write: true },
      { url: 'wss://relay.example/PrivateShop/', write: true },
      { url: 'wss://relay.example?token=AbCd/', write: true },
      { url: 'not a relay', write: true },
    ]),
  ).toEqual([
    'wss://relay.example/PrivateShop?token=AbCd',
    'wss://relay.example/privateShop?token=AbCd',
    'wss://relay.example/PrivateShop?token=abcd',
    'wss://relay.example/PrivateShop/',
    'wss://relay.example?token=AbCd/',
    ...MARKET_RELAYS,
  ]);
});
test('one bounded batched request per relay, newest valid local or remote copy', async () => {
  const local = sign(10);
  const newer = sign(20);
  (querySyncAbortable as jest.Mock)
    .mockResolvedValueOnce([newer])
    .mockRejectedValueOnce(new Error('offline'));
  const snapshot = await fetchListingCoverage(
    me,
    ['wss://a', 'wss://b'],
    [local, sign(10, 'second')],
    signal(),
  );
  expect(querySyncAbortable).toHaveBeenCalledTimes(2);
  expect((querySyncAbortable as jest.Mock).mock.calls[0][2]).toEqual({
    authors: [me],
    kinds: [30402],
    '#d': ['item', 'second'],
    limit: 10,
  });
  expect(newestSignedListing(snapshot, 'item')).toEqual(newer);
  expect(snapshot.relays.get('wss://b')).toEqual([]);
  expect(release).toHaveBeenCalledTimes(1);
});
test('rebroadcasts existing newest signature only to missing relays and preserves rejection reasons', async () => {
  const old = sign(10);
  const latest = sign(20);
  publish.mockImplementation(([url]: string[]) => [
    url === 'wss://rejected'
      ? Promise.reject(new Error('blocked: kind 30402 is not allowed'))
      : Promise.resolve(''),
  ]);
  const results = await republishListing(
    me,
    'item',
    {
      copies: [old, latest],
      relays: new Map([
        ['wss://present', [latest]],
        ['wss://missing', [old]],
        ['wss://rejected', []],
      ]),
    },
    signal(),
  );
  expect(results).toEqual([
    { url: 'wss://present', status: 'alreadyPresent' },
    { url: 'wss://missing', status: 'accepted' },
    { url: 'wss://rejected', status: 'rejected', reason: 'blocked: kind 30402 is not allowed' },
  ]);
  expect(publish).toHaveBeenCalledTimes(2);
  expect(
    publish.mock.calls.every(
      ([, sent]: [string[], Event]) => sent.id === latest.id && sent.sig === latest.sig,
    ),
  ).toBe(true);
});
test('timeouts and abort report no response; no signed copy never publishes', async () => {
  publish.mockReturnValue([new Promise(() => {})]);
  const snapshot = { copies: [sign(10)], relays: new Map([['wss://silent', []]]) };
  expect(await republishListing(me, 'item', snapshot, signal(), 1)).toEqual([
    { url: 'wss://silent', status: 'noResponse' },
  ]);
  const controller = new AbortController();
  controller.abort();
  await expect(
    republishListing(me, 'item', { ...snapshot, copies: [] }, controller.signal),
  ).rejects.toThrow('No signed listing copy');
});
test.each([
  ['', 'accepted'],
  ['accepted: timeout policy allows this listing', 'accepted'],
  ['accepted: connection closed after receipt', 'accepted'],
  ['connection failure: relay connection timed out', 'noResponse'],
  [undefined, 'noResponse'],
])('classifies resolved publish response %p as %s', async (response, status) => {
  publish.mockReturnValue([Promise.resolve(response)]);
  expect(
    await republishListing(
      me,
      'item',
      { copies: [sign(10)], relays: new Map([['wss://relay', []]]) },
      signal(),
    ),
  ).toEqual([{ url: 'wss://relay', status }]);
});
test('lockdown query cannot reach public destinations', async () => {
  (querySyncAbortable as jest.Mock).mockResolvedValue([]);
  const locked = [...TEST_ACCOUNT_PUBKEYS][0];
  await fetchListingCoverage(locked, ['wss://public.example'], [sign(10)], signal());
  expect((querySyncAbortable as jest.Mock).mock.calls[0][1]).toEqual([TEST_RELAY_URL]);
});

test('signed writes are rerouted to LAN even if a snapshot contains public URLs', async () => {
  const route = jest.spyOn(lockdown, 'lockRelays').mockReturnValue([TEST_RELAY_URL]);
  publish.mockReturnValue([Promise.resolve('')]);
  try {
    const results = await republishListing(
      me,
      'item',
      { copies: [sign(10)], relays: new Map([['wss://public.example', []]]) },
      signal(),
    );
    expect(publish).toHaveBeenCalledWith([TEST_RELAY_URL], expect.objectContaining({ pubkey: me }));
    expect(results).toEqual([{ url: TEST_RELAY_URL, status: 'accepted' }]);
  } finally {
    route.mockRestore();
  }
});
test('transport rejections report no response and synchronous relay failures stay per-relay', async () => {
  publish.mockImplementation(([url]: string[]) => {
    if (url === 'wss://banned') throw new Error('banned: seller blocked');
    return [Promise.reject(new Error('publish timed out'))];
  });
  expect(
    await republishListing(
      me,
      'item',
      {
        copies: [sign(10)],
        relays: new Map([
          ['wss://banned', []],
          ['wss://timeout', []],
        ]),
      },
      signal(),
    ),
  ).toEqual([
    { url: 'wss://banned', status: 'rejected', reason: 'banned: seller blocked' },
    { url: 'wss://timeout', status: 'noResponse' },
  ]);
});

test('equal-time alternate revisions still receive the chosen signed event', async () => {
  const first = sign(10);
  const second = finalizeEvent(
    { kind: 30402, tags: [['d', 'item']], content: 'alternate', created_at: 10 },
    key,
  );
  const [winner, loser] = [first, second].sort((a, b) => a.id.localeCompare(b.id));
  publish.mockReturnValue([Promise.resolve('')]);
  expect(
    await republishListing(
      me,
      'item',
      { copies: [winner, loser], relays: new Map([['wss://alternate', [loser]]]) },
      signal(),
    ),
  ).toEqual([{ url: 'wss://alternate', status: 'accepted' }]);
  expect(publish).toHaveBeenCalledWith(
    ['wss://alternate'],
    expect.objectContaining({ id: winner.id }),
  );
});

test('different valid signatures for the same event id both count as held copies', async () => {
  const first = sign(10);
  const second = sign(10);
  expect(first.id).toBe(second.id);
  expect(first.sig).not.toBe(second.sig);
  (querySyncAbortable as jest.Mock).mockResolvedValueOnce([first]).mockResolvedValueOnce([second]);
  const snapshot = await fetchListingCoverage(me, ['wss://a', 'wss://b'], [first], signal());
  expect(snapshot.relays.get('wss://a')).toHaveLength(1);
  expect(snapshot.relays.get('wss://b')).toHaveLength(1);
});
