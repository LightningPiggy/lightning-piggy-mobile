import { useEffect, useState } from 'react';
import { captureDecryptedMediaSession } from '../services/decryptedMediaCache';
import { useActivePubkey } from './useActivePubkey';
import type { FileAttachment } from '../utils/fileAttachment';

export function usePdfPreview(file: FileAttachment, enabled: boolean) {
  const owner = useActivePubkey();
  const identity = JSON.stringify([owner, file]);
  const [result, setResult] = useState<{ identity: string; uri: string | null } | null>(null);
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
            if (!cancelled) setResult({ identity, uri });
          },
          () => {},
        );
    }
    return () => {
      cancelled = true;
    };
    // File identity includes every field without requiring a stable parsed object.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity, enabled]);
  return enabled && result?.identity === identity ? result.uri : null;
}
