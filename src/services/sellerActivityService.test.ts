import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Event } from 'nostr-tools';
import {
  checkSellerActivity,
  cancelSellerActivity,
  resolveActivityListing,
} from './sellerActivityService';
import { querySyncAbortable } from './relayQuery';
import { fetchSellerEvents } from './marketSellerService';
import { shouldMuteNotification } from './mutedSenders';
import { fireNotification } from './notificationService';
import { recordNotification, listNotifications } from './notificationHistory';
import { setSellerActivityEnabled } from './sellerActivityPreference';
import { buildCommentTags } from '../utils/productComments';
import i18n from '../i18n';
import * as perf from '../utils/perfLog';
const owner = 'a'.repeat(64);
const friend = 'b'.repeat(64);
const stranger = 'c'.repeat(64);
let mockOwner: string | null = owner;
jest.mock('./walletStorageService', () => ({ getActivePubkey: () => mockOwner }));
jest.mock('./nostrPool', () => ({ pool: {}, trackRelays: jest.fn() }));
jest.mock('./relayQuery', () => ({ querySyncAbortable: jest.fn() }));
jest.mock('./marketSellerService', () => ({
  fetchSellerEvents: jest.fn(),
  loadHiddenListings: jest.fn(async () => new Map()),
}));
jest.mock('./mutedSenders', () => ({ shouldMuteNotification: jest.fn(async () => false) }));
jest.mock('./notificationService', () => ({ fireNotification: jest.fn(async () => null) }));
jest.mock('../contexts/nostrDecryptPacing', () => ({
  createYieldScheduler: () => ({ maybeYield: async () => {}, dispose: () => {} }),
}));
const now = Math.floor(Date.now() / 1000);
const listing: Event = {
  id: 'listing',
  kind: 30402,
  pubkey: owner,
  created_at: now - 10000,
  tags: [
    ['d', 'thing'],
    ['title', 'Piggy'],
    ['price', '20', 'SATS'],
  ],
  content: '',
  sig: '',
};
const comment = (id: string, pubkey = friend): Event => ({
  id,
  pubkey,
  kind: 1111,
  created_at: now,
  tags: buildCommentTags(listing),
  content: '',
  sig: '',
});
const opts = () => ({
  owner,
  relays: ['wss://test'],
  friends: new Map([[friend, 'Friend']]),
  onlyFriends: true,
  t: (key: string, options?: object) => i18n.t(key, options),
  signal: new AbortController().signal,
});
function respondWith(implementation: typeof querySyncAbortable) {
  jest.mocked(querySyncAbortable).mockImplementation(async (pool, relays, filter, params) => {
    for (const relay of relays) params.completedRelays?.add(relay);
    return implementation(pool, relays, filter, params);
  });
}
const cursorKey = `seller_activity_cursor_v1_${owner}`;
beforeEach(async () => {
  jest.clearAllMocks();
  jest.mocked(fireNotification).mockImplementation(async (payload) => {
    payload.onHistoryRecorded?.();
    return null;
  });
  await AsyncStorage.clear();
  mockOwner = owner;
  jest.mocked(fetchSellerEvents).mockResolvedValue([listing]);
  respondWith(async () => []);
});
it('produces comment/review history targets and dedupes repeated checks', async () => {
  const review: Event = {
    ...comment('review', stranger),
    kind: 31555,
    tags: [
      ['d', `a:30402:${owner}:thing`],
      ['rating', '0.8', 'thumb'],
    ],
  };
  respondWith(async (_pool, _relays, filter) =>
    filter['#A'] ? [comment('comment')] : filter['#d'] ? [review] : [],
  );
  await checkSellerActivity({ ...opts(), onlyFriends: false });
  expect(fireNotification).toHaveBeenCalledTimes(2);
  const calls = jest.mocked(fireNotification).mock.calls.map(([p]) => p);
  expect(calls[0]).toMatchObject({
    title: 'New comment on Piggy',
    historyKey: 'market:comment',
    data: { listingCoord: `30402:${owner}:thing`, feedbackTab: 'comments', owner },
  });
  expect(calls[1]).toMatchObject({
    title: 'New review on Piggy ★4',
    data: { feedbackTab: 'reviews' },
  });
  expect(await calls[0].shouldSuppress?.()).toBe(false);
  expect(await calls[1].shouldSuppress?.()).toBe(false);
  await checkSellerActivity(opts());
  expect(fireNotification).toHaveBeenCalledTimes(2);
  expect(JSON.parse((await AsyncStorage.getItem(cursorKey))!).lastSeen).toBeGreaterThanOrEqual(now);
});
it('discovers a seller reply to an old comment on another listing via its actual parent', async () => {
  jest.mocked(fetchSellerEvents).mockResolvedValue([]);
  const otherListing = { ...listing, pubkey: friend };
  const parent = {
    ...comment('parent', owner),
    created_at: now - 86400 * 365,
    tags: buildCommentTags(otherListing),
  };
  const reply = { ...comment('reply'), tags: buildCommentTags(otherListing, parent) };
  respondWith(async (_p, _r, filter) => (filter.ids ? [parent] : filter['#p'] ? [reply] : []));
  await checkSellerActivity(opts());
  expect(fireNotification).toHaveBeenCalledWith(
    expect.objectContaining({
      title: 'Seller replied',
      data: expect.objectContaining({
        listingCoord: `30402:${friend}:thing`,
        feedbackTab: 'comments',
      }),
    }),
  );
  expect(
    jest
      .mocked(querySyncAbortable)
      .mock.calls.some(
        ([, , f]) => f.ids?.includes('parent') && f.since === 0 && f.authors?.includes(owner),
      ),
  ).toBe(true);
});
it('rejects forged recipients and rechecks toggles before delivery', async () => {
  respondWith(async (_p, _r, f) => (f['#A'] ? [comment('comment')] : []));
  await checkSellerActivity(opts());
  const payload = jest.mocked(fireNotification).mock.calls[0][0];
  await setSellerActivityEnabled(owner, false);
  expect(await payload.shouldSuppress?.()).toBe(true);
  jest.mocked(fetchSellerEvents).mockResolvedValue([]);
  respondWith(async (_p, _r, f) =>
    f['#p']
      ? [
          {
            ...comment('forged'),
            tags: [
              ...buildCommentTags({ ...listing, pubkey: stranger }),
              ['e', 'fake'],
              ['p', owner],
            ],
          },
        ]
      : [],
  );
  await checkSellerActivity(opts());
  expect(fireNotification).toHaveBeenCalledTimes(1);
});
it('does not advance last-seen on relay failure or an account switch', async () => {
  await AsyncStorage.setItem(
    cursorKey,
    JSON.stringify({ lastSeen: now - 60, seen: [], strangers: {} }),
  );
  jest.mocked(querySyncAbortable).mockRejectedValueOnce(new Error('offline'));
  await expect(checkSellerActivity(opts())).rejects.toThrow('offline');
  expect(JSON.parse((await AsyncStorage.getItem(cursorKey))!).lastSeen).toBe(now - 60);
  respondWith(async () => {
    mockOwner = stranger;
    return [comment('late')];
  });
  await checkSellerActivity(opts());
  expect(fireNotification).not.toHaveBeenCalled();
  expect(JSON.parse((await AsyncStorage.getItem(cursorKey))!).lastSeen).toBe(now - 60);
});
it('cancels an in-flight check before account removal and waits for it to settle', async () => {
  let release!: (events: Event[]) => void;
  jest.mocked(fetchSellerEvents).mockReturnValueOnce(
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  const pending = checkSellerActivity(opts());
  // Let storage hydration reach the relay snapshot.
  while (!release) await Promise.resolve();
  const cancelled = cancelSellerActivity(owner);
  release([listing]);
  await Promise.all([pending, cancelled]);
  expect(await AsyncStorage.getItem(cursorKey)).toBeNull();
  expect(fireNotification).not.toHaveBeenCalled();
});
it('resolves the correct latest listing only after a tap, preserving colon-containing identifiers', async () => {
  respondWith(async () => [
    {
      ...listing,
      tags: [
        ['d', 'thing:two'],
        ['title', 'Current'],
        ['price', '20', 'SATS'],
      ],
    },
  ]);
  const product = await resolveActivityListing(
    `30402:${owner}:thing:two`,
    ['wss://test'],
    new AbortController().signal,
  );
  expect(product?.title).toBe('Current');
  expect(await resolveActivityListing('invalid', [], new AbortController().signal)).toBeNull();
});

it('persists consumed stranger quotas when a later relay chunk fails, without advancing last-seen', async () => {
  await AsyncStorage.setItem(
    cursorKey,
    JSON.stringify({ lastSeen: now - 60, seen: [], strangers: {} }),
  );
  respondWith(async (_p, _r, f) => {
    if (f['#A']) return Array.from({ length: 20 }, (_, i) => comment(`spam${i}`, stranger));
    throw new Error('later chunk offline');
  });
  await expect(checkSellerActivity({ ...opts(), onlyFriends: false })).rejects.toThrow(
    'later chunk offline',
  );
  expect(fireNotification).toHaveBeenCalledTimes(20);
  expect(JSON.parse((await AsyncStorage.getItem(cursorKey))!).lastSeen).toBe(now - 60);
  respondWith(async (_p, _r, f) => (f['#A'] ? [comment('more spam', stranger)] : []));
  await checkSellerActivity({ ...opts(), onlyFriends: false });
  expect(fireNotification).toHaveBeenCalledTimes(20);
});

it('drains capped pages including timestamp ties before advancing the checkpoint', async () => {
  const events = Array.from({ length: 201 }, (_, i) => ({
    ...comment(`busy-${i}`),
    created_at: now - 1000 - Math.floor(i / 2),
  }));
  await AsyncStorage.setItem(
    cursorKey,
    JSON.stringify({ lastSeen: now - 2000, seen: [], strangers: {} }),
  );
  respondWith(async (_p, _r, f) =>
    f['#A']
      ? events.filter((e) => e.created_at >= f.since! && e.created_at <= f.until!).slice(0, f.limit)
      : [],
  );
  await checkSellerActivity(opts());
  expect(fireNotification).toHaveBeenCalledTimes(201);
  expect(fireNotification).toHaveBeenCalledWith(
    expect.objectContaining({ historyKey: 'market:busy-200' }),
  );
  expect(JSON.parse((await AsyncStorage.getItem(cursorKey))!).lastSeen).toBeGreaterThanOrEqual(now);
});

it('skips a saturated second, logs its returned count and continues to older activity', async () => {
  const saturated = Array.from({ length: 200 }, (_, i) => ({
    ...comment(`same-${i}`),
    created_at: now - 500,
  }));
  const older = { ...comment('older'), created_at: now - 501 };
  respondWith(async (_p, _r, f) =>
    f['#A'] ? [...saturated, older].filter((e) => e.created_at <= f.until!).slice(0, f.limit) : [],
  );
  const log = jest.spyOn(perf, 'perfLog').mockImplementation(() => {});
  try {
    await checkSellerActivity(opts());
    expect(fireNotification).toHaveBeenCalledTimes(201);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('skipped saturated second (200 returned events)'),
    );
    expect(JSON.parse((await AsyncStorage.getItem(cursorKey))!).lastSeen).toBeGreaterThanOrEqual(
      now,
    );
    expect(
      jest.mocked(querySyncAbortable).mock.calls.some(([, , f]) => f.until === now - 501),
    ).toBe(true);
  } finally {
    log.mockRestore();
  }
});

