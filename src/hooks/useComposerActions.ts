import React, { useCallback, useEffect, useRef, useState } from 'react';
import * as ImagePicker from 'expo-image-picker';
import { Alert } from '../components/BrandedAlert';
import { useNostr, useNostrContacts } from '../contexts/NostrContext';
import {
  stripImageMetadata,
  readFileAsBase64,
  uploadEncryptedBlob,
  type EncryptedUpload,
} from '../services/imageUploadService';
import {
  getCurrentLocation,
  formatGeoMessage,
  type SharedLocation,
} from '../services/locationService';
import { nprofileEncode, buildProfileRelayHints } from '../services/nostrService';
import type { PickedFriend } from '../components/FriendPickerSheet';
import { giphyEnvelope, type Gif } from '../services/giphyService';
import { MARMOT_VOICE_MIME, marmotVoiceFilename, type MarmotImage } from '../services/marmotSend';
import { sendClearingDraft } from '../utils/composerDraft';
import { appendSharedText, type SharedImage } from '../utils/incomingShare';
import { useStagedShare } from './useStagedShare';

/**
 * The send-side behaviour that differs between the 1:1 and group composers —
 * the ONLY thing that differs. Everything else (gallery / camera / GIF /
 * contact / voice / location orchestration + permission prompts + in-flight
 * flags) is identical and lives in `useComposerActions` below.
 *
 * `sendText` / `sendFile` each own their optimistic local append (+ scroll):
 * the 1:1 wrapper appends a DM row via `appendLocalDmMessage`; the group
 * wrapper appends a `local_…` row via `appendGroupMessage`. Returning a boolean
 * lets the shared hook clear the draft / close the sheet only on success.
 */
export interface ComposerSendStrategy {
  /** Send a plaintext payload (message / GIF URL / geo / contact share). Owns
   *  the optimistic append. Returns true on success. */
  sendText: (text: string) => Promise<boolean>;
  /** Optional typed-message strategy; attachments continue through sendText. */
  sendMessage?: (text: string) => Promise<boolean>;
  /** Send an encrypted file (voice note or image, NIP-17 kind-15). Owns the
   *  optimistic append. Returns true on success. The `kind` lets the wrapper
   *  pick the right failure copy ("voice note" vs "image"). */
  sendFile: (file: EncryptedUpload, kind: 'voice' | 'image') => Promise<boolean>;
  /** Optional photo / voice-note sender that owns encryption + upload itself —
   *  a Marmot thread sends them the Marmot way (MIP-04), keyed by the MLS
   *  group, so they skip the AES-GCM upload. Owns the optimistic append. */
  sendImage?: (image: MarmotImage) => Promise<boolean>;
  /** Send GIFs in White Noise's two-line envelope (URL + `via GIPHY`) —
   *  Marmot threads, where White Noise only renders a GIF in that shape. */
  gifEnvelope?: boolean;
  /** Consent gate before a location send, supplied by both chat composers. */
  confirmLocation: (loc: SharedLocation) => Promise<boolean>;
  /** Optional preflight: return false when there's no valid send target (e.g.
   *  group/identity not loaded). Lets the shared hook skip an expensive
   *  encrypt + Blossom upload (voice / image) that would only fail downstream.
   *  Omit (1:1) to always allow. */
  canSend?: () => boolean;
}

export interface UseComposerActionsParams {
  strategy: ComposerSendStrategy;
  draft: string;
  setDraft: (value: string) => void;
  setAttachPanelOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setGifPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setContactPickerOpen: React.Dispatch<React.SetStateAction<boolean>>;
  setVoiceSheetOpen: React.Dispatch<React.SetStateAction<boolean>>;
  /** This chat's "Share to Lightning Piggy" key (#1692) — see `useStagedShare`. */
  shareTarget?: string | null;
}

/**
 * Shared composer send/upload/share orchestration for BOTH the 1:1
 * (ConversationScreen) and group (GroupConversationScreen) chats. The two used
 * to ship near-identical `useConversationComposerActions` /
 * `useGroupComposerActions` hooks (~90% duplicate, #235); this collapses the
 * shared 90% here and leaves each screen a thin wrapper that only provides its
 * `ComposerSendStrategy`. Owns the in-flight flags the composer reads.
 */
