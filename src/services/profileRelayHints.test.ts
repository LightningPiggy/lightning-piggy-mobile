import { TEST_ACCOUNT_KEYS } from '../utils/testAccounts';
import { setCurrentUserPubkey } from './nostrActiveAccount';
import { peekPeerRelayLists } from './peerRelayLists';
import { buildProfileRelayHints } from './profileRelayHints';
import { DEFAULT_RELAYS } from './nostrRelayDefaults';

jest.mock('./peerRelayLists', () => ({
  getPeerRelayLists: jest.fn(),
  peekPeerRelayLists: jest.fn(),
}));
jest.mock('./appRelayPrefs', () => ({
  enabledAppRelays: (_group: string, list: readonly string[]) => list,
}));

const alice = 'a'.repeat(64);
const peek = jest.mocked(peekPeerRelayLists);
const cachedWrite = (write: string[]) =>
  peek.mockReturnValue({ status: 'ok', lists: { inbox: undefined, read: undefined, write } });

beforeEach(() => {
  jest.clearAllMocks();
  setCurrentUserPubkey('f'.repeat(64));
});

describe('buildProfileRelayHints (F8)', () => {
  it("prefers the target's cached write relays (at most 2), then the kind-3 relay", () => {
    cachedWrite(['wss://a1.example/', 'wss://a2.example/', 'wss://a3.example/']);
    const hints = buildProfileRelayHints(
      alice,
      [{ pubkey: alice, relay: 'wss://kind3.example' }],
      ['wss://mine.example'],
    );
    expect(hints).toEqual(['wss://a1.example/', 'wss://a2.example/', 'wss://kind3.example']);
  });

  it("keeps the old order when the target's relays aren't cached", () => {
    peek.mockReturnValue(undefined);
    expect(buildProfileRelayHints(alice, [], ['wss://mine.example'])).toEqual([
      'wss://mine.example',
      ...DEFAULT_RELAYS.slice(0, 2),
    ]);
  });

  it('dedupes across sources on the normalised URL', () => {
    cachedWrite(['wss://mine.example/']);
    const hints = buildProfileRelayHints(alice, [], ['wss://Mine.example']);
    expect(hints[0]).toBe('wss://mine.example/');
    expect(hints.filter((u) => u.toLowerCase().includes('mine'))).toHaveLength(1);
  });

  it('uses no peer relays for a test account in lockdown', () => {
    setCurrentUserPubkey(TEST_ACCOUNT_KEYS.big);
    cachedWrite(['wss://a1.example/']);
    expect(buildProfileRelayHints(alice, [], ['wss://mine.example'])).not.toContain(
      'wss://a1.example/',
    );
  });
});
