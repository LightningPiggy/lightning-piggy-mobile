/**
 * Per-session memory of remote media URLs that already ended in "tap to
 * retry" (failed after the automatic retry, or downloaded but undecodable).
 *
 * A permanently dead URL (404, gone host) otherwise costs a download plus the
 * automatic retry every time a list row showing it is recycled or remounted.
 * With this, a row that meets a remembered URL shows "tap to retry" straight
 * away without fetching; the user's tap forgets the URL and downloads afresh.
 *
 * In memory only (never persisted, cleared on app restart) and bounded:
 * re-remembering a URL makes it the newest, and past {@link MAX_ENTRIES} the
 * oldest entry is dropped, so a long scroll through broken media can't grow
 * it without limit.
 */
export const MAX_ENTRIES = 200;

// A Map iterates in insertion order, so its first key is the oldest entry.
const failed = new Map<string, true>();

export function rememberFailedMedia(url: string): void {
  failed.delete(url);
  failed.set(url, true);
  if (failed.size > MAX_ENTRIES) {
    const oldest = failed.keys().next().value;
    if (oldest !== undefined) failed.delete(oldest);
  }
}

export function hasFailedMedia(url: string): boolean {
  return failed.has(url);
}

export function forgetFailedMedia(url: string): void {
  failed.delete(url);
}

/** Test-only: start each test with an empty memory. */
export function __resetFailedMediaForTests(): void {
  failed.clear();
}
