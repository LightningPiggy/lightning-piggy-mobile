import {
  MAX_PEER_RELAY_CANDIDATES,
  MAX_PEER_RELAY_URL_LENGTH,
  MAX_RELAYS_PER_PEER,
  sanitizePeerRelayUrls,
} from './peerRelayUrls';

describe('sanitizePeerRelayUrls', () => {
  it.each([
    ['plain ws', 'ws://relay.example.com'],
    ['http', 'https://relay.example.com'],
    ['no scheme', 'relay.example.com'],
    ['empty host', 'wss://'],
    ['localhost', 'wss://localhost'],
    ['localhost with trailing dot', 'wss://localhost.'],
    ['localhost subdomain', 'wss://relay.localhost'],
    ['mDNS', 'wss://printer.local'],
    ['LAN suffix', 'wss://nas.lan'],
    ['internal suffix', 'wss://relay.internal'],
    ['single-label host', 'wss://router'],
    ['loopback v4', 'wss://127.0.0.1'],
    ['loopback v4 with port', 'wss://127.0.0.1:7777'],
    ['shorthand loopback', 'wss://127.1'],
    ['integer loopback', 'wss://2130706433'],
    ['hex loopback', 'wss://0x7f.0.0.1'],
    ['octal loopback', 'wss://0177.0.0.1'],
    ['unspecified v4', 'wss://0.0.0.0'],
    ['private 10/8', 'wss://10.1.2.3'],
    ['private 172.16/12', 'wss://172.20.0.1'],
    ['private 192.168/16', 'wss://192.168.0.10'],
    ['CGNAT', 'wss://100.64.0.1'],
    ['link-local / metadata', 'wss://169.254.169.254'],
    ['multicast', 'wss://224.0.0.1'],
    ['broadcast', 'wss://255.255.255.255'],
    ['TEST-NET', 'wss://192.0.2.1'],
    ['loopback v6', 'wss://[::1]'],
    ['unspecified v6', 'wss://[::]'],
    ['unique-local v6', 'wss://[fd00::1]'],
    ['link-local v6', 'wss://[fe80::1]'],
    ['v4-mapped v6', 'wss://[::ffff:127.0.0.1]'],
    ['v4-mapped hex v6', 'wss://[::ffff:7f00:1]'],
    ['wildcard rebinding DNS', 'wss://10.0.0.1.nip.io'],
    ['userinfo', 'wss://user:pass@relay.example.com'],
    ['userinfo host confusion', 'wss://relay.example.com@127.0.0.1'],
    ['backslash host confusion', 'wss://relay.example.com\\@127.0.0.1'],
    ['percent-encoded host', 'wss://%31%32%37.0.0.1'],
    ['embedded newline', 'wss://relay.exa\nmple.com'],
    ['embedded tab', 'wss://127.0.0.\t1'],
    ['leading space', ' wss://relay.example.com'],
    ['full-width digits', 'wss://１２７.0.0.1'],
    ['raw unicode host', 'wss://rеlay.example.com'],
    ['bad port', 'wss://relay.example.com:99999'],
    ['zero port', 'wss://relay.example.com:0'],
    ['onion', 'wss://abcdefghijklmnop.onion'],
    ['javascript scheme', 'javascript:alert(1)'],
    ['too long', `wss://${'a'.repeat(MAX_PEER_RELAY_URL_LENGTH)}.example.com`],
  ])('rejects %s', (_label, url) => {
    expect(sanitizePeerRelayUrls([url])).toEqual([]);
  });

  it.each([null, undefined, 42, {}, ['wss://relay.example.com'], true])(
    'rejects non-string entry %p',
    (value) => {
      expect(sanitizePeerRelayUrls([value])).toEqual([]);
    },
  );

  it('accepts public wss relays, normalised like the pool keys sockets', () => {
    expect(
      sanitizePeerRelayUrls([
        'wss://relay.example.com',
        'wss://inbox.example.org/path/',
        'wss://8.8.8.8:4443',
        'wss://[2606:4700::1111]',
      ]),
    ).toEqual([
      'wss://relay.example.com/',
      'wss://inbox.example.org/path',
      'wss://8.8.8.8:4443/',
      'wss://[2606:4700::1111]/',
    ]);
  });

  it('dedupes entries that normalise to the same relay', () => {
    expect(
      sanitizePeerRelayUrls([
        'wss://Relay.Example.com',
        'wss://relay.example.com/',
        'wss://relay.example.com:443',
      ]),
    ).toEqual(['wss://relay.example.com/']);
  });

  it(`caps the result at ${MAX_RELAYS_PER_PEER} relays per peer`, () => {
    const urls = Array.from({ length: 10 }, (_, i) => `wss://r${i}.example.com`);
    expect(sanitizePeerRelayUrls(urls)).toHaveLength(MAX_RELAYS_PER_PEER);
    expect(sanitizePeerRelayUrls(urls, 2)).toEqual([
      'wss://r0.example.com/',
      'wss://r1.example.com/',
    ]);
  });

  it('only examines a bounded number of entries from an oversized list', () => {
    const junk = Array.from({ length: MAX_PEER_RELAY_CANDIDATES }, () => 'ws://junk');
    expect(sanitizePeerRelayUrls([...junk, 'wss://relay.example.com'])).toEqual([]);
  });

  it('keeps the good relays from a list mixed with hostile ones', () => {
    expect(
      sanitizePeerRelayUrls([
        'wss://127.0.0.1',
        'ws://relay.example.com',
        'wss://good.example.com',
      ]),
    ).toEqual(['wss://good.example.com/']);
  });
});
