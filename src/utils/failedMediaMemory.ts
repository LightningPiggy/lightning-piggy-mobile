/**
 * Short-lived, in-memory record of remote media URLs that already ended in
 * "tap to retry" for a reason retrying won't fix: an HTTP 4xx (404, 410…), a
 * body over the size limit, a URL / redirect the remote policy refuses, or a
 * file that downloaded but couldn't be decoded. Offline, timeout and 5xx
 * failures are deliberately NOT remembered, so a brief outage can't pin images
 * to "tap to retry".
 *
 * A permanently dead URL (404, gone host) otherwise costs a download plus the
 * automatic retry every time a list row showing it is recycled or remounted.
 * With this, a row that meets a remembered URL shows "tap to retry" straight
 * away without fetching; the user's tap forgets the URL and downloads afresh.
 *
 * Entries expire after {@link TTL_MS}: a "permanent" 4xx isn't always forever
 * (a Blossom mirror that hasn't received the blob yet, a CDN's passing 403),
 * and an Android process can live for days. Never persisted; cleared on
 * account switch / logout (`dropIdentityKeyMaterial`). Bounded: re-remembering
 * a URL makes it the newest, and past {@link MAX_ENTRIES} the oldest entry is
 * dropped, so a long scroll through broken media can't grow it without limit.
 */
export const MAX_ENTRIES = 200;
export const TTL_MS = 15 * 60 * 1000;

// URL → when it was remembered. A Map iterates in insertion order, so its
// first key is the oldest entry.
const failed = new Map<string, number>();

export function rememberFailedMedia(url: string): void {
  failed.delete(url);
  failed.set(url, Date.now());
  if (failed.size > MAX_ENTRIES) {
    const oldest = failed.keys().next().value;
    if (oldest !== undefined) failed.delete(oldest);
  }
}

export function hasFailedMedia(url: string): boolean {
  const at = failed.get(url);
  if (at === undefined) return false;
  if (Date.now() - at >= TTL_MS) {
    failed.delete(url);
    return false;
  }
  return true;
}

export function forgetFailedMedia(url: string): void {
  failed.delete(url);
}

/** Forget every remembered URL (account switch / logout). */
export function clearFailedMedia(): void {
  failed.clear();
}

// `fetchBounded` / `resolveRemoteMedia` (remoteUrlPolicy.ts, remoteMediaCache.ts)
// refusals that will repeat identically on the next attempt.
const PERMANENT_MESSAGES = new Set([
  'Remote body exceeds limit',
  'Blocked remote URL',
  'Unvalidated remote redirect',
  'Missing redirect location',
  'Too many remote redirects',
]);

/**
 * Whether a `resolveRemoteMedia` rejection will fail the same way next time:
 * an HTTP 4xx other than 408 (timeout) / 429 (rate limited), a body over the
 * size limit, or a URL / redirect the remote policy refuses. Anything else (no
 * network, timeout, 5xx, cache cancelled) is transient.
 */
export function isPermanentMediaFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : '';
  if (PERMANENT_MESSAGES.has(message)) return true;
  const status = /^Remote fetch failed \((\d{3})\)$/.exec(message);
  if (!status) return false;
  const code = Number(status[1]);
  return code >= 400 && code < 500 && code !== 408 && code !== 429;
}

/** Test-only: start each test with an empty memory. */
export function __resetFailedMediaForTests(): void {
  clearFailedMedia();
}
