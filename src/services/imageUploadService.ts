import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { getBlossomServers } from './walletStorageService';
import {
  uploadEncryptedBlobToBlossom,
  uploadToBlossomServers,
  BlossomSigner,
} from './blossomService';
import { readAsStringAsync } from 'expo-file-system/legacy';
import { Buffer } from 'buffer';
import { encryptFile } from './encryptedFile';

const NOSTR_BUILD_UPLOAD_URL = 'https://nostr.build/api/v2/upload/files';

/**
 * Re-encode an image through expo-image-manipulator to drop every EXIF tag
 * (GPS coords, capture timestamp, camera make/model, …) before it leaves the
 * device. The fresh JPEG has no metadata chunks at all, so we don't need to
 * parse or allowlist individual tags.
 *
 * Base64 is requested up-front because Blossom uploads need it (reading
 * `file://` URIs is unreliable on Android in RN). If the native module fails
 * to return a base64 payload we throw so callers don't silently proceed with
 * a null value and fail deeper in the upload path.
 */
export async function stripImageMetadata(
  uri: string,
  pickerBase64?: string | null,
  options: { preserveGif?: boolean } = {},
): Promise<{ uri: string; base64: string }> {
  // GIF: skip the manipulator re-encode so animation survives. GIF89a has
  // no EXIF chunk (nothing analogous to JPEG APP1), so typical GIFs from
  // gallery / chat / meme sources carry no privacy-sensitive metadata.
  // Adobe-exported GIFs can embed XMP via an Application Extension Block —
  // if that becomes a real attack vector, swap in a pure-JS block walker
  // that drops comment/application extensions while keeping frames.
  //
  // We rely on the picker's `base64: true` output here because reading
  // file:// URIs via fetch/XHR is unreliable on Android RN (see the
  // comment in blossomService.ts).
  if (options.preserveGif !== false && /\.gif$/i.test(uri)) {
    if (!pickerBase64) {
      throw new Error(
        'GIF upload requires picker base64 — call launchImageLibraryAsync with base64: true',
      );
    }
    return { uri, base64: pickerBase64 };
  }

  // Preserve PNG → PNG re-encode (alpha channel survives; compress is a
  // no-op since PNG is lossless). All other inputs flatten to JPEG with
  // compress 0.9. Detect by extension — both the raw picker URI and the
  // crop-editor output on Android keep the source extension.
  //
  // Caveat: EditProfileSheet uses `allowsEditing: true`, which routes
  // through the OS crop editor; on most Androids that editor emits JPEG
  // regardless of input, so a transparent PNG avatar (or animated GIF)
  // may still arrive here as a .jpg — already flattened. Chat's gallery/
  // camera pickers (no `allowsEditing`) preserve the source extension.
  const isPng = /\.png$/i.test(uri);
  const result = await manipulateAsync(uri, [], {
    compress: 0.9,
    format: isPng ? SaveFormat.PNG : SaveFormat.JPEG,
    base64: true,
  });
  if (!result.base64) {
    throw new Error('Failed to strip image metadata: no base64 returned');
  }
  return { uri: result.uri, base64: result.base64 };
}

// Map a filename extension to the spec-correct MIME type. Required so
// that non-image blobs (e.g. `.m4a` voice notes from #235 that fall
// back to nostr.build when no Blossom signer is available) aren't
// uploaded as `image/m4a` — which nostr.build will either reject or
// serve with the wrong Content-Type, breaking inline playback in
// receiving clients.
function mimeFromExt(ext: string | undefined): string {
  if (!ext) return 'application/octet-stream';
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'gif':
      return 'image/gif';
    case 'webp':
      return 'image/webp';
    case 'm4a':
    case 'mp4':
      // expo-audio's HIGH_QUALITY preset writes AAC inside an MP4
      // container with a `.m4a` extension on iOS / Android.
      return 'audio/mp4';
    case 'aac':
      return 'audio/aac';
    case 'mp3':
      return 'audio/mpeg';
    case 'ogg':
    case 'opus':
      return 'audio/ogg';
    case 'wav':
      return 'audio/wav';
    default:
      // Unknown extension — `application/octet-stream` is the correct
      // "arbitrary bytes" type. Building `application/${ext}` would emit
      // non-standard types (e.g. `application/bin`) and mislabel the
      // nostr.build fallback's Content-Type.
      return 'application/octet-stream';
  }
}

