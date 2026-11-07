// Guard: the app's built-in relay lists must not contain a relay known to be
// dead (#1326), and no list may lean on the relays that are down right now.
// If a relay here comes back for good, remove it from DEAD_RELAYS deliberately.
import {
  DEFAULT_RELAYS,
  MARMOT_PUSH_SERVER_RELAYS,
  NIP46_PAIRING_RELAYS,
  PROFILE_RELAYS,
} from './nostrRelayDefaults';
import { GC_RELAYS } from './geocacheRelays';
import { MARKET_RELAYS } from '../utils/marketListingsQuery';
import { RELAY_LIST_INDEXERS } from '../utils/relayListEvents';

const DEAD_RELAYS = ['relay.nostr.band', 'relay.nostr.net', 'relay.nsec.app'];
/** Intermittently unreachable / rate-limited for some IPs (one server); allowed only as an extra. */
const UNRELIABLE_RELAYS = ['nos.lol', 'nostr.mom'];
/** In-memory relay with ~1 h retention: useless as a default store. */
const NOT_A_STORE = ['relay.snort.social'];
/** Paid relays that limit or reject reads from non-subscribers: only cost a connection. */
const PAID_RELAYS = ['nostr.land'];

const host = (url: string) => new URL(url).host.toLowerCase();

const LISTS: Record<string, readonly string[]> = {
  DEFAULT_RELAYS,
  PROFILE_RELAYS,
  NIP46_PAIRING_RELAYS,
  MARMOT_PUSH_SERVER_RELAYS,
  GC_RELAYS,
  MARKET_RELAYS,
  RELAY_LIST_INDEXERS,
};

describe.each(Object.entries(LISTS))('%s', (_name, list) => {
  it('contains no dead relay', () => {
    expect(list.map(host).filter((h) => DEAD_RELAYS.includes(h))).toEqual([]);
  });

  it('contains no paid relay', () => {
    expect(list.map(host).filter((h) => PAID_RELAYS.includes(h))).toEqual([]);
  });

  it('is never made up only of unreliable relays', () => {
    expect(list.filter((r) => !UNRELIABLE_RELAYS.includes(host(r))).length).toBeGreaterThan(0);
  });
});

describe('general-purpose lists', () => {
  it.each([
    ['DEFAULT_RELAYS', DEFAULT_RELAYS],
    ['PROFILE_RELAYS', PROFILE_RELAYS],
  ])('%s has at least 3 healthy relays besides nos.lol / nostr.mom', (_name, list) => {
    const healthy = list.filter(
      (r) => !UNRELIABLE_RELAYS.includes(host(r)) && !NOT_A_STORE.includes(host(r)),
    );
    expect(new Set(healthy.map(host)).size).toBeGreaterThanOrEqual(3);
  });

  it('PROFILE_RELAYS includes the White Noise relays, where its users publish kind 0', () => {
    expect(PROFILE_RELAYS).toEqual(
      expect.arrayContaining(['wss://relay.eu.whitenoise.chat', 'wss://relay.us.whitenoise.chat']),
    );
  });

  it('DEFAULT_RELAYS leads with healthy relays (nprofile hints use the first 3)', () => {
    expect(DEFAULT_RELAYS.slice(0, 3).some((r) => UNRELIABLE_RELAYS.includes(host(r)))).toBe(false);
  });

  it('NIP-46 pairing names at least 2 healthy relays', () => {
    const healthy = NIP46_PAIRING_RELAYS.filter((r) => !UNRELIABLE_RELAYS.includes(host(r)));
    expect(healthy.length).toBeGreaterThanOrEqual(2);
  });
});