export function useComposerActions({
  strategy,
  draft,
  setDraft,
  setAttachPanelOpen,
  setGifPickerOpen,
  setContactPickerOpen,
  setVoiceSheetOpen,
  shareTarget = null,
}: UseComposerActionsParams) {
  const { isLoggedIn, signEvent, relays, pubkey } = useNostr();
  const { contacts } = useNostrContacts();

  const [sending, setSending] = useState(false);
  const [uploadingImage, setUploadingImage] = useState(false);
  const [sharingLocation, setSharingLocation] = useState(false);
  const [uploadingVoice, setUploadingVoice] = useState(false);

  const closeAttachPanel = useCallback(() => setAttachPanelOpen(false), [setAttachPanelOpen]);

  // Latest input text, for restoring a draft without clobbering new typing.
  const draftRef = useRef(draft);
  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  // The input clears as soon as Send is tapped (the optimistic bubble is
  // already showing) and the text comes back if nothing was sent — a failed
  // send, or a cancelled NIP-17 fallback — unless the user has typed since.
  const handleSend = useCallback(async () => {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    try {
      await sendClearingDraft(
        draft,
        {
          get: () => draftRef.current,
          set: (value) => {
            draftRef.current = value;
            setDraft(value);
          },
        },
        () => (strategy.sendMessage ?? strategy.sendText)(text),
      );
    } finally {
      setSending(false);
    }
  }, [draft, sending, strategy, setDraft]);

  // Shared gallery/camera path (#688): strip EXIF, then encrypt the scrubbed
  // image on-device (AES-256-GCM) and upload the CIPHERTEXT to Blossom — so the
  // server never holds the image in the clear — and send it as a NIP-17 kind-15
  // file message, exactly like voice notes. The recipient's MessageBubble
  // fetches + decrypts. (Legacy plaintext image URLs from other clients still
  // render via parseImageMessage's plain branch — only the SEND side changed.)
  const uploadAndSendImage = useCallback(
    async (localUri: string, pickerBase64?: string | null): Promise<boolean> => {
      setUploadingImage(true);
      try {
        const scrubbed = await stripImageMetadata(localUri, pickerBase64);
        // stripImageMetadata flattens to JPEG, preserving PNG → PNG and passing
        // GIFs through untouched (so animation survives); the scrubbed uri keeps
        // the resulting extension, so derive the mime from it.
        const mime = /\.png$/i.test(scrubbed.uri)
          ? 'image/png'
          : /\.gif$/i.test(scrubbed.uri)
            ? 'image/gif'
            : 'image/jpeg';
        if (strategy.sendImage) {
          return await strategy.sendImage({ uri: scrubbed.uri, base64: scrubbed.base64, mime });
        }
        const file = await uploadEncryptedBlob(scrubbed.uri, signEvent, mime, scrubbed.base64);
        return await strategy.sendFile(file, 'image');
      } catch (error) {
        Alert.alert('Upload failed', error instanceof Error ? error.message : 'Please try again.');
        return false;
      } finally {
        setUploadingImage(false);
      }
    },
    [signEvent, strategy],
  );

  const handlePickAndSendImage = useCallback(async () => {
    if (!isLoggedIn || uploadingImage || sending || strategy.canSend?.() === false) return;
    closeAttachPanel();
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission needed', 'Allow photo library access to send images.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 1,
      // Needed so stripImageMetadata can pass animated GIFs through without
      // re-encoding (expo-image-manipulator has no animated output). No-op for
      // JPEG/PNG — those get re-encoded.
      base64: true,
    });
    if (result.canceled || !result.assets?.[0]) return;
    await uploadAndSendImage(result.assets[0].uri, result.assets[0].base64);
  }, [isLoggedIn, uploadingImage, sending, strategy, closeAttachPanel, uploadAndSendImage]);

  const handleTakeAndSendPhoto = useCallback(async () => {
    if (!isLoggedIn || uploadingImage || sending || strategy.canSend?.() === false) return;
    closeAttachPanel();
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Permission needed', 'Allow camera access to take and send photos.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({
      mediaTypes: ['images'],
      quality: 1,
      base64: true,
    });
    if (result.canceled || !result.assets?.[0]) return;
    await uploadAndSendImage(result.assets[0].uri, result.assets[0].base64);
  }, [isLoggedIn, uploadingImage, sending, strategy, closeAttachPanel, uploadAndSendImage]);

  // An image shared in from another app (#1692), sent only on the user's tap.
  // Same path as the gallery (metadata stripped, re-encoded unless a GIF). Its
  // type was sniffed from its bytes; GIFs pass through, so read them here the
  // way the picker's `base64: true` would.
  const sendSharedImage = useCallback(
    async (image: SharedImage) => {
      if (!isLoggedIn || sending || strategy.canSend?.() === false) return false;
      const gifBase64 =
        image.mimeType === 'image/gif' ? await readFileAsBase64(image.uri) : undefined;
      return uploadAndSendImage(image.uri, gifBase64);
    },
    [isLoggedIn, sending, strategy, uploadAndSendImage],
  );
  const appendSharedTextToDraft = useCallback(
    (text: string) => {
      draftRef.current = appendSharedText(draftRef.current, text);
      setDraft(draftRef.current);
    },
    [setDraft],
  );
  const stagedShare = useStagedShare({
    target: shareTarget,
    owner: pubkey,
    appendText: appendSharedTextToDraft,
    sendImage: sendSharedImage,
  });

  const handleShareLocation = useCallback(async () => {
    if (sharingLocation || strategy.canSend?.() === false) return;
    closeAttachPanel();
    setSharingLocation(true);
    try {
      const result = await getCurrentLocation();
      if (!result.ok) {
        Alert.alert('Could not share location', result.message);
        return;
      }
      const proceed = await strategy.confirmLocation(result.location);
      if (proceed) await strategy.sendText(formatGeoMessage(result.location));
    } finally {
      setSharingLocation(false);
    }
  }, [sharingLocation, closeAttachPanel, strategy]);

  const handleSendGif = useCallback(
    async (gif: Gif) => {
      setGifPickerOpen(false);
      closeAttachPanel();
      await strategy.sendText(strategy.gifEnvelope ? giphyEnvelope(gif.url) : gif.url);
    },
    [closeAttachPanel, strategy, setGifPickerOpen],
  );

  // Share another contact's Nostr profile. Payload mirrors the
  // ContactProfileSheet "Share with friend" format: a human-readable first line
  // plus a NIP-21 `nostr:nprofile…` URI other clients render as a mention.
  const handleShareContactPicked = useCallback(
    async (friend: PickedFriend) => {
      setContactPickerOpen(false);
      closeAttachPanel();
      const readRelays = relays.filter((r) => r.read).map((r) => r.url);
      const relayHints = buildProfileRelayHints(friend.pubkey, contacts, readRelays);
      const nprofile = nprofileEncode(friend.pubkey, relayHints);
      const label = friend.name || 'a contact';
      await strategy.sendText(`Shared contact: ${label}\nnostr:${nprofile}`);
    },
    [closeAttachPanel, contacts, relays, strategy, setContactPickerOpen],
  );

  // Voice-note send (#235): encrypt the recorded .m4a on-device (AES-256-GCM),
  // upload the CIPHERTEXT to Blossom, then send a NIP-17 kind-15 file message —
  // or, in a Marmot thread, MIP-04 media (kind 9 + `imeta`).
  const handleSendVoiceNote = useCallback(
    async (uri: string, durationMs = 0) => {
      // Preflight BEFORE the expensive encrypt + Blossom upload: bail if a send
      // is already in flight or there's no valid target (group not loaded).
      if (uploadingVoice || strategy.canSend?.() === false) return false;
      setUploadingVoice(true);
      try {
        let ok: boolean;
        if (strategy.sendImage) {
          // Marmot thread: MIP-04 media like photos, so White Noise shows a player.
          ok = await strategy.sendImage({
            uri,
            base64: await readFileAsBase64(uri),
            mime: MARMOT_VOICE_MIME,
            filename: marmotVoiceFilename(durationMs),
          });
        } else {
          ok = await strategy.sendFile(
            await uploadEncryptedBlob(uri, signEvent, 'audio/mp4'),
            'voice',
          );
        }
        if (!ok) return false;
        setVoiceSheetOpen(false);
        closeAttachPanel();
        return true;
      } catch (error) {
        Alert.alert('Upload failed', error instanceof Error ? error.message : 'Please try again.');
        return false;
      } finally {
        setUploadingVoice(false);
      }
    },
    [uploadingVoice, signEvent, strategy, setVoiceSheetOpen, closeAttachPanel],
  );

  return {
    sending,
    uploadingImage,
    sharingLocation,
    uploadingVoice,
    handleSend,
    handlePickAndSendImage,
    handleTakeAndSendPhoto,
    handleShareLocation,
    handleSendGif,
    handleShareContactPicked,
    handleSendVoiceNote,
    stagedShare,
  };
}
