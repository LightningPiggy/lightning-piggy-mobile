/**
 * "Share to Lightning Piggy" (#1692): reduce what another app shared to what a
 * chat can carry — plain text (a message or link) and images. Pure, so the
 * trust rules below are unit-tested without the native share-intent module.
 *
 * Everything here is untrusted input from another app:
 *  - only copies the share module made in its own cache folder, under its own
 *    generated names, are ever read, attached or deleted;
 *  - an image's type comes from its bytes (`sniffImageMime`), never from the
 *    sender's MIME type or file name;
 *  - text is plain text for the composer — never parsed into links, actions or
 *    deep links here — and stripped of control and direction-override
 *    characters.
 */

/** The composer sends one image per message; cap a share at ten. Mirrors
 *  `LP_MAX_SHARED_FILES` in the native patch. */
export const MAX_SHARED_IMAGES = 10;
/** Mirrors `LP_MAX_SHARED_BYTES` in the native patch, re-checked here. */
export const MAX_SHARED_IMAGE_BYTES = 25 * 1024 * 1024;
/** Prefill only, but bound it: a hostile sender could pass megabytes of text. */
export const MAX_SHARED_TEXT_CHARS = 20_000;
/** Folder (inside the app cache) the native share module copies files into. */
export const SHARE_DIR_NAME = 'lp-share';

export type SharedImageMime =
  | 'image/jpeg'
  | 'image/png'
  | 'image/gif'
  | 'image/webp'
  | 'image/heic';

export interface SharedImage {
  /** `file://` URI of the copy the share module made for us. */
  uri: string;
  /** Sniffed from the file's bytes once verified; the sender's claim before. */
  mimeType: string;
}

export interface IncomingShare {
  /** Shared message or link, cleaned. Null when only files were shared. */
  text: string | null;
  images: SharedImage[];
  /** Copies we own but won't use (images past the cap, failed checks) —
   *  delete them so nothing shared is kept. */
  discard: string[];
}

/** The subset of expo-share-intent's `ShareIntent` this module reads. */
export interface RawShareIntent {
  text?: string | null;
  webUrl?: string | null;
  files?: readonly { path: string; mimeType?: string | null }[] | null;
  /** Files the sender offered, counted natively before the share module's
   *  cap and checks dropped any. Absent on older payloads / single shares. */
  lpOfferedFileCount?: number | null;
}

// `share-<uuid>.<ext>`, exactly as the native patch names its copies.
const SHARE_COPY_NAME =
  /^share-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|gif|webp|heic)$/i;

