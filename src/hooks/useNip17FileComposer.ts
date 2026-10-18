import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { getActivePubkey } from '../services/walletStorageService';
import { Buffer } from 'buffer';
import { Alert } from '../components/BrandedAlert';
import { useTranslation } from '../contexts/LocaleContext';
import { useNostr } from '../contexts/NostrContext';
import type { DmProtocol } from '../utils/dmProtocol';
import { sanitizeAttachmentText } from '../utils/fileAttachment';
import { selectedDocumentName } from '../services/documentMetadata';
import type { EncryptedUpload } from '../services/imageUploadService';

export const MAX_UPLOAD_BYTES = 16 * 1024 * 1024;

/** Keep the system picker, local reads and upload off the chat startup path. */
export function useNip17FileComposer(
  protocol: DmProtocol,
  send: (file: EncryptedUpload, kind: 'file', protocol: DmProtocol) => Promise<boolean>,
  setPanelOpen: (open: boolean) => void,
  canSend?: () => boolean,
  targetId?: string,
) {
  const t = useTranslation();
  const { isLoggedIn, pubkey, signEvent } = useNostr();
  const latest = useRef({ isLoggedIn, pubkey, protocol, send, canSend, targetId });
  useLayoutEffect(() => {
    latest.current = { isLoggedIn, pubkey, protocol, send, canSend, targetId };
  }, [isLoggedIn, pubkey, protocol, send, canSend, targetId]);
  const mounted = useRef(false);
  useLayoutEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const [uploading, setUploading] = useState(false);
  const pickFile = useCallback(async () => {
    // Picker and upload may outlive an identity, conversation or roster update.
    // Keep the original identity/target, but use the latest authorized send.
    const authorized = () => {
      const current = latest.current;
      return (
        mounted.current &&
        !!pubkey &&
        current.isLoggedIn &&
        current.pubkey === pubkey &&
        getActivePubkey() === pubkey &&
        current.targetId === targetId &&
        current.protocol === 'nip17' &&
        current.canSend?.() !== false
      );
    };
    if (uploading || protocol !== 'nip17' || !authorized()) return;
    setPanelOpen(false);
    setUploading(true);
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { File, Paths } = require('expo-file-system') as typeof import('expo-file-system');
      const upload: typeof import('../services/imageUploadService') =
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('../services/imageUploadService');
      const result = await File.pickFileAsync();
      const file = Array.isArray(result) ? result[0] : result;
      if (!file) return;
      let preparedUri: string | undefined;
      try {
        if (!authorized()) return;
        // Bound JS encryption/base64 memory before reading, then check actual
        // bytes as well: provider metadata is not authoritative.
        if (file.size <= 0 || file.size > MAX_UPLOAD_BYTES) throw new RangeError('File size');
        const base64 = await file.base64();
        const size = Buffer.byteLength(base64, 'base64');
        if (size <= 0 || size > MAX_UPLOAD_BYTES) throw new RangeError('File size');
        const filename = sanitizeAttachmentText(await selectedDocumentName(file));
        if (!authorized()) return;
        // Lazy-load byte parsing/native fallback only after the user picks a file.
        const { prepareFileAttachment } =
          // eslint-disable-next-line @typescript-eslint/no-require-imports
          require('../services/fileAttachmentMetadata') as typeof import('../services/fileAttachmentMetadata');
        const prepared = await prepareFileAttachment(
          file.uri,
          base64,
          file.type || 'application/octet-stream',
          filename,
        );
        preparedUri = prepared.uri;
        if (!authorized()) return;
        if (Buffer.byteLength(prepared.base64, 'base64') > MAX_UPLOAD_BYTES) {
          throw new RangeError('File size');
        }
        const started = performance.now();
        const uploaded = await upload.uploadEncryptedBlob(
          prepared.uri,
          async (...args) => {
            if (!authorized()) throw new Error('File picking was cancelled: target changed');
            return signEvent(...args);
          },
          prepared.mime,
          prepared.base64,
        );
        if (__DEV__ || process.env.EXPO_PUBLIC_KEEP_PERF_LOGS === '1') {
          console.log(
            `[PerfBlock] file encrypt+upload bytes=${size} ms=${(performance.now() - started).toFixed(1)}`,
          );
        }
        if (!authorized()) return;
        await latest.current.send({ ...uploaded, filename: prepared.filename }, 'file', 'nip17');
      } finally {
        // iOS returns a temporary copy. Never delete the user's original.
        if (preparedUri && preparedUri !== file.uri && preparedUri.startsWith(Paths.cache.uri)) {
          new File(preparedUri).delete();
        }
        if (file.uri.startsWith(Paths.cache.uri)) file.delete();
      }
    } catch (error) {
      if (error instanceof Error && /cancelled|canceled/i.test(error.message)) return;
      Alert.alert(
        t('messageBubble.file'),
        t(
          error instanceof RangeError
            ? 'messageBubble.fileUploadLimit'
            : 'messageBubble.fileShareFailed',
        ),
      );
    } finally {
      setUploading(false);
    }
  }, [uploading, pubkey, protocol, targetId, setPanelOpen, signEvent, t]);
  return { uploading, pickFile: protocol === 'nip17' ? pickFile : undefined };
}