it('cannot pin the checkpoint with saturated p-tag spam when the owner has no listings', async () => {
  jest.mocked(fetchSellerEvents).mockResolvedValue([]);
  const parent = { ...comment('owned-parent', owner), created_at: now - 86400 * 365 };
  const reply = {
    ...comment('genuine-reply'),
    created_at: now - 501,
    tags: buildCommentTags(listing, parent),
  };
  const spam = Array.from({ length: 200 }, (_, i) => ({
    ...comment(`p-spam-${i}`, stranger),
    created_at: now - 500,
    tags: [
      ['p', owner],
      ['K', '30402'],
      ['k', '1111'],
    ],
  }));
  await AsyncStorage.setItem(
    cursorKey,
    JSON.stringify({ lastSeen: now - 2000, seen: [], strangers: {} }),
  );
  respondWith(async (_p, _r, f) => {
    if (f.ids) return [parent];
    return [...spam, reply]
      .filter((event) => event.created_at >= f.since! && event.created_at <= f.until!)
      .slice(0, f.limit);
  });
  await checkSellerActivity({ ...opts(), onlyFriends: false });
  expect(fireNotification).toHaveBeenCalledTimes(1);
  expect(fireNotification).toHaveBeenCalledWith(
    expect.objectContaining({ historyKey: 'market:genuine-reply' }),
  );
  const cursor = JSON.parse((await AsyncStorage.getItem(cursorKey))!);
  expect(cursor.lastSeen).toBeGreaterThanOrEqual(now);
  expect(cursor.seen).toEqual(['genuine-reply']);
  expect(cursor.strangers).toEqual({});

  jest.mocked(querySyncAbortable).mockClear();
  await checkSellerActivity({ ...opts(), onlyFriends: false });
  expect(querySyncAbortable).toHaveBeenCalledTimes(1);
  expect(fireNotification).toHaveBeenCalledTimes(1);
});

