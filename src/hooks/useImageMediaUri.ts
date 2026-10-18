import { useEffect, useRef, useState } from 'react';
import { useActivePubkey } from './useActivePubkey';
import {
  captureDecryptedMediaSession,
  DecryptedMediaCancelledError,
  peekDecryptedMedia,
  resolveDecryptedMedia,
  type EncryptedMediaRef,
} from '../services/decryptedMediaCache';
import { resolveRemoteMedia } from '../services/remoteMediaCache';
import { checkRemoteUrl } from '../utils/remoteUrlPolicy';

/** Image resolution shared by chat bubbles and attachment thumbnails. */
export function useImageMediaUri(
  ref: EncryptedMediaRef,
  encrypted: boolean,
  enabled = true,
  onResolved?: (uri: string) => void,
) {
  const owner = useActivePubkey();
  const identity = JSON.stringify([owner, ref, encrypted]);
  const currentRef = useRef(ref);
  currentRef.current = ref;
  const allowed = enabled && checkRemoteUrl(ref.url, { kind: 'media' }).ok;
  const [state, setState] = useState(() => ({
    identity,
    uri: allowed && encrypted ? peekDecryptedMedia(ref) : null,
    failed: false,
  }));
  useEffect(() => {
    let cancelled = false;
    setState({ identity, uri: null, failed: false });
    if (allowed) {
      const session = captureDecryptedMediaSession(owner);
      const media = currentRef.current;
      if (encrypted && ((!media.keyHex && !media.marmot) || !media.nonceHex)) {
        setState({ identity, uri: null, failed: true });
      } else {
        const memo = encrypted ? peekDecryptedMedia(media) : null;
        if (memo) {
          setState({ identity, uri: memo, failed: false });
          onResolved?.(memo);
        } else {
          void (
            encrypted ? resolveDecryptedMedia(media, session.owner) : resolveRemoteMedia(media.url)
          ).then(
            (uri) => {
              if (cancelled) return;
              try {
                session.assertCurrent();
              } catch {
                return;
              }
              setState({ identity, uri, failed: false });
              onResolved?.(uri);
            },
            (error) => {
              if (cancelled || error instanceof DecryptedMediaCancelledError) return;
              setState({ identity, uri: null, failed: true });
            },
          );
        }
      }
    }
    return () => {
      cancelled = true;
    };
  }, [owner, identity, allowed, encrypted, onResolved]);
  // Hide the old account's URI during render, before effect cleanup runs.
  return state.identity === identity && allowed
    ? { uri: state.uri, failed: state.failed }
    : { uri: null, failed: false };
}
