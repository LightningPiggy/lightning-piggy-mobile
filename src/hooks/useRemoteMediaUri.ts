import { useCallback, useEffect, useState } from 'react';
import { useActivePubkey } from './useActivePubkey';
import { evictRemoteMedia, resolveRemoteMedia } from '../services/remoteMediaCache';

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
        () => {
          if (!cancelled)
            setResolved({ owner, url, maxBytes, attempt, uri: null, at: Date.now(), failed: true });
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
    void evictRemoteMedia(url, maxBytes, resolvedAt)
      .catch(() => undefined)
      .then(() =>
        setResolved((prev) =>
          prev && prev.owner === owner && prev.url === url && prev.attempt === attempt
            ? { ...prev, uri: null, failed: true }
            : prev,
        ),
      );
  }, [owner, url, maxBytes, attempt, resolvedAt]);
  return {
    uri: current ? resolved.uri : null,
    failed: current && resolved.failed,
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
 */
export function useRemoteMediaWithAutoRetry(url: string | null, maxBytes: number, delayMs = 3000) {
  const media = useRemoteMedia(url, maxBytes);
  const { failed, retry } = media;
  const [autoRetried, setAutoRetried] = useState<string | null>(null);
  // Loading switched off (e.g. unfollowed): the next session gets its own retry.
  useEffect(() => {
    if (!url) setAutoRetried(null);
  }, [url]);
  useEffect(() => {
    if (!failed || !url || autoRetried === url) return;
    const timer = setTimeout(() => {
      setAutoRetried(url);
      retry();
    }, delayMs);
    return () => clearTimeout(timer);
  }, [failed, url, autoRetried, retry, delayMs]);
  // Until the automatic retry has also failed, it's still loading.
  return { ...media, failed: failed && autoRetried === url };
}