it('retries an event interrupted during mute lookup without consuming its stranger quota', async () => {
  let release!: (muted: boolean) => void;
  jest.mocked(shouldMuteNotification).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  respondWith(async (_p, _r, f) => (f['#A'] ? [comment('interrupted', stranger)] : []));
  const controller = new AbortController();
  const pending = checkSellerActivity({ ...opts(), onlyFriends: false, signal: controller.signal });
  while (!release) await Promise.resolve();
  controller.abort();
  release(false);
  await pending;
  expect(fireNotification).not.toHaveBeenCalled();
  expect(await AsyncStorage.getItem(cursorKey)).toBeNull();
  await checkSellerActivity({ ...opts(), onlyFriends: false });
  expect(fireNotification).toHaveBeenCalledTimes(1);
  const cursor = JSON.parse((await AsyncStorage.getItem(cursorKey))!);
  expect(cursor.seen).toContain('interrupted');
  expect(Object.values(cursor.strangers)).toEqual([1]);
});

it('does not commit an event whose history delivery rejects', async () => {
  respondWith(async (_p, _r, f) => (f['#A'] ? [comment('retry')] : []));
  jest.mocked(fireNotification).mockRejectedValueOnce(new Error('history failed'));
  await expect(checkSellerActivity(opts())).rejects.toThrow('history failed');
  expect(await AsyncStorage.getItem(cursorKey)).toBeNull();
  await checkSellerActivity(opts());
  expect(fireNotification).toHaveBeenCalledTimes(2);
});

