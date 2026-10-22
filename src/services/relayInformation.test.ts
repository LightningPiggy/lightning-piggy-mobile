import {
  __resetRelayInformationForTests,
  fetchRelayInformation,
  parseRelayInformation,
  RELAY_INFORMATION_TTL_MS,
} from './relayInformation';

jest.mock('./relayHealth', () => ({
  relayKey: (url: string) => url.toLowerCase().replace(/\/+$/, ''),
}));
const originalFetch = global.fetch;
const mockFetch = jest.fn();
beforeEach(() => {
  __resetRelayInformationForTests();
  jest.useFakeTimers();
  global.fetch = mockFetch;
  mockFetch.mockReset();
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ name: 'Example', limitation: { payment_required: false } }),
  });
});
afterEach(() => {
  global.fetch = originalFetch;
  jest.useRealTimers();
});

it('parses optional NIP-11 fields and ignores malformed values', () => {
  expect(
    parseRelayInformation({
      name: 'Relay',
      icon: 'javascript:bad',
      contact: 4,
      supported_nips: [1, 11, 11, -1, '42', 1.5],
      limitation: {
        payment_required: false,
        auth_required: 'yes',
        max_subscriptions: 0,
        max_message_length: -1,
        restricted_writes: true,
      },
    }),
  ).toEqual({
    name: 'Relay',
    supported_nips: [1, 11],
    limitation: { payment_required: false, max_subscriptions: 0, restricted_writes: true },
  });
  expect(parseRelayInformation({ icon: 'https://example.com/icon.png', version: '1' })).toEqual({
    icon: 'https://example.com/icon.png',
    version: '1',
    limitation: {},
  });
  expect(() => parseRelayInformation([])).toThrow();
  expect(() => parseRelayInformation(null)).toThrow();
});

it('shares concurrent requests and caches normalised URLs until expiry', async () => {
  const first = fetchRelayInformation('wss://EXAMPLE.com/');
  expect(fetchRelayInformation('wss://example.com')).toBe(first);
  await expect(first).resolves.toMatchObject({ name: 'Example' });
  expect(mockFetch).toHaveBeenCalledWith(
    'https://example.com/',
    expect.objectContaining({
      headers: { Accept: 'application/nostr+json' },
      signal: expect.anything(),
    }),
  );
  await fetchRelayInformation('wss://example.com');
  expect(mockFetch).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(RELAY_INFORMATION_TTL_MS + 1);
  await fetchRelayInformation('wss://example.com');
  expect(mockFetch).toHaveBeenCalledTimes(2);
});

it('caches failures briefly, then retries without claiming information exists', async () => {
  mockFetch.mockRejectedValue(new Error('offline'));
  await expect(fetchRelayInformation('wss://example.com')).resolves.toBeNull();
  await fetchRelayInformation('wss://example.com');
  expect(mockFetch).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(60_001);
  mockFetch.mockResolvedValue({ ok: true, json: async () => ({}) });
  await expect(fetchRelayInformation('wss://example.com')).resolves.toEqual({ limitation: {} });
  expect(mockFetch).toHaveBeenCalledTimes(2);
});

it('handles non-OK responses and malformed JSON', async () => {
  mockFetch.mockResolvedValueOnce({ ok: false });
  await expect(fetchRelayInformation('wss://example.com')).resolves.toBeNull();
  mockFetch.mockResolvedValueOnce({ ok: true, json: async () => [] });
  await expect(fetchRelayInformation('ws://other.example')).resolves.toBeNull();
});

it('aborts the HTTP request after five seconds', async () => {
  mockFetch.mockImplementation(
    (_url, options) =>
      new Promise((_resolve, reject) =>
        options.signal.addEventListener('abort', () => reject(new Error('aborted'))),
      ),
  );
  const request = fetchRelayInformation('wss://example.com');
  jest.advanceTimersByTime(5000);
  await expect(request).resolves.toBeNull();
});

it('parses real Damus and a family-relay NIP-11 fixture without confusing self and operator', () => {
  const damus = parseRelayInformation(require('./__fixtures__/relay-information/damus.json'));
  const family = parseRelayInformation(
    require('./__fixtures__/relay-information/family-relay.json'),
  );
  expect(damus).toMatchObject({ name: 'damus.io', contact: 'jb55@jb55.com' });
  expect(family).toMatchObject({
    name: 'Family Relay',
    pubkey: '3bf0c63fcb93463407af97a5e5ee64fa883d107ef9e558472c4eb9aaaefa459d',
  });
  const selfOnly = parseRelayInformation({ self: 'b'.repeat(64) });
  expect(selfOnly.self).toBe('b'.repeat(64));
  expect(selfOnly.pubkey).toBeUndefined();
});
it('parses optional policies, paid fees, countries, languages and accepted kinds', () => {
  const info = parseRelayInformation({
    pubkey: 'A'.repeat(64),
    self: 'b'.repeat(64),
    terms_of_service: 'https://example.com/terms',
    privacy_policy: 'https://example.com/privacy',
    posting_policy: 'https://example.com/posting',
    payments_url: 'https://example.com/pay',
    relay_countries: ['GB', 'SV', 'GB', 'bad', 2],
    language_tags: ['en-GB', 'es', 'es', {}, 'bad_tag'],
    limitation: { allowed_kinds: [0, 3, 10002, 10002, -1, '10050', 1.5] },
    fees: {
      subscription: [
        { amount: 5000, unit: 'msats', period: 3600, kinds: [1, '3'] },
        { amount: -1, unit: 'msats' },
        null,
      ],
    },
  });
  expect(info.pubkey).toBe('a'.repeat(64));
  expect(info.self).toBe('b'.repeat(64));
  expect(info.relay_countries).toEqual(['GB', 'SV']);
  expect(info.language_tags).toEqual(['en-GB', 'es']);
  expect(info.limitation.allowed_kinds).toEqual([0, 3, 10002]);
  expect(info.fees).toEqual({
    subscription: [{ amount: 5000, unit: 'msats', period: 3600, kinds: [1] }],
  });
  expect(info.terms_of_service).toBe('https://example.com/terms');
  expect(info.privacy_policy).toBe('https://example.com/privacy');
  expect(info.posting_policy).toBe('https://example.com/posting');
  expect(info.payments_url).toBe('https://example.com/pay');
});
it('tolerates missing and malformed optional fields', () => {
  expect(parseRelayInformation({})).toEqual({ limitation: {} });
  expect(
    parseRelayInformation({
      pubkey: 'npub1bad',
      self: 1,
      terms_of_service: 'javascript:alert(1)',
      privacy_policy: {},
      posting_policy: [],
      payments_url: 'file:///etc/passwd',
      relay_countries: {},
      language_tags: null,
      fees: 'free',
      limitation: { allowed_kinds: ['bad'] },
    }),
  ).toEqual({ limitation: {} });
  expect(
    parseRelayInformation({
      fees: { admission: [null, {}, { amount: Infinity, unit: 'msats' }, { amount: 2, unit: 4 }] },
    }).fees,
  ).toEqual({ admission: [] });
});
