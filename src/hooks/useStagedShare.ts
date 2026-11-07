import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Toast } from '../components/BrandedToast';
import { useTranslation } from '../contexts/LocaleContext';
import { subscribePendingShare, takePendingShare } from '../services/pendingShareStore';
import { deleteShareCopies } from '../services/sharedFiles';
import { mergeStagedImages, shareChatOf, type SharedImage } from '../utils/incomingShare';

/** What the composer shows for images shared from another app (#1692). */
export interface StagedShare {
  images: SharedImage[];
  sending: boolean;
  /** Send the staged images, in order, through the chat's normal image path. */
  onSend: () => void;
  onRemove: (uri: string) => void;
}

/**
 * Takes a share staged for this chat by the share picker: the text goes into
 * the draft (`appendText`), images wait above the composer until the user taps
 * Send. Nothing is sent from here on its own. The tray holds at most
 * `MAX_SHARED_IMAGES`, however many shares land in it.
 *
 * Staged images are dropped (and their copies deleted) when the chat closes or
 * the active account changes, so a share never outlives the chat or crosses to
 * another identity. They stay through an in-place protocol switch of the same
 * chat (the Marmot → NIP-17 fallback), which may happen mid-send.
 */
export function useStagedShare({
  target,
  owner,
  appendText,
  sendImage,
}: {
  /** `dmShareTarget(pubkey, protocol)` / `groupShareTarget(groupId)`; null until known. */
  target: string | null;
  /** Active account's hex pubkey; null while signed out. */
  owner: string | null;
  appendText: (text: string) => void;
  /** The chat's image send (strip metadata → upload → send); true when sent. */
  sendImage: (image: SharedImage) => Promise<boolean>;
}): StagedShare | null {
  const t = useTranslation();
  const [images, setImages] = useState<SharedImage[]>([]);
  const [sending, setSending] = useState(false);
  const imagesRef = useRef(images);
  const latest = useRef({ appendText, sendImage, t });
  useLayoutEffect(() => {
    imagesRef.current = images;
    latest.current = { appendText, sendImage, t };
  });
  // Bumped whenever the staged images are dropped: a send loop that started
  // before (another chat, another account) must not carry on.
  const generation = useRef(0);

  const replaceImages = useCallback((next: SharedImage[]) => {
    imagesRef.current = next;
    setImages(next);
  }, []);

  // Lifetime: one chat, one account.
  const chat = target ? shareChatOf(target) : null;
  useEffect(() => {
    if (!chat || !owner) return;
    return () => {
      // Chat closed or account switched: keep nothing.
      generation.current += 1;
      deleteShareCopies(imagesRef.current.map((image) => image.uri));
      replaceImages([]);
    };
  }, [chat, owner, replaceImages]);

  // Taking: shares staged for the thread this chat is showing now.
  useEffect(() => {
    if (!target || !owner) return;
    const consume = () => {
      const share = takePendingShare(target, owner);
      if (!share) return;
      if (share.text) latest.current.appendText(share.text);
      if (share.images.length === 0) return;
      const merged = mergeStagedImages(imagesRef.current, share.images);
      if (merged.dropped.length > 0) {
        deleteShareCopies(merged.dropped.map((image) => image.uri));
        Toast.show({ type: 'info', text1: latest.current.t('shareIntent.someSkipped') });
      }
      replaceImages(merged.images);
    };
    consume();
    return subscribePendingShare(consume);
  }, [target, owner, replaceImages]);

  const sendingRef = useRef(false);
  const onSend = useCallback(() => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    const started = generation.current;
    const stillStaged = (image: SharedImage) =>
      generation.current === started && imagesRef.current.some((i) => i.uri === image.uri);
    void (async () => {
      try {
        for (const image of [...imagesRef.current]) {
          if (!stillStaged(image)) break;
          const sent = await latest.current.sendImage(image);
          // Dropped meanwhile (chat closed, account switched): the rest of the
          // batch is gone and must not reach another account's sender.
          if (generation.current !== started || !sent) break;
          deleteShareCopies([image.uri]);
          replaceImages(imagesRef.current.filter((i) => i.uri !== image.uri));
        }
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    })();
  }, [replaceImages]);

  const onRemove = useCallback(
    (uri: string) => {
      if (sendingRef.current) return;
      deleteShareCopies([uri]);
      replaceImages(imagesRef.current.filter((image) => image.uri !== uri));
    },
    [replaceImages],
  );

  return images.length > 0 ? { images, sending, onSend, onRemove } : null;
}