it('drains a busy relay without skipping its tail when another relay returns older activity', async () => {
  const recent = Array.from({ length: 250 }, (_, i) => ({
    ...comment(`recent-${i}`),
    created_at: now - 1000 - i,
  }));
  const older = { ...comment('sparse-relay'), created_at: now - 1500 };
  await AsyncStorage.setItem(
    cursorKey,
    JSON.stringify({ lastSeen: now - 2000, seen: [], strangers: {} }),
  );
  respondWith(async (_p, relays, f) => {
    if (!f['#A']) return [];
    expect(relays).toEqual(['wss://busy', 'wss://sparse']);
    const matches = (event: Event) => event.created_at >= f.since! && event.created_at <= f.until!;
    // querySyncAbortable returns the deduplicated union, not a global limit.
    // Put the sparse relay first to also exercise unordered arrival.
    return [older].filter(matches).concat(recent.filter(matches).slice(0, f.limit));
  });
  await checkSellerActivity({ ...opts(), relays: ['wss://busy', 'wss://sparse'] });
  expect(fireNotification).toHaveBeenCalledTimes(251);
  expect(fireNotification).toHaveBeenCalledWith(
    expect.objectContaining({ historyKey: 'market:recent-249' }),
  );
  expect(fireNotification).toHaveBeenCalledWith(
    expect.objectContaining({ historyKey: 'market:sparse-relay' }),
  );
  expect(JSON.parse((await AsyncStorage.getItem(cursorKey))!).lastSeen).toBeGreaterThanOrEqual(now);
});

