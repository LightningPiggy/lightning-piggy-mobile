import {
  isOwnedShareCopy,
  MAX_SHARED_IMAGE_BYTES,
  renamedForMime,
  SHARE_DIR_NAME,
  sniffImageMime,
  type IncomingShare,
  type SharedImage,
} from '../utils/incomingShare';

/**
 * The files behind "Share to Lightning Piggy" (#1692). The native share module
 * copies each shared image into `<cache>/lp-share/`; this module checks those
 * copies by their bytes and deletes them once they're sent or dropped. Nothing
 * outside that folder is ever touched.
 */

// Lazy so the share host (mounted at app start) doesn't pull the file-system
// module onto the cold-start path; it only loads once something is shared.
function fileSystem(): typeof import('expo-file-system') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('expo-file-system') as typeof import('expo-file-system');
}

/** Enough leading bytes for every signature `sniffImageMime` knows. */
const SNIFF_BYTES = 16;

/** `file://` URI of the folder the share module copies into. */
export function shareDirUri(): string | null {
  try {
    const { Directory, Paths } = fileSystem();
    const uri = new Directory(Paths.cache, SHARE_DIR_NAME).uri;
    return uri.endsWith('/') ? uri : `${uri}/`;
  } catch {
    return null;
  }
}

/**
 * Check one copy: it must exist, be within the size cap and be an image we can
 * send by its bytes. A copy whose extension doesn't match its real type is
 * renamed (the composer's image path picks PNG / GIF handling by extension).
 * Returns null when the copy fails a check — the caller deletes it.
 */
function verifyOne(image: SharedImage, root: string): SharedImage | null {
  const { File } = fileSystem();
  const file = new File(image.uri);
  if (!file.exists || file.size <= 0 || file.size > MAX_SHARED_IMAGE_BYTES) return null;
  const handle = file.open();
  let head: Uint8Array;
  try {
    head = handle.readBytes(SNIFF_BYTES);
  } finally {
    handle.close();
  }
  const mime = sniffImageMime(head);
  if (!mime) return null;
  const name = image.uri.slice(root.length);
  const renamed = renamedForMime(name, mime);
  if (!renamed) return { uri: image.uri, mimeType: mime };
  file.rename(renamed);
  return { uri: `${root}${renamed}`, mimeType: mime };
}

/**
 * Keep only the shared images that pass `verifyOne`, with their sniffed type;
 * the rest move to `discard` so they're deleted with the share.
 */
export function verifySharedImages(share: IncomingShare): IncomingShare {
  const root = shareDirUri();
  if (!root) return { ...share, images: [], discard: [...share.discard] };
  const images: SharedImage[] = [];
  const discard = [...share.discard];
  for (const image of share.images) {
    let checked: SharedImage | null = null;
    try {
      if (isOwnedShareCopy(image.uri, root)) checked = verifyOne(image, root);
    } catch {
      checked = null;
    }
    if (checked) images.push(checked);
    else discard.push(image.uri);
  }
  return { text: share.text, images, discard };
}

/**
 * Delete the copies made for a share once they're sent or dropped, so nothing
 * shared outlives its chat. Only touches copies the share module created.
 */
export function deleteShareCopies(uris: readonly string[]): void {
  if (uris.length === 0) return;
  const root = shareDirUri();
  for (const uri of uris) {
    if (!isOwnedShareCopy(uri, root)) continue;
    try {
      const file = new (fileSystem().File)(uri);
      if (file.exists) file.delete();
    } catch {
      // Best effort: the folder is wiped on account change and swept on start.
    }
  }
}

/** Delete every shared copy — on sign-out or account switch. */
export function wipeSharedFiles(): void {
  try {
    const { Directory, Paths } = fileSystem();
    const dir = new Directory(Paths.cache, SHARE_DIR_NAME);
    if (dir.exists) dir.delete();
  } catch {
    // Nothing to wipe, or the cache is already gone.
  }
}

/** Delete copies older than `maxAgeMs` — leftovers from a share that was never
 *  finished (the app was killed with it open). */
export function sweepStaleSharedFiles(maxAgeMs: number, now = Date.now()): void {
  try {
    const { Directory, File, Paths } = fileSystem();
    const dir = new Directory(Paths.cache, SHARE_DIR_NAME);
    if (!dir.exists) return;
    for (const entry of dir.list()) {
      if (!(entry instanceof File)) continue;
      const modified = entry.modificationTime;
      if (modified == null || now - modified > maxAgeMs) entry.delete();
    }
  } catch {
    // Best effort.
  }
}
