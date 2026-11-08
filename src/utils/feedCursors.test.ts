import {
  applyFeedPage,
  cursorOf,
  hasAnyCursor,
  isStuckPage,
  newFeedCursors,
  noteFeedEvent,
  outboxSource,
  pageableSources,
  reopenFeedCursors,
  VIEWER_SOURCE,
} from './feedCursors';

const at = (...times: number[]) => times.map((created_at) => ({ created_at }));
const A = outboxSource('wss://a.example/');
const B = outboxSource('wss://b.example/');

it('tracks the oldest event per source (each author relay its own) and reports opening once', () => {
  const cursors = newFeedCursors();
  expect(hasAnyCursor(cursors)).toBe(false);
  expect(noteFeedEvent(cursors, B, 1000)).toBe(true);
  expect(noteFeedEvent(cursors, B, 971)).toBe(false);
  expect(noteFeedEvent(cursors, A, 100)).toBe(true);
  expect(noteFeedEvent(cursors, VIEWER_SOURCE, 500)).toBe(true);
  expect(cursorOf(cursors, A).oldest).toBe(100);
  expect(cursorOf(cursors, B).oldest).toBe(971);
  expect(cursorOf(cursors, VIEWER_SOURCE).oldest).toBe(500);
});

it('only candidates with a cursor and not at their end can page', () => {
  const cursors = newFeedCursors();
  noteFeedEvent(cursors, VIEWER_SOURCE, 100);
  noteFeedEvent(cursors, A, 900);
  expect(pageableSources(cursors, [VIEWER_SOURCE, A, B])).toEqual([VIEWER_SOURCE, A]);
  // A source whose relays are gone isn't a candidate.
  expect(pageableSources(cursors, [VIEWER_SOURCE])).toEqual([VIEWER_SOURCE]);
  cursorOf(cursors, VIEWER_SOURCE).ended = true;
  expect(pageableSources(cursors, [VIEWER_SOURCE, A])).toEqual([A]);
});

it('re-opens the given sources (or all), reporting whether one can page', () => {
  const cursors = newFeedCursors();
  noteFeedEvent(cursors, A, 900);
  cursorOf(cursors, A).ended = true;
  expect(reopenFeedCursors(cursors, [B])).toBe(false); // no cursor yet
  expect(reopenFeedCursors(cursors, [A])).toBe(true);
  cursorOf(cursors, A).ended = true;
  reopenFeedCursors(cursors);
  expect(cursorOf(cursors, A).ended).toBe(false);
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

it('a live event older than an ended source re-opens it', () => {
  const cursors = newFeedCursors();
  noteFeedEvent(cursors, A, 500);
  cursorOf(cursors, A).ended = true;
  // A newer event changes nothing; a late backfill older than the end re-opens.
  expect(noteFeedEvent(cursors, A, 600)).toBe(false);
  expect(cursorOf(cursors, A).ended).toBe(true);
  expect(noteFeedEvent(cursors, A, 400)).toBe(true);
  expect(cursorOf(cursors, A)).toEqual({ oldest: 400, ended: false });
  // An open source moving older isn't "newly" pageable.
  expect(noteFeedEvent(cursors, A, 300)).toBe(false);
});