it('continues reviews, later coordinate chunks and replies after a saturated second', async () => {
  const listings = Array.from({ length: 26 }, (_, i) => ({
    ...listing,
    id: `listing-${i}`,
    tags: listing.tags.map((tag) => (tag[0] === 'd' ? ['d', `thing-${i}`] : tag)),
  }));
  jest.mocked(fetchSellerEvents).mockResolvedValue(listings);
  const parent = {
    ...comment('old-parent', owner),
    created_at: now - 86400 * 365,
    tags: buildCommentTags({ ...listing, pubkey: friend }),
  };
  const reply = {
    ...comment('independent-reply'),
    tags: buildCommentTags({ ...listing, pubkey: friend }, parent),
  };
  const review = {
    ...comment('independent-review'),
    kind: 31555,
    tags: [
      ['d', `a:30402:${owner}:thing-0`],
      ['rating', '0.8', 'thumb'],
    ],
  };
  const later = { ...comment('later-chunk'), tags: buildCommentTags(listings[25]) };
  const saturated = Array.from({ length: 200 }, (_, i) => ({
    ...comment(`saturated-${i}`),
    created_at: now - 500,
    tags: buildCommentTags(listings[0]),
  }));
  await AsyncStorage.setItem(
    cursorKey,
    JSON.stringify({ lastSeen: now - 2000, seen: [], strangers: {} }),
  );
  respondWith(async (_p, _r, f) => {
    if (f.ids) return [parent];
    if (f['#p']) return [reply];
    if (f['#d']?.includes(`a:30402:${owner}:thing-0`)) return [review];
    if (f['#A']?.includes(`30402:${owner}:thing-0`)) return saturated;
    if (f['#A']) return [later];
    return [];
  });
  await checkSellerActivity(opts());
  for (const id of ['independent-review', 'later-chunk', 'independent-reply']) {
    expect(fireNotification).toHaveBeenCalledWith(
      expect.objectContaining({ historyKey: `market:${id}` }),
    );
  }
  const cursor = JSON.parse((await AsyncStorage.getItem(cursorKey))!);
  expect(cursor.lastSeen).toBeGreaterThanOrEqual(now);
  expect(cursor.seen).toEqual(
    expect.arrayContaining(['independent-review', 'later-chunk', 'independent-reply']),
  );
  const delivered = jest.mocked(fireNotification).mock.calls.length;
  // Once the busy range can drain, retry without redelivering successful work.
  saturated.pop();
  await checkSellerActivity(opts());
  expect(fireNotification).toHaveBeenCalledTimes(delivered);
  expect(JSON.parse((await AsyncStorage.getItem(cursorKey))!).lastSeen).toBeGreaterThanOrEqual(now);
});

it('drains completed relays but retains the checkpoint for unfinished relays', async () => {
  const events = Array.from({ length: 201 }, (_, i) => ({
    ...comment(`completed-${i}`),
    created_at: now - i,
  }));
  const checkpoint = now - 1000;
  await AsyncStorage.setItem(
    cursorKey,
    JSON.stringify({ lastSeen: checkpoint, seen: [], strangers: {} }),
  );
  const pageRelays: string[][] = [];
  respondWith(async (_p, relays, f, params) => {
    params.completedRelays?.delete('wss://stalled');
    if (!f['#A']) return [];
    pageRelays.push(relays);
    return events.filter((e) => e.created_at <= f.until!).slice(0, f.limit);
  });
  await expect(
    checkSellerActivity({ ...opts(), relays: ['wss://good', 'wss://stalled'] }),
  ).rejects.toThrow('relay query incomplete');
  expect(pageRelays).toEqual([['wss://good', 'wss://stalled'], ['wss://good']]);
  expect(fireNotification).toHaveBeenCalledTimes(201);
  expect(JSON.parse((await AsyncStorage.getItem(cursorKey))!).lastSeen).toBe(checkpoint);
});

it('drops events newer than the requested page before selecting its newest results', async () => {
  const events = Array.from({ length: 201 }, (_, i) => ({
    ...comment(`bounded-${i}`),
    created_at: now - i,
  }));
  respondWith(async (_p, _r, f) => {
    if (!f['#A']) return [];
    const matches = events.filter((e) => e.created_at <= f.until!).slice(0, f.limit);
    return f.until! < now ? [...events.slice(0, 199), ...matches] : matches;
  });
  await checkSellerActivity(opts());
  expect(fireNotification).toHaveBeenCalledTimes(201);
  expect(fireNotification).toHaveBeenCalledWith(
    expect.objectContaining({ historyKey: 'market:bounded-200' }),
  );
});

