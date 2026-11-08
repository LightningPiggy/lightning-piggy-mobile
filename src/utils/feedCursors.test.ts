import {
  applyFeedPage,
  hasAnyCursor,
  isStuckPage,
  newFeedCursors,
  noteFeedEvent,
  pageableSources,
  reopenFeedCursors,
} from './feedCursors';

const at = (...times: number[]) => times.map((created_at) => ({ created_at }));
const both = () => true;

it('tracks the oldest event per source and reports a source opening once', () => {
  const cursors = newFeedCursors();
  expect(hasAnyCursor(cursors)).toBe(false);
  expect(noteFeedEvent(cursors, 'outbox', 1000)).toBe(true);
  expect(noteFeedEvent(cursors, 'outbox', 971)).toBe(false);
  expect(noteFeedEvent(cursors, 'outbox', 990)).toBe(false);
  expect(noteFeedEvent(cursors, 'viewer', 100)).toBe(true);
  expect(cursors.outbox.oldest).toBe(971);
  expect(cursors.viewer.oldest).toBe(100);
});

it('only sources with relays, a cursor and not at their end can page', () => {
  const cursors = newFeedCursors();
  noteFeedEvent(cursors, 'viewer', 100);
  expect(pageableSources(cursors, both)).toEqual(['viewer']);
  noteFeedEvent(cursors, 'outbox', 900);
  expect(pageableSources(cursors, (s) => s === 'viewer')).toEqual(['viewer']);
  cursors.viewer.ended = true;
  expect(pageableSources(cursors, both)).toEqual(['outbox']);
  reopenFeedCursors(cursors);
  expect(pageableSources(cursors, both)).toEqual(['viewer', 'outbox']);
});

it('a complete page with nothing older ends the source; an incomplete one never does', () => {
  const cursor = { oldest: 100, ended: false };
  applyFeedPage(cursor, 100, { events: at(100, 100), complete: false });
  expect(cursor.ended).toBe(false);
  applyFeedPage(cursor, 100, { events: at(90, 80), complete: true });
  expect(cursor).toEqual({ oldest: 80, ended: false });
  applyFeedPage(cursor, 80, { events: at(80), complete: true });
  expect(cursor.ended).toBe(true);
});

it('a full page stuck on the cursor second is stepped past', () => {
  expect(isStuckPage(at(100, 100, 100), 100, 3)).toBe(true);
  expect(isStuckPage(at(100, 100), 100, 3)).toBe(false);
  expect(isStuckPage(at(100, 99, 100), 100, 3)).toBe(false);
});
