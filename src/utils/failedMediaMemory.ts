/**
 * Per-session memory of remote media URLs that already ended in "tap to
 * retry" for a reason retrying won't fix: an HTTP 4xx (404, 410…), a body over
 * the size limit, or a file that downloaded but couldn't be decoded. Offline,
 * timeout and 5xx failures are deliberately NOT remembered, so a brief outage
 * can't pin images to "tap to retry" for the rest of the session.
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

/**
 * Whether a `resolveRemoteMedia` rejection will fail the same way next time.
 * Keyed off `fetchBounded`'s messages (remoteUrlPolicy.ts): an HTTP 4xx other
 * than 408 (timeout) / 429 (rate limited), or a body over the size limit.
 * Anything else (no network, timeout, 5xx, cache cancelled) is transient.
 */
export function isPermanentMediaFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  if (message === 'Remote body exceeds limit') return true;
  const status = /^Remote fetch failed \((\d{3})\)$/.exec(message);
  if (!status) return false;
  const code = Number(status[1]);
  return code >= 400 && code < 500 && code !== 408 && code !== 429;
}

/** Test-only: start each test with an empty memory. */
export function __resetFailedMediaForTests(): void {
  failed.clear();
}
