import {
  AUTHOR_FEED_MAX_PAGES,
  AUTHOR_FEED_PAGE_SIZE,
  OUTBOX_FEED_EVENT_BUDGET_FACTOR,
  OUTBOX_FRAMES_PER_LEASE,
} from './authorFeedLimits';

it('gives an outbox socket real slack over honest heavy use (#1390)', () => {
  // Honest worst case for one lease: the live feed's own budget, plus every
  // older page asked twice (a stuck second is stepped past) with an EOSE each.
  const honest =
    OUTBOX_FEED_EVENT_BUDGET_FACTOR * AUTHOR_FEED_PAGE_SIZE +
    AUTHOR_FEED_MAX_PAGES * 2 * (AUTHOR_FEED_PAGE_SIZE + 1);
  expect(OUTBOX_FRAMES_PER_LEASE).toBe(honest + 200);
  expect(OUTBOX_FRAMES_PER_LEASE).toBeGreaterThanOrEqual(900);
});