export async function uploadToNostrBuild(fileUri: string): Promise<string> {
  const filename = fileUri.split('/').pop() || 'upload.bin';
  const match = /\.(\w+)$/.exec(filename);
  const ext = match?.[1]?.toLowerCase();
  const type = mimeFromExt(ext);

  const formData = new FormData();
  // React Native FormData accepts {uri, name, type} but TypeScript expects Blob
  formData.append('file', { uri: fileUri, name: filename, type } as unknown as Blob);

  const response = await fetch(NOSTR_BUILD_UPLOAD_URL, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    throw new Error(`Upload failed: ${response.status}`);
  }

  const data = await response.json();
  if (data.status !== 'success') {
    throw new Error('Upload failed: ' + (data.message || 'unknown error'));
  }

  // Validate and extract URL from NIP-94 tags
  if (!data.nip94_event || !Array.isArray(data.nip94_event.tags)) {
    throw new Error('Invalid response structure from nostr.build');
  }
  const urlTag = data.nip94_event.tags.find((t: string[]) => t[0] === 'url');
  if (!urlTag || !urlTag[1]) {
    throw new Error('No URL in upload response');
  }

  return urlTag[1];
}

/**
 * Read a local `file://` URI as base64 via expo-file-system, which reads
 * the file natively. Used by `uploadBlob` callers (voice notes from #235)
 * that don't have a picker handing them a base64 payload.
 *
 * The previous XHR + FileReader approach failed on Android for the audio
 * recorder's cache path (`Failed to read file://…/cache/Audio/…m4a`):
 * RN's XHR on `file://` URIs is unreliable, which is exactly why
 * `uploadToBlossom` insists on a base64 payload in the first place.
 * expo-file-system's native read sidesteps it (matches the base64 read
 * in HuntCreateScreen).
 */
export async function readFileAsBase64(fileUri: string): Promise<string> {
  const base64 = await readAsStringAsync(fileUri, { encoding: 'base64' });
  if (!base64) throw new Error(`Empty file: ${fileUri}`);
  return base64;
}

/**
 * Upload an arbitrary blob (image, audio, …) using the user's configured
 * Blossom server when a signer is available, falling back to nostr.build
 * otherwise. Blossom is content-addressed and MIME-agnostic — the same
 * pipeline that ships images works unchanged for `.m4a` voice notes
 * (#235), GIFs, etc.
 *
 * `base64` is optional. When the caller already has the bytes in memory
 * (e.g. expo-image-picker with `base64: true`) pass them through to skip
 * a redundant file read. When omitted, we read the file from disk via
 * expo-file-system (`readFileAsBase64`). nostr.build uploads always go
 * through the FormData `{uri, name, type}` path which doesn't need base64.
 */
export async function uploadBlob(
  fileUri: string,
  signer: BlossomSigner | null,
  base64?: string | null,
): Promise<string> {
  if (signer) {
    const servers = await getBlossomServers();
    const payload = base64 ?? (await readFileAsBase64(fileUri));
    return uploadToBlossomServers(fileUri, servers, signer, payload);
  }
  return uploadToNostrBuild(fileUri);
}

export interface EncryptedUpload {
  /** Blossom URL of the uploaded ciphertext. */
  url: string;
  /** Hex AES-256 key — goes in the kind-15 `decryption-key` tag. */
  keyHex: string;
  /** Hex GCM nonce — goes in the kind-15 `decryption-nonce` tag. */
  nonceHex: string;
  /** SHA-256 of the ciphertext — the `x` tag. */
  sha256Hex: string;
  filename?: string;
  /** Ciphertext byte length — the `size` tag. */
  size: number;
  /** Original (decrypted) mime — the `file-type` tag. */
  mime: string;
}

/**
 * Encrypt a file's bytes (AES-256-GCM) and upload the **ciphertext** to the
 * user's Blossom server, returning the URL plus the key/nonce the recipient
 * needs to decrypt. The server only ever stores ciphertext — the basis for
 * NIP-17 kind-15 encrypted voice notes (#235; images follow in #688).
 *
 * Requires a Blossom signer — the nostr.build fallback doesn't apply to
 * encrypted blobs (we always have a signer when sending a DM).
 */
export async function uploadEncryptedBlob(
  fileUri: string,
  signer: BlossomSigner,
  mime: string,
  base64?: string | null,
): Promise<EncryptedUpload> {
  const payload = base64 ?? (await readFileAsBase64(fileUri));
  const plaintext = new Uint8Array(Buffer.from(payload, 'base64'));
  const { ciphertext, keyHex, nonceHex, sha256Hex } = encryptFile(plaintext);
  const ciphertextBase64 = Buffer.from(ciphertext).toString('base64');
  const servers = await getBlossomServers();
  // Upload as opaque bytes — the blob is ciphertext, so the original mime
  // travels in the kind-15 `file-type` tag instead of the Content-Type.
  const url = await uploadEncryptedBlobToBlossom(fileUri, servers, signer, ciphertextBase64);
  return { url, keyHex, nonceHex, sha256Hex, size: ciphertext.length, mime };
}

/**
 * Image-specific alias for `uploadBlob`. Kept for legacy call sites
 * (image picker / camera / profile avatar) that consistently pass a
 * picker base64 payload — semantically the same as `uploadBlob`, but
 * the name documents the intent at the call site.
 */
export async function uploadImage(
  imageUri: string,
  signer: BlossomSigner | null,
  base64?: string | null,
): Promise<string> {
  return uploadBlob(imageUri, signer, base64);
}
