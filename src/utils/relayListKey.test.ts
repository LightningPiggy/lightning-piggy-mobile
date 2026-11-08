import {
  normalizeRelayUrl,
  relayConfigListKey,
  relayConfigSequenceKey,
  relayListKey,
  sameRelayConfigs,
  sameRelayUrls,
} from './relayListKey';

describe('normalizeRelayUrl', () => {
  it('normalises like the relay pool (case, trailing slash, scheme, default port)', () => {
    expect(normalizeRelayUrl('wss://Relay.Example/')).toBe('wss://relay.example/');
    expect(normalizeRelayUrl('wss://relay.example')).toBe('wss://relay.example/');
    expect(normalizeRelayUrl('relay.example')).toBe('wss://relay.example/');
    expect(normalizeRelayUrl('wss://relay.example:443')).toBe('wss://relay.example/');
  });

  it('falls back to the trimmed text for an unparsable URL instead of throwing', () => {
    expect(normalizeRelayUrl('  wss://bad host  ')).toBe('wss://bad host');
  });
});

describe('relayListKey', () => {
  it('is the same for the same relays in any order, case or trailing slash, with duplicates', () => {
    const a = relayListKey(['wss://a.example', 'wss://b.example/']);
    expect(relayListKey(['wss://B.example', 'wss://a.example/', 'wss://a.example'])).toBe(a);
  });

  it('changes when a relay is added, removed or swapped', () => {
    const base = relayListKey(['wss://a.example', 'wss://b.example']);
    expect(relayListKey(['wss://a.example'])).not.toBe(base);
    expect(relayListKey(['wss://a.example', 'wss://b.example', 'wss://c.example'])).not.toBe(base);
    expect(relayListKey(['wss://a.example', 'wss://c.example'])).not.toBe(base);
  });

  it('keeps the empty list distinct from any relay', () => {
    expect(relayListKey([])).toBe('');
    expect(relayListKey(['wss://a.example'])).not.toBe('');
  });
});

describe('relayConfigListKey', () => {
  it('ignores order and URL spelling', () => {
    expect(
      relayConfigListKey([
        { url: 'wss://b.example/', read: true, write: false },
        { url: 'wss://a.example', read: true, write: true },
      ]),
    ).toBe(
      relayConfigListKey([
        { url: 'wss://a.example/', read: true, write: true },
        { url: 'wss://B.example', read: true, write: false },
      ]),
    );
  });

  it('changes when a read or write flag flips', () => {
    const rw = relayConfigListKey([{ url: 'wss://a.example', read: true, write: true }]);
    expect(relayConfigListKey([{ url: 'wss://a.example', read: true, write: false }])).not.toBe(rw);
    expect(relayConfigListKey([{ url: 'wss://a.example', read: false, write: true }])).not.toBe(rw);
  });
});

describe('ordered equality', () => {
  const a = { url: 'wss://a.example', read: true, write: true };
  const b = { url: 'wss://b.example', read: true, write: false };

  it('sameRelayConfigs matches equal entries in the same order only', () => {
    expect(sameRelayConfigs([a, b], [{ ...a }, { ...b }])).toBe(true);
    expect(sameRelayConfigs([a, b], [b, a])).toBe(false);
    expect(sameRelayConfigs([a], [{ ...a, write: false }])).toBe(false);
    expect(sameRelayConfigs([a], [a, b])).toBe(false);
  });

  it('relayConfigSequenceKey agrees with sameRelayConfigs', () => {
    expect(relayConfigSequenceKey([a, b])).toBe(relayConfigSequenceKey([{ ...a }, { ...b }]));
    expect(relayConfigSequenceKey([a, b])).not.toBe(relayConfigSequenceKey([b, a]));
  });

  it('sameRelayUrls matches equal URLs in the same order only', () => {
    expect(sameRelayUrls(['wss://a', 'wss://b'], ['wss://a', 'wss://b'])).toBe(true);
    expect(sameRelayUrls(['wss://a', 'wss://b'], ['wss://b', 'wss://a'])).toBe(false);
    expect(sameRelayUrls([], [])).toBe(true);
  });
});
