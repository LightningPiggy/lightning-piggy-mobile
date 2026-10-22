import { useCallback, useEffect, useState } from 'react';
import {
  captureDecryptedMediaSession,
  DecryptedMediaCancelledError,
} from '../services/decryptedMediaCache';
import { useActivePubkey } from './useActivePubkey';
import type { FileAttachment } from '../utils/fileAttachment';

/** `none`: nothing to show (too big, not a PDF, couldn't render) — the
 * bubble falls back to its file icon. `failed`: the download or decrypt
 * failed, so `retry` is worth offering. */
export type PdfPreviewStatus = 'idle' | 'loading' | 'ready' | 'none' | 'failed';

export interface PdfPreview {
  uri: string | null;
  status: PdfPreviewStatus;
  retry: () => void;
}

export function usePdfPreview(file: FileAttachment, enabled: boolean): PdfPreview {
  const owner = useActivePubkey();
  const [attempt, setAttempt] = useState(0);
  const identity = JSON.stringify([owner, file, attempt]);
  const [result, setResult] = useState<{
    identity: string;
    uri: string | null;
    failed: boolean;
  } | null>(null);
  useEffect(() => {
    let cancelled = false;
    if (enabled) {
      const session = captureDecryptedMediaSession(owner);
      void Promise.resolve()
        .then(() => {
          if (cancelled) return null;
          const { resolvePdfPreview }: typeof import('../services/pdfPreview') =
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            require('../services/pdfPreview');
          session.assertCurrent();
          return resolvePdfPreview(file, owner, session);
        })
        .then(
          (uri) => {
            if (!cancelled) setResult({ identity, uri, failed: false });
          },
          (error) => {
            if (cancelled) return;
            // The session ended (account switch or cache wipe): settle as no
            // preview rather than spin; a new owner re-runs this effect.
            const ended = error instanceof DecryptedMediaCancelledError;
            setResult({ identity, uri: null, failed: !ended });
          },
        );
    }
    return () => {
      cancelled = true;
    };
    // File identity includes every field without requiring a stable parsed object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, enabled]);
  const retry = useCallback(() => setAttempt((n) => n + 1), []);
  const current = enabled && result?.identity === identity ? result : null;
  const status: PdfPreviewStatus = !enabled
    ? 'idle'
    : !current
      ? 'loading'
      : current.failed
        ? 'failed'
        : current.uri
          ? 'ready'
          : 'none';
  return { uri: current?.uri ?? null, status, retry };
}