it.each(['comment', 'review'])(
  'records stranger %s history without an Only friends alert',
  async (kind) => {
    const event =
      kind === 'comment'
        ? comment('stranger-activity', stranger)
        : {
            ...comment('stranger-activity', stranger),
            kind: 31555,
            tags: [
              ['d', `a:30402:${owner}:thing`],
              ['rating', '0.8', 'thumb'],
            ],
          };
    respondWith(async (_p, _r, f) => ((kind === 'comment' ? f['#A'] : f['#d']) ? [event] : []));
    await checkSellerActivity(opts());
    expect(fireNotification).toHaveBeenCalledTimes(1);
    const payload = jest.mocked(fireNotification).mock.calls[0][0];
    expect(payload.historyKey).toBe('market:stranger-activity');
    expect(await payload.mayRecord?.()).toBe(true);
    expect(await payload.shouldSuppress?.()).toBe(true);
    const cursor = JSON.parse((await AsyncStorage.getItem(cursorKey))!);
    expect(cursor.seen).toContain(event.id);
    expect(Object.values(cursor.strangers)).toEqual([1]);

    // Broadening the audience must not replay activity already recorded silently.
    await checkSellerActivity({ ...opts(), onlyFriends: false });
    expect(fireNotification).toHaveBeenCalledTimes(1);

    await setSellerActivityEnabled(owner, false);
    expect(await payload.mayRecord?.()).toBe(false);
    await setSellerActivityEnabled(owner, true);
    mockOwner = friend;
    expect(await payload.mayRecord?.()).toBe(false);
  },
);

it.each(['disabled', 'disabled during mute lookup'])(
  'records no history or alerts for activity excluded by %s',
  async (mode) => {
    if (mode === 'disabled') await setSellerActivityEnabled(owner, false);
    if (mode === 'disabled during mute lookup')
      jest.mocked(shouldMuteNotification).mockImplementationOnce(async () => {
        await setSellerActivityEnabled(owner, false);
        return false;
      });
    respondWith(async (_p, _r, f) => (f['#A'] ? [comment('excluded')] : []));
    await checkSellerActivity(opts());
    expect(fireNotification).not.toHaveBeenCalled();
  },
);

it('retries a failed relay after activity has fallen outside the overlap window', async () => {
  const checkpoint = now - 600;
  const missed = { ...comment('missed-on-offline-relay'), created_at: now - 300 };
  await AsyncStorage.setItem(
    cursorKey,
    JSON.stringify({ lastSeen: checkpoint, seen: [], strangers: {} }),
  );
  respondWith(async (_p, _r, _f, params) => {
    params.completedRelays?.delete('wss://offline');
    return [];
  });
  const input = { ...opts(), relays: ['wss://empty', 'wss://offline'] };
  await expect(checkSellerActivity(input)).rejects.toThrow('relay query incomplete');
  expect(JSON.parse((await AsyncStorage.getItem(cursorKey))!).lastSeen).toBe(checkpoint);
  respondWith(async (_p, _r, f) => (f['#A'] && missed.created_at >= f.since! ? [missed] : []));
  await checkSellerActivity(input);
  expect(fireNotification).toHaveBeenCalledWith(
    expect.objectContaining({ historyKey: `market:${missed.id}` }),
  );
  expect(JSON.parse((await AsyncStorage.getItem(cursorKey))!).lastSeen).toBeGreaterThanOrEqual(now);
});

it('retains the newest 200 source events from a 400-comment paginated catch-up', async () => {
  const events = Array.from({ length: 400 }, (_, i) => ({
    ...comment(`history-${i}`),
    created_at: now - i,
  }));
  respondWith(async (_p, _r, f) =>
    f['#A'] ? events.filter((e) => e.created_at <= f.until!).slice(0, f.limit) : [],
  );
  // Keep the real bounded history store while avoiding native delivery.
  jest.mocked(fireNotification).mockImplementation(async (payload) => {
    await recordNotification(owner, payload, payload.historyCreatedAt);
    payload.onHistoryRecorded?.();
    return null;
  });
  await checkSellerActivity(opts());
  const history = await listNotifications(owner);
  expect(history.map((e) => e.key)).toEqual(events.slice(0, 200).map((e) => `market:${e.id}`));
  expect(history.map((e) => e.createdAt)).toEqual(
    events.slice(0, 200).map((e) => e.created_at * 1000),
  );
  jest.mocked(fireNotification).mockImplementation(async () => null);
});

