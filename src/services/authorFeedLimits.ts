// The profile feed's bounds, in one dependency-free module so the feed
// service, the hook and the outbox socket budgets (#1390) agree on them.

/** Events per feed page (and in the live subscription). */
export const AUTHOR_FEED_PAGE_SIZE = 30;

/** Older pages a user can pull in on one visit — bounds memory and relay load. */
export const AUTHOR_FEED_MAX_PAGES = 10;

/** A relay the viewer didn't choose may send this many × `limit` events per
 * live subscription before it's cut off (hardening; a real author feed sends
 * at most `limit` stored events plus a few live posts). */
export const OUTBOX_FEED_EVENT_BUDGET_FACTOR = 4;

/**
 * Raw frames (any type) one outbox-owned socket may receive per lease before
 * it's cut off. Derived with real slack, because tripping it also records a
 * relay-health failure (two park a relay for the viewer too): the live feed's
 * own budget, plus every older page twice (a page stuck on one second is
 * re-asked from the second before) with an EOSE each, plus room for
 * NOTICE / CLOSED / AUTH frames and a profile lookup. 4×30 + 10×2×31 + 200 = 940.
 */
export const OUTBOX_FRAMES_PER_LEASE =
  OUTBOX_FEED_EVENT_BUDGET_FACTOR * AUTHOR_FEED_PAGE_SIZE +
  AUTHOR_FEED_MAX_PAGES * 2 * (AUTHOR_FEED_PAGE_SIZE + 1) +
  200;
