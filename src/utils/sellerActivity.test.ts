import type { Event } from 'nostr-tools';
import {
  acceptActivity,
  stageActivity,
  parseActivityCursor,
  activityFilters,
  activitySince,
  activityTarget,
  ACTIVITY_WINDOW,
  type ActivityCursor,
} from './sellerActivity';
import { buildCommentTags, threadedComments } from './productComments';
const owner = 'a'.repeat(64);
const other = 'b'.repeat(64);
const coord = `30402:${owner}:thing:one`;
const now = 2_000_000_000;
const event = (id: string, overrides: Partial<Event> = {}): Event => ({
  id,
  pubkey: other,
  kind: 1111,
  created_at: now,
  tags: [
    ['A', coord],
    ['K', '30402'],
  ],
  content: '',
  sig: '',
  ...overrides,
});
const cursor = (): ActivityCursor => ({ lastSeen: now - 60, seen: [], strangers: {} });

it('chunks comments, review d coordinates and parent ids with limit and since', () => {
  const coords = Array.from({ length: 51 }, (_, i) => `${coord}${i}`);
  const filters = activityFilters(
    coords,
    Array.from({ length: 26 }, (_, i) => `${i}`),
    123,
    owner,
  );
  expect(filters).toHaveLength(9);
  expect(filters.every((f) => f.limit === 200 && f.since === 123)).toBe(true);
  expect(filters[0]['#A']).toEqual(coords.slice(0, 25));
  expect(filters[1]['#d']).toEqual(coords.slice(0, 25).map((c) => `a:${c}`));
  expect(filters[8]).toMatchObject({ '#p': [owner], '#k': ['1111'], '#K': ['30402'] });
  expect(activityFilters([], [], 123)).toEqual([]);
});
it('overlaps last seen by two minutes, caps initial catch-up at 30 days', () => {
  expect(activitySince(now - 10, now)).toBe(now - 130);
  expect(activitySince(0, now)).toBe(now - ACTIVITY_WINDOW);
});
it('dedupes relay replays including after cursor persistence and rejects old/future events', () => {
  const state = cursor();
  expect(acceptActivity(state, event('one'), coord, true, now)).toBe(true);
  expect(acceptActivity(JSON.parse(JSON.stringify(state)), event('one'), coord, true, now)).toBe(
    false,
  );
  expect(acceptActivity(state, event('old', { created_at: now - 181 }), coord, true, now)).toBe(
    false,
  );
  expect(acceptActivity(state, event('future', { created_at: now + 121 }), coord, true, now)).toBe(
    false,
  );
});
it('caps strangers at 20 per listing per day across restarts, without capping friends', () => {
  let state = cursor();
  for (let i = 0; i < 20; i++)
    expect(acceptActivity(state, event(`${i}`), coord, false, now)).toBe(true);
  state = JSON.parse(JSON.stringify(state));
  expect(acceptActivity(state, event('21'), coord, false, now)).toBe(false);
  expect(acceptActivity(state, event('other listing'), `${coord}2`, false, now)).toBe(true);
  expect(acceptActivity(state, event('friend'), coord, true, now)).toBe(true);
  expect(
    acceptActivity(
      state,
      event('tomorrow', { created_at: now + 86400 }),
      coord,
      false,
      now + 86400,
    ),
  ).toBe(true);
});
it('rejects self and unrelated events, and recognizes Gamma review coordinates', () => {
  const coords = new Set([coord]);
  expect(activityTarget(event('self', { pubkey: owner }), owner, coords, new Map())).toBeNull();
  expect(
    activityTarget(
      event('wrong', {
        tags: [
          ['A', `${coord}x`],
          ['K', '30402'],
        ],
      }),
      owner,
      coords,
      new Map(),
    ),
  ).toBeNull();
  expect(
    activityTarget(
      event('review', { kind: 31555, tags: [['d', `a:${coord}`]] }),
      owner,
      coords,
      new Map(),
    ),
  ).toMatchObject({ coord, tab: 'reviews' });
  expect(
    activityTarget(
      event('review', { kind: 31555, tags: [['d', coord]] }),
      owner,
      coords,
      new Map(),
    ),
  ).toBeNull();
});
it('validates actual parents for replies anywhere, distinguishing seller replies', () => {
  const elsewhere = `30402:${other}:elsewhere`;
  const parent = event('parent', {
    pubkey: owner,
    tags: [
      ['A', elsewhere],
      ['K', '30402'],
    ],
  });
  const reply = event('reply', {
    tags: [
      ['A', elsewhere],
      ['K', '30402'],
      ['e', parent.id],
      ['p', owner],
    ],
  });
  expect(activityTarget(reply, owner, new Set(), new Map())).toBeNull();
  expect(activityTarget(reply, owner, new Set(), new Map([[parent.id, parent]]))).toMatchObject({
    reply: true,
    sellerReply: true,
    coord: elsewhere,
  });
  expect(
    activityTarget(
      reply,
      owner,
      new Set(),
      new Map([[parent.id, { ...parent, tags: [['A', coord]] }]]),
    ),
  ).toBeNull();
});
it('builds a NIP-22 seller reply with listing root and comment parent, and renders the thread', () => {
  const listing = event('listing', { pubkey: owner, kind: 30402, tags: [['d', 'thing:one']] });
  const parent = event('parent', { tags: buildCommentTags(listing) });
  const tags = buildCommentTags(listing, parent);
  expect(tags).toEqual([
    ['A', coord],
    ['K', '30402'],
    ['P', owner],
    ['e', parent.id],
    ['k', '1111'],
    ['p', other],
  ]);
  const reply = event('reply', { pubkey: owner, tags });
  const nested = event('nested', { tags: buildCommentTags(listing, reply) });
  expect(
    threadedComments([nested, reply, parent], listing).map(({ comment, depth }) => [
      comment.id,
      depth,
    ]),
  ).toEqual([
    ['parent', 0],
    ['reply', 1],
    ['nested', 2],
  ]);
});

it('recovers corrupt cursors and bounds persisted dedupe state and future last-seen', () => {
  expect(parseActivityCursor('{broken', now)).toEqual({
    lastSeen: now - ACTIVITY_WINDOW,
    seen: [],
    strangers: {},
  });
  expect(
    parseActivityCursor(
      JSON.stringify({
        lastSeen: now + 5000,
        seen: [null, 'id'],
        strangers: { good: 20, bad: 'oops' },
      }),
      now,
    ),
  ).toEqual({ lastSeen: now, seen: ['id'], strangers: { good: 20 } });
  expect(
    parseActivityCursor(
      JSON.stringify({
        lastSeen: now,
        seen: Array.from({ length: 5000 }, (_, i) => `${i}`),
        strangers: {},
      }),
      now,
    ).seen,
  ).toHaveLength(4000);
});

it('stages an ID and quota without copying or mutating the cursor before commit', () => {
  const state = cursor();
  const ids = state.seen;
  const quotas = state.strangers;
  const seen = new Set(state.seen);
  const staged = stageActivity(state, seen, event('pending'), coord, false, now);
  expect(staged.accepted).toBe(true);
  expect(seen.has('pending')).toBe(false);
  expect(state.seen).toEqual([]);
  expect(state.strangers).toEqual({});
  staged.commit();
  staged.commit();
  expect(state.seen).toBe(ids);
  expect(state.strangers).toBe(quotas);
  expect(state.seen).toEqual(['pending']);
  expect(Object.values(state.strangers)).toEqual([1]);
  expect(stageActivity(state, seen, event('pending'), coord, false, now).accepted).toBe(false);
});