it('marks muted comments seen without consuming the quota for unmuted strangers', async () => {
  const muted = Array.from({ length: 20 }, (_, i) => ({
    ...comment(`muted-${i}`, stranger),
    created_at: now - 100 + i,
  }));
  const allowed = comment('unmuted-stranger', 'd'.repeat(64));
  jest
    .mocked(shouldMuteNotification)
    .mockImplementation(async (_owner, data) => data?.senderPubkey === stranger);
  respondWith(async (_p, _r, f) => (f['#A'] ? [...muted, allowed] : []));
  try {
    await checkSellerActivity({ ...opts(), onlyFriends: false });
    expect(fireNotification).toHaveBeenCalledTimes(1);
    expect(fireNotification).toHaveBeenCalledWith(
      expect.objectContaining({ historyKey: `market:${allowed.id}` }),
    );
    const cursor = JSON.parse((await AsyncStorage.getItem(cursorKey))!);
    expect(cursor.seen).toEqual(expect.arrayContaining([...muted, allowed].map((e) => e.id)));
    expect(Object.values(cursor.strangers)).toEqual([1]);
    await checkSellerActivity(opts());
    expect(fireNotification).toHaveBeenCalledTimes(1);
  } finally {
    jest.mocked(shouldMuteNotification).mockImplementation(async () => false);
  }
});

it.each(['blur', 'account switch', 'account removal'])(
  'retries unrecorded activity after %s during notification checks',
  async (mode) => {
    const checkpoint = now - 600;
    const event = { ...comment('interrupted', stranger), created_at: now - 300 };
    await AsyncStorage.setItem(
      cursorKey,
      JSON.stringify({ lastSeen: checkpoint, seen: [], strangers: {} }),
    );
    respondWith(async (_p, _r, f) => (f['#A'] ? [event] : []));
    const controller = new AbortController();
    let cancelled: Promise<void> | undefined;
    jest.mocked(fireNotification).mockImplementationOnce(async (payload) => {
      if (mode === 'blur') controller.abort();
      if (mode === 'account switch') mockOwner = friend;
      if (mode === 'account removal') cancelled = cancelSellerActivity(owner);
      expect(await payload.mayRecord?.()).toBe(false);
      return null;
    });
    await checkSellerActivity({ ...opts(), signal: controller.signal });
    await cancelled;
    expect(JSON.parse((await AsyncStorage.getItem(cursorKey))!)).toEqual({
      lastSeen: checkpoint,
      seen: [],
      strangers: {},
    });
    mockOwner = owner;
    await checkSellerActivity(opts());
    expect(fireNotification).toHaveBeenCalledTimes(2);
    const cursor = JSON.parse((await AsyncStorage.getItem(cursorKey))!);
    expect(cursor.seen).toContain(event.id);
    expect(Object.values(cursor.strangers)).toEqual([1]);
  },
);

it('retains the retry checkpoint when notification history is not recorded', async () => {
  const checkpoint = now - 600;
  await AsyncStorage.setItem(
    cursorKey,
    JSON.stringify({ lastSeen: checkpoint, seen: [], strangers: {} }),
  );
  respondWith(async (_p, _r, f) => (f['#A'] ? [comment('unrecorded', stranger)] : []));
  jest.mocked(fireNotification).mockImplementationOnce(async () => null);
  await expect(checkSellerActivity(opts())).rejects.toThrow('history was not recorded');
  expect(JSON.parse((await AsyncStorage.getItem(cursorKey))!)).toEqual({
    lastSeen: checkpoint,
    seen: [],
    strangers: {},
  });
  await checkSellerActivity(opts());
  expect(fireNotification).toHaveBeenCalledTimes(2);
});

it('resolves a listing from a healthy relay when another relay is unavailable', async () => {
  respondWith(async (_p, _r, _f, params) => {
    params.completedRelays?.delete('wss://offline');
    return [listing];
  });
  const product = await resolveActivityListing(
    `30402:${owner}:thing`,
    ['wss://healthy', 'wss://offline'],
    new AbortController().signal,
  );
  expect(product?.title).toBe('Piggy');
});

it('commits recorded history even if the screen blurs before alert delivery returns', async () => {
  const controller = new AbortController();
  const event = comment('recorded-before-blur', stranger);
  respondWith(async (_p, _r, f) => (f['#A'] ? [event] : []));
  jest.mocked(fireNotification).mockImplementationOnce(async (payload) => {
    payload.onHistoryRecorded?.();
    controller.abort();
    return null;
  });
  await checkSellerActivity({ ...opts(), signal: controller.signal });
  const cursor = JSON.parse((await AsyncStorage.getItem(cursorKey))!);
  expect(cursor.seen).toContain(event.id);
  expect(Object.values(cursor.strangers)).toEqual([1]);
  await checkSellerActivity(opts());
  expect(fireNotification).toHaveBeenCalledTimes(1);
});
