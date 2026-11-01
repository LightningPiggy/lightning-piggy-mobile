import {
  MAX_GROUP_RELAYS,
  MIN_GROUP_RELAYS,
  groupActivityMs,
  groupRelaysFor,
  pickDm,
  relayTopUp,
} from './marmotDmChoice';

const FALLBACKS = [
  'wss://relay.eu.whitenoise.chat',
  'wss://relay.us.whitenoise.chat',
  'wss://relay.primal.net',
  'wss://relay.damus.io',
  'wss://nos.lol',
];

describe('pickDm', () => {
  it('prefers the group with the newest relay activity over the one joined last', () => {
    // The field split: the old rule took the group THIS install joined last.
    const active = { id: 'marmot:bb', createdAt: 1_000, activityAt: 9_000 };
    const staleButJoinedLater = { id: 'marmot:aa', createdAt: 5_000, activityAt: 2_000 };
    expect(pickDm([staleButJoinedLater, active])).toBe(active);
    expect(pickDm([active, staleButJoinedLater])).toBe(active);
  });

  it('a group with no traffic seen yet ranks by when we made or joined it', () => {
    // A just-(re)started chat takes over from a dead one.
    const old = { id: 'marmot:aa', createdAt: 1_000, activityAt: 2_000 };
    const fresh = { id: 'marmot:bb', createdAt: 3_000 };
    expect(pickDm([old, fresh])).toBe(fresh);
  });

  it('breaks ties the same way on every install', () => {
    const a = { id: 'marmot:aa', createdAt: 1_000, activityAt: 5_000 };
    const b = { id: 'marmot:bb', createdAt: 1_000, activityAt: 5_000 };
    expect(pickDm([b, a])).toBe(a);
    expect(pickDm([a, b])).toBe(a);
  });

  it('returns undefined when there is no 1:1', () => {
    expect(pickDm([])).toBeUndefined();
  });
});

describe('groupActivityMs', () => {
  it('reads the seconds watermark for the group h id as ms', () => {
    const marks = new Map([['ab', 1_700_000_000]]);
    expect(groupActivityMs(marks, 'ab')).toBe(1_700_000_000_000);
    expect(groupActivityMs(marks, 'cd')).toBeUndefined();
    expect(groupActivityMs(marks, undefined)).toBeUndefined();
  });
});

describe('groupRelaysFor', () => {
  it('a one-relay account still gets a chat on several relays, its own first', () => {
    // 1.6.0 made nos.lol-only chats for an account whose NIP-65 lists one write relay.
    expect(groupRelaysFor(['wss://nos.lol/'], FALLBACKS)).toEqual([
      'wss://nos.lol',
      'wss://relay.eu.whitenoise.chat',
      'wss://relay.us.whitenoise.chat',
    ]);
  });

  it('no write relays → the fallbacks, at least the minimum', () => {
    expect(groupRelaysFor([], FALLBACKS)).toHaveLength(MIN_GROUP_RELAYS);
  });

  it('always adds at least one fallback, and caps the total', () => {
    const own = ['wss://a.example', 'wss://b.example', 'wss://c.example'];
    expect(groupRelaysFor(own, FALLBACKS)).toEqual([...own, FALLBACKS[0]]);
    const many = Array.from({ length: 9 }, (_, i) => `wss://r${i}.example`);
    const relays = groupRelaysFor(many, FALLBACKS);
    expect(relays).toHaveLength(MAX_GROUP_RELAYS);
    expect(relays.slice(0, MAX_GROUP_RELAYS - 1)).toEqual(many.slice(0, MAX_GROUP_RELAYS - 1));
    expect(relays).toContain(FALLBACKS[0]);
  });

  it('keeps a LAN test relay (no public-URL filter) and de-duplicates', () => {
    expect(groupRelaysFor(['ws://192.168.1.89:7778'], ['ws://192.168.1.89:7778'])).toEqual([
      'ws://192.168.1.89:7778',
    ]);
  });
});

describe('relayTopUp', () => {
  it('tops a single-relay chat up to the minimum, keeping what it has first', () => {
    expect(relayTopUp(['wss://nos.lol'], FALLBACKS)).toEqual([
      'wss://nos.lol',
      'wss://relay.eu.whitenoise.chat',
      'wss://relay.us.whitenoise.chat',
    ]);
  });

  it('does not re-add a relay the chat already has (trailing slash ignored)', () => {
    expect(relayTopUp(['wss://relay.eu.whitenoise.chat/'], FALLBACKS)).toEqual([
      'wss://relay.eu.whitenoise.chat/',
      'wss://relay.us.whitenoise.chat',
      'wss://relay.primal.net',
    ]);
  });

  it('leaves a chat with enough relays alone, and needs something to add', () => {
    expect(relayTopUp(FALLBACKS.slice(0, MIN_GROUP_RELAYS), FALLBACKS)).toBeNull();
    expect(relayTopUp(['wss://nos.lol'], ['wss://nos.lol'])).toBeNull();
  });
});
