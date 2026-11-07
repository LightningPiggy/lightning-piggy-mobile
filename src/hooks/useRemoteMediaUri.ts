import { useCallback, useEffect, useState } from 'react';
import { useActivePubkey } from './useActivePubkey';
import { evictRemoteMedia, resolveRemoteMedia } from '../services/remoteMediaCache';
import {
  forgetFailedMedia,
  hasFailedMedia,
  isPermanentMediaFailure,
  rememberFailedMedia,
} from '../utils/failedMediaMemory';

export function useRemoteMedia(url: string | null, maxBytes: number) {
  const owner = useActivePubkey();
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const [resolved, setResolved] = useState<{
    owner: string | null;
    url: string;
    maxBytes: number;
    // The attempt this result belongs to: a retry must never show the
    // previous attempt's failure for the render before its effect runs.
    attempt: number;
    uri: string | null;
    // The file downloaded but couldn't be decoded (see reportBroken).
    broken?: boolean;
    // The download failed in a way retrying won't fix (e.g. 404); see
    // isPermanentMediaFailure.
    permanent?: boolean;
    // When `uri` was resolved, so reportBroken only evicts this copy.
    at: number;
    failed: boolean;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    setResolved(null);
    if (url)
      void resolveRemoteMedia(url, maxBytes).then(
        (uri) => {
          if (!cancelled)
            setResolved({
              owner,
              url,
              maxBytes,
              attempt,
              uri,
              at: Date.now(),
              failed: false,
            });
        },
        (error: unknown) => {
          if (!cancelled)
            setResolved({
              owner,
              url,
              maxBytes,
              attempt,
              uri: null,
              at: Date.now(),
              failed: true,
              permanent: isPermanentMediaFailure(error),
            });
        },
      );
    return () => {
      cancelled = true;
    };
  }, [owner, url, maxBytes, attempt]);
  const current =
    resolved?.owner === owner &&
    resolved?.url === url &&
    resolved?.maxBytes === maxBytes &&
    resolved?.attempt === attempt;
  // The cached file downloaded but the renderer couldn't decode it: drop it so
  // a retry downloads afresh, and report this attempt as failed.
  const resolvedAt = current ? resolved.at : undefined;
  const reportBroken = useCallback(() => {
    if (!url || resolvedAt === undefined) return;
    // Mark the attempt failed even if the delete itself fails.
    void evictRemoteMedia(url, maxBytes, resolvedAt, owner)
      .catch(() => undefined)
      .then(() =>
        setResolved((prev) =>
          prev && prev.owner === owner && prev.url === url && prev.attempt === attempt
            ? { ...prev, uri: null, failed: true, broken: true }
            : prev,
        ),
      );
  }, [owner, url, maxBytes, attempt, resolvedAt]);
  return {
    uri: current ? resolved.uri : null,
    failed: current && resolved.failed,
    broken: current && !!resolved.broken,
    permanent: current && !!resolved.permanent,
    retry,
    reportBroken,
  };
}

/** URI-only convenience for renderers without a retry control. */
export function useRemoteMediaUri(url: string | null, maxBytes: number): string | null {
  return useRemoteMedia(url, maxBytes).uri;
}

/**
 * useRemoteMedia that retries a failed download once by itself after a short
 * pause (a slow mobile link, or the app busy catching up on relays), then
 * leaves further retries to the user via `retry`.
 *
 * A URL that already ended in "tap to retry" this session for a reason a
 * retry won't fix (failedMediaMemory: an HTTP 4xx such as 404, too big, or
 * undecodable) isn't fetched again when a row showing it is recycled or
 * remounted: it shows "tap to retry" straight away, and the tap downloads it
 * afresh. Offline / timeout / 5xx failures aren't remembered, so a remount
 * after the connection returns still loads by itself.
 */
export function useRemoteMediaWithAutoRetry(url: string | null, maxBytes: number, delayMs = 3000) {
  // Whether this row skips fetching `url`, decided once per URL rather than
  // every render, so a row that's already loading or loaded never flips when
  // the URL is remembered meanwhile, and a recycled row re-decides for its
  // new URL. Cleared by the user's retry tap.
  const [skip, setSkip] = useState(() => ({ url, on: !!url && hasFailedMedia(url) }));
  let knownFailed = skip.on;
  if (skip.url !== url) {
    knownFailed = !!url && hasFailedMedia(url);
    setSkip({ url, on: knownFailed });
  }
  const media = useRemoteMedia(knownFailed ? null : url, maxBytes);
  const { failed, broken, permanent, retry: retryMedia } = media;
  const [autoRetried, setAutoRetried] = useState<string | null>(null);
  // Loading switched off (e.g. unfollowed): the next session gets its own retry.
  useEffect(() => {
    if (!url) setAutoRetried(null);
  }, [url]);
  useEffect(() => {
    // An undecodable file usually stays undecodable (an HTML page, an
    // unsupported format): re-downloading it unasked could cost up to the
    // full size limit again on mobile data, so that goes straight to "tap
    // to retry", which still downloads afresh.
    if (!failed || broken || !url || autoRetried === url) return;
    const timer = setTimeout(() => {
      setAutoRetried(url);
      retryMedia();
    }, delayMs);
    return () => clearTimeout(timer);
  }, [failed, broken, url, autoRetried, retryMedia, delayMs]);
  // Until the automatic retry has also failed, it's still loading.
  const gaveUp = failed && (broken || autoRetried === url);
  const remember = gaveUp && (broken || permanent);
  useEffect(() => {
    if (remember && url) rememberFailedMedia(url);
  }, [remember, url]);
  const retry = useCallback(() => {
    if (url) forgetFailedMedia(url);
    if (knownFailed && url) {
      // Nothing was fetched for this row yet: load it now, and count the tap
      // as this URL's one retry so a failure costs one download, not two.
      setSkip({ url, on: false });
      setAutoRetried(url);
      return;
    }
    retryMedia();
  }, [url, knownFailed, retryMedia]);
  if (knownFailed)
    return { ...media, uri: null, failed: true, broken: false, permanent: false, retry };
  return { ...media, failed: gaveUp, retry };
}