export function toFileUri(path: string): string {
  if (/^file:\/\//i.test(path)) return path;
  return path.startsWith('/') ? `file://${path}` : path;
}

/**
 * True only for a copy the share module itself made: a generated
 * `share-<uuid>.<ext>` directly inside `<cache>/lp-share/`. Anything else — a
 * `file://` path into the app's own private storage, a `content://` URI, a
 * name with traversal segments — was not something the user picked in another
 * app and must never be read, attached or deleted ("Dirty Stream").
 */
export function isOwnedShareCopy(uri: string, shareDirUri: string | null): boolean {
  if (!shareDirUri || !/^file:\/\//i.test(uri)) return false;
  const root = shareDirUri.endsWith('/') ? shareDirUri : `${shareDirUri}/`;
  if (!uri.startsWith(root)) return false;
  return SHARE_COPY_NAME.test(uri.slice(root.length));
}

/**
 * The image type from a file's first bytes (magic numbers), or null when it
 * isn't one of the formats the composer can send. Needs at least 12 bytes.
 */
export function sniffImageMime(bytes: Uint8Array): SharedImageMime | null {
  const b = bytes;
  const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    ascii(1, 4) === 'PNG' &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  )
    return 'image/png';
  if (b.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif';
  if (b.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (b.length >= 12 && ascii(4, 8) === 'ftyp') {
    const brand = ascii(8, 12);
    if (['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1'].includes(brand))
      return 'image/heic';
  }
  return null;
}

/** File extension the composer's image path expects for a sniffed type
 *  (`stripImageMetadata` picks PNG / GIF handling by extension). */
export function extensionForMime(mime: SharedImageMime): string {
  switch (mime) {
    case 'image/png':
      return 'png';
    case 'image/gif':
      return 'gif';
    case 'image/webp':
      return 'webp';
    case 'image/heic':
      return 'heic';
    default:
      return 'jpg';
  }
}

/** Same copy name with the extension the sniffed type calls for, or null when
 *  the name already matches. */
export function renamedForMime(fileName: string, mime: SharedImageMime): string | null {
  const ext = extensionForMime(mime);
  const current = fileName.slice(fileName.lastIndexOf('.') + 1).toLowerCase();
  if (current === ext) return null;
  return `${fileName.slice(0, fileName.lastIndexOf('.'))}.${ext}`;
}

// C0 controls except tab / newline, DEL, C1 controls, the bidi marks /
// embeddings / overrides / isolates that can make text read differently from
// what it says ("Trojan Source" style spoofing of a shared link), and
// invisible zero-width / format characters (ZWSP, word joiner, BOM, soft
// hyphen, Mongolian vowel separator, line / paragraph separators, interlinear
// annotation marks, Hangul fillers). The two joiners (ZWNJ, ZWJ) are handled
// by `stripStrayJoiners` instead.
// Written as escapes so the source itself carries no invisible characters.
const UNSAFE_TEXT_CHARS =
  /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b\u200e\u200f\u2028-\u202e\u2060\u2066-\u2069\u3164\ufeff\ufff9-\ufffb\uffa0]/g;

const JOINERS = /[\u200c\u200d]/g;
const ZWJ = 0x200d;

/** BMP symbols that take part in emoji sequences: Misc Symbols, Dingbats
 *  (♀ ♂ ⚕ ✈ ❄ ❤ ➡) and Misc Symbols and Arrows (⬛ in 🐈‍⬛ / 🐦‍⬛). */
const isEmojiSymbol = (code: number) =>
  (code >= 0x2600 && code <= 0x27bf) || (code >= 0x2b00 && code <= 0x2bff);
/** Last unit of an emoji (low surrogate, VS16, BMP emoji symbol). */
const endsEmoji = (code: number) =>
  (code >= 0xdc00 && code <= 0xdfff) || code === 0xfe0f || isEmojiSymbol(code);
/** First unit of an emoji (high surrogate, BMP emoji symbol). */
const startsEmoji = (code: number) => (code >= 0xd800 && code <= 0xdbff) || isEmojiSymbol(code);

/** Letters and marks of the scripts whose spelling needs ZWNJ / ZWJ: Arabic
 *  (Persian, Urdu …), Syriac, and the Indic scripts Devanagari through Sinhala
 *  (Hindi, Marathi …). Never Latin, Greek or Cyrillic — the scripts a spoofed
 *  link would be written in. */
const isJoiningScript = (code: number) =>
  (code >= 0x0600 && code <= 0x074f) ||
  (code >= 0x0750 && code <= 0x077f) ||
  (code >= 0x08a0 && code <= 0x08ff) ||
  (code >= 0x0900 && code <= 0x0dff) ||
  (code >= 0xfb50 && code <= 0xfdff) ||
  (code >= 0xfe70 && code <= 0xfefc);

/** ZWNJ / ZWJ are invisible, but they are also spelling: they glue emoji
 *  sequences together (family, profession, 🐈‍⬛) and shape Persian and Indic
 *  words. Keep a ZWJ between emoji and either joiner between two letters of a
 *  script that uses it; drop every other one. */
function stripStrayJoiners(text: string): string {
  return text.replace(JOINERS, (joiner, offset: number) => {
    if (offset === 0) return '';
    const before = text.charCodeAt(offset - 1);
    const after = text.charCodeAt(offset + 1);
    if (joiner.charCodeAt(0) === ZWJ && endsEmoji(before) && startsEmoji(after)) return joiner;
    return isJoiningScript(before) && isJoiningScript(after) ? joiner : '';
  });
}

/** Shared text as plain composer text: line endings normalised, unsafe
 *  characters removed, trimmed and capped. Null when nothing is left. */
export function sanitizeSharedText(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = stripStrayJoiners(
    raw.replace(/\r\n?/g, '\n').replace(UNSAFE_TEXT_CHARS, ''),
  ).trim();
  if (!cleaned) return null;
  return cleaned.slice(0, MAX_SHARED_TEXT_CHARS).trimEnd();
}

/**
 * First pass over the share module's output: keep text, and keep image copies
 * we own (up to the cap) for `verifySharedImages` to check by their bytes.
 * Paths we don't own are ignored entirely — not even deleted.
 */
export function normalizeShareIntent(
  intent: RawShareIntent,
  shareDirUri: string | null,
): IncomingShare {
  const text = sanitizeSharedText(intent.text ?? intent.webUrl);
  const images: SharedImage[] = [];
  const discard: string[] = [];
  for (const file of intent.files ?? []) {
    if (!file?.path) continue;
    const uri = toFileUri(file.path);
    if (!isOwnedShareCopy(uri, shareDirUri)) continue;
    if (images.length < MAX_SHARED_IMAGES) {
      images.push({ uri, mimeType: (file.mimeType ?? '').toLowerCase() });
    } else {
      discard.push(uri);
    }
  }
  return { text, images, discard };
}

export function hasShareContent(share: IncomingShare): boolean {
  return !!share.text || share.images.length > 0;
}

/**
 * True when some of what was shared won't reach the chat — for the "some
 * items couldn't be added" notice. Compares the images that passed every check
 * against what the sender offered: the native count taken before its 10-file
 * cap and its type / size checks (so files dropped there count too), or, when
 * that count is missing or nonsensical, the files the module passed on. One
 * comparison against one total, so a file dropped natively and one rejected
 * here are each counted once.
 */
export function someSharedItemsSkipped(intent: RawShareIntent, checked: IncomingShare): boolean {
  const passedOn = intent.files?.length ?? 0;
  const reported = intent.lpOfferedFileCount;
  const offered =
    typeof reported === 'number' && Number.isInteger(reported) && reported >= 0
      ? Math.max(reported, passedOn)
      : passedOn;
  return checked.images.length < offered;
}

/** Every file a share holds, used or not — for deleting it. */
export function shareCopies(share: IncomingShare): string[] {
  return [...share.images.map((image) => image.uri), ...share.discard];
}

/** Composer prefill: keep anything already typed, add the shared text below. */
export function appendSharedText(draft: string, shared: string): string {
  const kept = draft.trimEnd();
  return kept ? `${kept}\n${shared}` : shared;
}

/** Store key for the chat a share is headed to — one per protocol thread, the
 *  way the Conversation route keeps one screen per thread. */
export function dmShareTarget(pubkey: string, protocol: string): string {
  return `dm:${protocol}:${pubkey.toLowerCase()}`;
}

export function groupShareTarget(groupId: string): string {
  return `group:${groupId}`;
}

/** The chat a target belongs to, whichever protocol its thread is on: staged
 *  images stay through an in-place protocol switch (e.g. the Marmot → NIP-17
 *  fallback) but never move to another chat. */
export function shareChatOf(target: string): string {
  const dm = /^dm:[^:]*:(.+)$/.exec(target);
  return dm ? `dm:${dm[1]}` : target;
}

/** Add a share's images to the ones already waiting in a chat, keeping the
 *  tray at `MAX_SHARED_IMAGES`; `dropped` are the copies to delete. */
export function mergeStagedImages(
  staged: readonly SharedImage[],
  incoming: readonly SharedImage[],
): { images: SharedImage[]; dropped: SharedImage[] } {
  const room = Math.max(0, MAX_SHARED_IMAGES - staged.length);
  return {
    images: [...staged, ...incoming.slice(0, room)],
    dropped: incoming.slice(room),
  };
}
