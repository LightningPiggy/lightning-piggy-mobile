import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { AppState, InteractionManager, Platform } from 'react-native';
import { useShareIntent } from 'expo-share-intent';
import { Alert } from './BrandedAlert';
import { Toast } from './BrandedToast';
import { useNostr } from '../contexts/NostrContext';
import { useTranslation } from '../contexts/LocaleContext';
import { clearPendingShare, PENDING_SHARE_TTL_MS } from '../services/pendingShareStore';
import {
  deleteShareCopies,
  shareDirUri,
  sweepStaleSharedFiles,
  verifySharedImages,
  wipeSharedFiles,
} from '../services/sharedFiles';
import {
  hasShareContent,
  normalizeShareIntent,
  shareCopies,
  type IncomingShare,
} from '../utils/incomingShare';

// The picker (friend list, recent chats, navigation) only loads once
// something is actually shared — never on the cold-start path.
const ShareTargetSheet = React.lazy(() => import('./ShareTargetSheet'));

/** A share that opens the app cold arrives before the stored session has
 *  been restored; give sign-in this long before saying "sign in first". */
const SIGNED_OUT_GRACE_MS = 4000;

interface Incoming {
  id: number;
  share: IncomingShare;
}

/**
 * "Share to Lightning Piggy" (#1692, Android). Receives text and images other
 * apps share to Lightning Piggy, checks them (`normalizeShareIntent` +
 * `verifySharedImages`: owned copies only, type from the bytes, size and
 * count capped) and opens the "Send to…" picker. Nothing is ever sent from
 * here — the chosen chat's composer is prefilled and the user taps Send.
 *
 * Signed out: says so and keeps nothing. Shared copies are deleted when the
 * share is dismissed, sent or dropped, and the whole share folder is wiped
 * when the active account changes (sign-out or switch).
 */
const ShareIntentHost: React.FC = () => {
  const t = useTranslation();
  const { isLoggedIn, pubkey } = useNostr();
  const { hasShareIntent, shareIntent, resetShareIntent, error } = useShareIntent({
    disabled: Platform.OS !== 'android',
  });
  const resetRef = useRef(resetShareIntent);
  resetRef.current = resetShareIntent;
  const [incoming, setIncomingState] = useState<Incoming | null>(null);
  const incomingRef = useRef<Incoming | null>(null);
  const setIncoming = useCallback((next: Incoming | null) => {
    incomingRef.current = next;
    setIncomingState(next);
  }, []);
  const nextId = useRef(0);

  // Leftovers from a share that was never finished: swept on start (the app
  // was killed mid-share) and whenever the app goes to the background. Copies
  // of a share that is still open or staged are kept (see `sharedFiles`).
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    const handle = InteractionManager.runAfterInteractions(() =>
      sweepStaleSharedFiles(PENDING_SHARE_TTL_MS),
    );
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'background') sweepStaleSharedFiles(PENDING_SHARE_TTL_MS);
    });
    return () => {
      handle.cancel();
      sub.remove();
    };
  }, []);

  const drop = useCallback((share: IncomingShare) => {
    deleteShareCopies(shareCopies(share));
  }, []);

  // A new share from the OS: check it and hold it for the picker.
  useEffect(() => {
    if (!hasShareIntent) return;
    resetRef.current();
    const checked = verifySharedImages(normalizeShareIntent(shareIntent, shareDirUri()));
    deleteShareCopies(checked.discard);
    const sharedFiles = shareIntent.files?.length ?? 0;
    if (!hasShareContent(checked)) {
      Toast.show({ type: 'info', text1: t('shareIntent.nothingToShare') });
      return;
    }
    if (checked.images.length < sharedFiles) {
      Toast.show({ type: 'info', text1: t('shareIntent.someSkipped') });
    }
    // A second share while the picker is open replaces the first.
    if (incomingRef.current) drop(incomingRef.current.share);
    nextId.current += 1;
    setIncoming({ id: nextId.current, share: { ...checked, discard: [] } });
    // `t` is read for the toast copy only; a locale change mustn't replay a share.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasShareIntent, shareIntent]);

  // The native module rejected everything it was handed (unsupported type,
  // too large, unreadable). Its message may name the file: never shown or
  // logged.
  useEffect(() => {
    if (!error) return;
    resetRef.current();
    Toast.show({ type: 'info', text1: t('shareIntent.nothingToShare') });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error]);

  // Signed out (after a short grace for a cold start's session restore):
  // say so and keep nothing.
  const signedIn = isLoggedIn && !!pubkey;
  useEffect(() => {
    if (!incoming || signedIn) return;
    const timer = setTimeout(() => {
      drop(incoming.share);
      setIncoming(null);
      Alert.alert(t('shareIntent.signedOutTitle'), t('shareIntent.signedOutMessage'));
    }, SIGNED_OUT_GRACE_MS);
    return () => clearTimeout(timer);
  }, [incoming, signedIn, drop, setIncoming, t]);

  // Active account changed (sign-out or switch): nothing shared may cross to
  // another identity — drop the open picker, the staged share and every copy.
  const previousPubkey = useRef(pubkey);
  useEffect(() => {
    const previous = previousPubkey.current;
    previousPubkey.current = pubkey;
    if (!previous || previous === pubkey) return;
    setIncoming(null);
    clearPendingShare();
    wipeSharedFiles();
  }, [pubkey, setIncoming]);

  const handleDone = useCallback(
    (picked: boolean) => {
      const current = incomingRef.current;
      if (current && !picked) drop(current.share);
      setIncoming(null);
    },
    [drop, setIncoming],
  );

  if (!incoming || !signedIn || !pubkey) return null;
  return (
    <Suspense fallback={null}>
      <ShareTargetSheet
        key={incoming.id}
        share={incoming.share}
        owner={pubkey}
        onDone={handleDone}
      />
    </Suspense>
  );
};

export default ShareIntentHost;
