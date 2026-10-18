import { fetchMarketMerchantProfiles } from './marketMerchantProfiles';
import { querySyncAbortable } from './relayQuery';
import * as cache from './zapSenderProfileStorage';
import { PROFILE_RELAYS } from './nostrRelayDefaults';
import type { Event } from 'nostr-tools';
jest.mock('./nostrPool', () => ({ pool: {}, trackRelays: jest.fn() }));
jest.mock('./relayQuery', () => ({ querySyncAbortable: jest.fn() }));
jest.mock('./zapSenderProfileStorage', () => ({ getMany: jest.fn(), setMany: jest.fn() }));
const query = querySyncAbortable as jest.Mock;
const cached = cache.getMany as jest.Mock;
const save = cache.setMany as jest.Mock;
const key = (i: number) => i.toString(16).padStart(64, '0');
const event = (pubkey: string, created_at: number, name: string) =>
  ({
    pubkey,
    created_at,
    kind: 0,
    content: JSON.stringify({ name, lud16: 'unverified@example.com' }),
  }) as Event;
beforeEach(() => {
  jest.clearAllMocks();
  cached.mockResolvedValue(new Map());
  query.mockResolvedValue([]);
  save.mockResolvedValue(undefined);
});
it('queries every cache miss in bounded chunks using the profile relays', async () => {
  const authors = Array.from({ length: 216 }, (_, i) => key(i));
  const signal = new AbortController().signal;
  await fetchMarketMerchantProfiles(authors, signal);
  expect(query).toHaveBeenCalledTimes(5);
  const requested: string[] = [];
  for (const [, relays, filter, options] of query.mock.calls) {
    expect(relays).toEqual(PROFILE_RELAYS);
    expect(filter.kinds).toEqual([0]);
    expect(filter.authors.length).toBeLessThanOrEqual(50);
    expect(filter.limit).toBeLessThanOrEqual(100);
    expect(options).toEqual({
      signal,
      maxWait: 8000,
      rejectOnAllRelaysFailure: true,
      rejectOnTimeout: true,
    });
    requested.push(...filter.authors);
  }
  expect(requested).toEqual(authors);
});
it('reuses cache, chooses newest metadata and ignores unsolicited profiles', async () => {
  cached.mockResolvedValue(new Map([[key(0), { name: 'Cached' }]]));
  query.mockResolvedValue([
    event(key(1), 20, 'Newest'),
    event(key(1), 10, 'Old'),
    event(key(2), 30, 'Unsolicited'),
  ]);
  const profiles = await fetchMarketMerchantProfiles(
    [key(0), key(1)],
    new AbortController().signal,
  );
  expect(query.mock.calls[0][2].authors).toEqual([key(1)]);
  expect(profiles.get(key(0))?.name).toBe('Cached');
  expect(profiles.get(key(1))?.name).toBe('Newest');
  expect(profiles.has(key(2))).toBe(false);
  expect(profiles.get(key(1))).not.toHaveProperty('lud16');
  expect(save).toHaveBeenCalledTimes(1);
});
it('cancels without persisting partial results', async () => {
  const controller = new AbortController();
  controller.abort();
  await fetchMarketMerchantProfiles([key(1)], controller.signal);
  expect(query).not.toHaveBeenCalled();
  expect(save).not.toHaveBeenCalled();
});

it.each([{}, 42, true, ['Seller'], null])(
  'discards malformed display metadata (%j) before returning or caching it',
  async (value) => {
    query.mockResolvedValue([
      {
        ...event(key(1), 20, 'Seller'),
        content: JSON.stringify({ name: value, display_name: value, nip05: value }),
      },
    ]);
    const profiles = await fetchMarketMerchantProfiles([key(1)], new AbortController().signal);
    const expected = { name: null, displayName: null, nip05: null };
    expect(profiles.get(key(1))).toMatchObject(expected);
    expect(save.mock.calls[0][0].get(key(1))).toMatchObject(expected);
    // The shared-cache consumer uses this name for the avatar's initial tile.
    const profile = profiles.get(key(1));
    const name = profile?.displayName ?? profile?.name ?? 'Seller';
    expect(name.charAt(0).toUpperCase()).toBe('S');
  },
);

it('preserves valid display metadata alongside malformed fields', async () => {
  query.mockResolvedValue([
    {
      ...event(key(1), 20, 'Seller'),
      content: JSON.stringify({ name: {}, display_name: 'Shop', nip05: 'shop@example.com' }),
    },
    {
      ...event(key(2), 20, 'Seller'),
      content: JSON.stringify({ name: 'Seller', display_name: 42, nip05: false }),
    },
  ]);
  const profiles = await fetchMarketMerchantProfiles(
    [key(1), key(2)],
    new AbortController().signal,
  );
  expect(profiles.get(key(1))).toMatchObject({
    name: null,
    displayName: 'Shop',
    nip05: 'shop@example.com',
  });
  expect(profiles.get(key(2))).toMatchObject({
    name: 'Seller',
    displayName: null,
    nip05: null,
  });
  expect(save.mock.calls[0][0]).toEqual(profiles);
});

it('reports failed chunks as unresolved while preserving cached and successful profiles', async () => {
  const authors = Array.from({ length: 52 }, (_, i) => key(i));
  cached.mockResolvedValue(new Map([[key(0), { name: 'Cached' }]]));
  query.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([]);
  const unresolved = jest.fn();
  const profiles = await fetchMarketMerchantProfiles(
    authors,
    new AbortController().signal,
    unresolved,
  );
  expect(profiles.get(key(0))?.name).toBe('Cached');
  expect(unresolved).toHaveBeenCalledWith(new Set(authors.slice(1, 51)));
  expect(profiles.has(key(51))).toBe(false);
});
