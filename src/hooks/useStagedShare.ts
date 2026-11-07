import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { subscribePendingShare, takePendingShare } from '../services/pendingShareStore';
import { deleteShareCopies } from '../services/sharedFiles';
import type { SharedImage } from '../utils/incomingShare';

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
 * the draft (after anything already typed), images wait above the composer
 * until the user taps Send. Nothing is sent from here on its own.
 *
 * Staged images are dropped (and their copies deleted) when the chat closes or
 * the active account changes, so a share never outlives the chat or crosses to
 * another identity.
 */
export function useStagedShare({
  target,
  owner,
  appendText,
  sendImage,
}: {
  /** `dmShareTarget(pubkey)` / `groupShareTarget(groupId)`; null until known. */
  target: string | null;
  /** Active account's hex pubkey; null while signed out. */
  owner: string | null;
  appendText: (text: string) => void;
  /** The chat's image send (strip metadata → upload → send); true when sent. */
  sendImage: (image: SharedImage) => Promise<boolean>;
}): StagedShare | null {
  const [images, setImages] = useState<SharedImage[]>([]);
  const [sending, setSending] = useState(false);
  const imagesRef = useRef(images);
  const latest = useRef({ appendText, sendImage });
  useLayoutEffect(() => {
    imagesRef.current = images;
    latest.current = { appendText, sendImage };
  });

  useEffect(() => {
    if (!target || !owner) return;
    const consume = () => {
      const share = takePendingShare(target, owner);
      if (!share) return;
      if (share.text) latest.current.appendText(share.text);
      if (share.images.length > 0) setImages((prev) => [...prev, ...share.images]);
    };
    consume();
    const unsubscribe = subscribePendingShare(consume);
    return () => {
      unsubscribe();
      // Chat closed or account switched: keep nothing.
      deleteShareCopies(imagesRef.current.map((image) => image.uri));
      imagesRef.current = [];
      setImages([]);
    };
  }, [target, owner]);

  const sendingRef = useRef(false);
  const onSend = useCallback(() => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    void (async () => {
      try {
        for (const image of [...imagesRef.current]) {
          if (!(await latest.current.sendImage(image))) break;
          deleteShareCopies([image.uri]);
          imagesRef.current = imagesRef.current.filter((i) => i.uri !== image.uri);
          setImages(imagesRef.current);
        }
      } finally {
        sendingRef.current = false;
        setSending(false);
      }
    })();
  }, []);

  const onRemove = useCallback((uri: string) => {
    if (sendingRef.current) return;
    deleteShareCopies([uri]);
    imagesRef.current = imagesRef.current.filter((image) => image.uri !== uri);
    setImages(imagesRef.current);
  }, []);

  return images.length > 0 ? { images, sending, onSend, onRemove } : null;
}
