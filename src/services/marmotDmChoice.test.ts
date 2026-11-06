import { createMemoryMarmotBackend } from './marmotStore';
import {
  GroupActivity,
  noteRumor,
  seedActivity,
  seedActivityOnce,
  MAX_ACTIVITY_SKEW_MS,
  MAX_GROUP_RELAYS,
  MIN_GROUP_RELAYS,
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
  it('prefers the group with the newest activity over the one joined last', () => {
    // The field split: the old rule took the group THIS install joined last.
    const active = { id: 'marmot:bb', createdAt: 1_000, activityAt: 9_000 };
    const staleButJoinedLater = { id: 'marmot:aa', createdAt: 5_000, activityAt: 2_000 };
    expect(pickDm([staleButJoinedLater, active])).toBe(active);
    expect(pickDm([active, staleButJoinedLater])).toBe(active);
  });

  it('a group with no activity never outranks one that has some', () => {
    // A late Welcome for a stale group (no history readable) must not take over.
    const live = { id: 'marmot:aa', createdAt: 1_000, activityAt: 2_000 };
    const lateJoin = { id: 'marmot:bb', createdAt: 9_000 };
    expect(pickDm([lateJoin, live])).toBe(live);
  });

  it('with no activity anywhere, the group id decides, not local create/join time', () => {
    // Two installs saw the groups in opposite orders: they must still agree.
    const a = { id: 'marmot:aa', createdAt: 1_000 };
    const b = { id: 'marmot:bb', createdAt: 3_000 };
    expect(pickDm([a, b])).toBe(a);
    expect(
      pickDm([
        { ...b, createdAt: 1_000 },
        { ...a, createdAt: 3_000 },
      ])?.id,
    ).toBe(a.id);
  });

  it('equal activity breaks by group id, whatever order each install joined in', () => {
    // Two phones, opposite join orders, same messages seen: same pick.
    const phoneA = [
      { id: 'marmot:bb', createdAt: 1_000, activityAt: 5_000 },
      { id: 'marmot:aa', createdAt: 2_000, activityAt: 5_000 },
    ];
    const phoneB = [
      { id: 'marmot:bb', createdAt: 2_000, activityAt: 5_000 },
      { id: 'marmot:aa', createdAt: 1_000, activityAt: 5_000 },
    ];
    expect(pickDm(phoneA)?.id).toBe('marmot:aa');
    expect(pickDm(phoneB)?.id).toBe('marmot:aa');
  });

  it('returns undefined when there is no 1:1', () => {
    expect(pickDm([])).toBeUndefined();
  });
});

describe('GroupActivity', () => {
  it('only moves forward, and persists each advance', () => {
    const persist = jest.fn();
    const activity = new GroupActivity(persist, () => 10_000);
    activity.note('g', 5_000);
    activity.note('g', 4_000);
    activity.note('g', 5_000);
    expect(activity.get('g')).toBe(5_000);
    expect(persist.mock.calls).toEqual([['g', 5_000]]);
  });

  it("caps a sender's future-dated time at our clock plus the skew", () => {
    const activity = new GroupActivity(jest.fn(), () => 10_000);
    activity.note('g', 10_000 + 365 * 24 * 3_600_000);
    expect(activity.get('g')).toBe(10_000 + MAX_ACTIVITY_SKEW_MS);
  });
});

describe('noteRumor / seedActivity', () => {
  const me = 'a'.repeat(64);
  const ben = 'b'.repeat(64);

  it('counts chat messages at their own time, never push tokens or reactions', () => {
    const activity = new GroupActivity(jest.fn(), () => 10_000_000);
    noteRumor(activity, 'g', { kind: 447, created_at: 9_000 }); // push token
    noteRumor(activity, 'g', { kind: 7, created_at: 9_000 }); // reaction
    expect(activity.get('g')).toBeUndefined();
    noteRumor(activity, 'g', { kind: 9, created_at: 5_000 });
    expect(activity.get('g')).toBe(5_000_000);
  });

  it("seeds from others' stored messages only — our own may be failed sends", () => {
    const activity = new GroupActivity(jest.fn(), () => 10_000_000);
    seedActivity(
      activity,
      'g',
      [
        { pubkey: ben, kind: 9, created_at: 3_000 },
        { pubkey: me.toUpperCase(), kind: 9, created_at: 8_000 }, // ours: unknown outcome
        { pubkey: ben, kind: 448, created_at: 9_000 }, // control
        { pubkey: ben, kind: 9, created_at: 4_000 },
      ],
      me,
    );
    expect(activity.get('g')).toBe(4_000_000);
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

it('seeds own-message-only history once, including across restarts', async () => {
  const backend = createMemoryMarmotBackend();
  const queryRumors = jest.fn(async () => [{ pubkey: 'me', kind: 9, created_at: 123 }]);
  const group = { idStr: 'g', history: { queryRumors } };
  await seedActivityOnce(backend, new GroupActivity(jest.fn()), group, 'me');
  await seedActivityOnce(backend, new GroupActivity(jest.fn()), group, 'me');
  expect(queryRumors).toHaveBeenCalledTimes(1);
});

it('retries history seeding if the history read failed', async () => {
  const backend = createMemoryMarmotBackend();
  const queryRumors = jest
    .fn()
    .mockRejectedValueOnce(new Error('read failed'))
    .mockResolvedValue([]);
  const group = { idStr: 'g', history: { queryRumors } };
  const activity = new GroupActivity(jest.fn());
  await expect(seedActivityOnce(backend, activity, group, 'me')).rejects.toThrow('read failed');
  await seedActivityOnce(backend, activity, group, 'me');
  expect(queryRumors).toHaveBeenCalledTimes(2);
});
