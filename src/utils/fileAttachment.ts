import { isMarmotMediaVersion } from './encryptedFileUrl';
import { checkRemoteUrl } from './remoteUrlPolicy';
import type { ParsedImageMessage } from './messageContent';

export interface FileAttachment extends ParsedImageMessage {
  name: string;
  /** Plain URL explicitly classified from a text message, without a sender hash. */
  plainUrl?: boolean;
  size?: number;
  available: boolean;
  caption?: string;
  plaintextSha256?: string;
  dangerous: boolean;
  typeMismatch: boolean;
}

// Remove direction controls and invisible separators before checking extensions.
export function sanitizeAttachmentText(value: string): string {
  return value
    .replace(/[\r\n\x00-\x1f]/g, ' ')
    .replace(/[\x7f\p{Cf}\u2028\u2029]/gu, '')
    .replace(/\.\.(?=[/\\])/g, '')
    .replace(/[/\\]/g, '')
    .replace(/\.{2,}/g, '.')
    .trim();
}
/** Captions are prose: preserve punctuation and bound display length. */
export function sanitizeAttachmentCaption(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}\u2028\u2029]/gu, '').slice(0, 2000);
}

export function isSafeFileUrl(url: string): boolean {
  return checkRemoteUrl(url, { kind: 'media' }).ok;
}
const DANGEROUS_EXTENSIONS = new Set(
  'apk exe msi dmg pkg sh bat cmd ps1 js jar html htm xhtml svg lnk scr iso'.split(' '),
);
const DANGEROUS_MIMES = new Set([
  'application/vnd.android.package-archive',
  'application/x-msdownload',
  'application/x-msdos-program',
  'application/x-msi',
  'application/x-ms-installer',
  'application/x-apple-diskimage',
  'application/x-newton-compatible-pkg',
  'application/vnd.apple.installer+xml',
  'application/x-sh',
  'application/x-shellscript',
  'application/x-bat',
  'application/x-powershell',
  'text/x-shellscript',
  'application/javascript',
  'text/javascript',
  'application/x-javascript',
  'application/java-archive',
  'application/x-java-archive',
  'text/html',
  'application/xhtml+xml',
  'image/svg+xml',
  'application/x-ms-shortcut',
  'application/x-iso9660-image',
  'application/x-dosexec',
  'application/x-ms-dos-executable',
  'application/x-executable',
  'application/x-csh',
  'text/x-sh',
  'text/x-powershell',
  'application/x-batch',
  'application/ecmascript',
  'text/ecmascript',
  'application/x-iso-image',
]);
const MIME_EXTENSIONS: Record<string, string[]> = {
  'application/pdf': ['pdf'],
  'image/png': ['png'],
  'image/jpeg': ['jpg', 'jpeg'],
  'text/plain': ['txt'],
  'application/zip': ['zip'],
  'application/vnd.android.package-archive': ['apk'],
  'text/html': ['html', 'htm'],
  'image/svg+xml': ['svg'],
  'application/javascript': ['js'],
  'text/javascript': ['js'],
  'application/xhtml+xml': ['xhtml'],
  'application/x-msdownload': ['exe', 'dll', 'scr'],
  'application/x-msi': ['msi'],
  'application/x-apple-diskimage': ['dmg'],
  'application/vnd.apple.installer+xml': ['pkg'],
  'application/x-sh': ['sh'],
  'application/x-bat': ['bat', 'cmd'],
  'application/x-powershell': ['ps1'],
  'application/java-archive': ['jar'],
  'application/x-ms-shortcut': ['lnk'],
  'application/x-iso9660-image': ['iso'],
  'application/msword': ['doc'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'],
  'application/vnd.ms-excel': ['xls'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['xlsx'],
  'application/vnd.ms-powerpoint': ['ppt'],
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['pptx'],
  'application/epub+zip': ['epub'],
  'application/vnd.oasis.opendocument.text': ['odt'],
  'application/rtf': ['rtf'],
  'application/json': ['json'],
  'text/csv': ['csv'],
};
export function attachmentSafety(name: string, mime: string) {
  const clean = sanitizeAttachmentText(name).replace(/[.\s]+$/u, '');
  const extension = clean.split('.').pop()?.toLowerCase() ?? '';
  const type = mime
    .split('/')
    .map(sanitizeAttachmentText)
    .join('/')
    .toLowerCase()
    .split(';')[0]
    .trim();
  const expectedExtensions = Object.hasOwn(MIME_EXTENSIONS, type)
    ? MIME_EXTENSIONS[type]
    : undefined;
  return {
    dangerous: DANGEROUS_EXTENSIONS.has(extension) || DANGEROUS_MIMES.has(type),
    typeMismatch:
      (!!expectedExtensions && !expectedExtensions.includes(extension)) ||
      (type !== 'application/octet-stream' &&
        !expectedExtensions &&
        Object.values(MIME_EXTENSIONS).some((extensions) => extensions.includes(extension))),
  };
}
function displayMetadata(name: string, mime: string) {
  // Check the full sanitised name before truncating so a hidden suffix stays blocked.
  const safety = attachmentSafety(name, mime);
  const clean = sanitizeAttachmentText(name);
  const name80 = clean.length <= 80 ? clean : `${clean.slice(0, 60)}…${clean.slice(-19)}`;
  const type = mime.split('/').map(sanitizeAttachmentText).join('/');
  // MIME is a token, not arbitrary display text; invalid tokens become generic bytes.
  const canonical = type.toLowerCase().split(';')[0].trim();
  return {
    name: name80,
    mime:
      canonical.length <= 100 && /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(canonical)
        ? canonical
        : 'application/octet-stream',
    ...safety,
  };
}

function urlBasename(url: string): string {
  const segment = url.split(/[?#]/)[0].split('/').pop() ?? '';
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Prefer the authenticated filename; URL names are only a fallback. */
export function attachmentMetadata(tags: string[][], filename?: string) {
  const tag =
    tags.find((tag) => tag[0] === 'imeta' && (!filename || tag.includes(`filename ${filename}`))) ??
    tags.find((tag) => tag[0] === 'imeta');
  const field = (key: string) =>
    tag?.find((value) => value.startsWith(`${key} `))?.slice(key.length + 1);
  const url = field('url') ?? '';
  const name =
    filename || field('filename') || urlBasename(url) || field('name') || field('alt') || '';
  const rawSize = field('size');
  const size = rawSize && /^\d+$/.test(rawSize) ? Number(rawSize) : undefined;
  return {
    name: displayMetadata(name, 'application/octet-stream').name,
    ...(size !== undefined && Number.isSafeInteger(size) ? { size } : {}),
  };
}

/** Stored file URLs carry decryption parameters; never expose their fragments in UI. */
export function parseFileAttachment(text: string): FileAttachment | null {
  if (text.startsWith('[FILE]')) {
    try {
      const value = JSON.parse(text.slice(6));
      if (typeof value.name !== 'string' || typeof value.mime !== 'string') return null;
      return {
        url: typeof value.url === 'string' ? value.url : '',
        encrypted: value.encrypted !== false,
        ...displayMetadata(value.name, value.mime),
        dangerous:
          attachmentSafety(value.name, value.mime).dangerous ||
          attachmentSafety(urlBasename(typeof value.url === 'string' ? value.url : ''), '')
            .dangerous,
        ...(typeof value.plaintextSha256 === 'string'
          ? { plaintextSha256: value.plaintextSha256 }
          : {}),
        available:
          value.encrypted === false &&
          typeof value.plaintextSha256 === 'string' &&
          /^[a-f0-9]{64}$/i.test(value.plaintextSha256) &&
          typeof value.url === 'string' &&
          isSafeFileUrl(value.url),
        ...(typeof value.caption === 'string'
          ? { caption: sanitizeAttachmentCaption(value.caption) }
          : {}),
        ...(Number.isSafeInteger(value.size) && value.size >= 0 ? { size: value.size } : {}),
      };
    } catch {
      return null;
    }
  }
  const [url, fragment] = text.trim().split('#');
  if (!fragment || !/^https?:\/\//.test(url)) return null;
  const p = new URLSearchParams(fragment);
  if (p.get('lpe') !== '1') return null;
  const mime = displayMetadata('', p.get('m') ?? 'application/octet-stream').mime;
  const alg = p.get('alg') ?? 'aes-gcm';
  // Attach → File supplies a filename; gallery images do not. Keep these
  // named NIP-17 images as file cards so recipients can Save the actual bytes.
  // Marmot image filenames are required encryption metadata, not file intent.
  const namedImageFile = alg === 'aes-gcm' && !!p.get('f');
  if (
    (mime.startsWith('image/') && mime !== 'image/svg+xml' && !namedImageFile) ||
    mime.startsWith('audio/')
  )
    return null;
  const nonceHex = p.get('n') ?? undefined;
  const keyHex = p.get('k') ?? undefined;
  const filename = p.get('f') ?? '';
  const plaintextSha256 = p.get('ps') ?? '';
  const ciphertextSha256 = p.get('cs') ?? '';
  const marmot =
    isMarmotMediaVersion(alg) && keyHex && filename && plaintextSha256 && ciphertextSha256
      ? { version: alg, keysHex: keyHex.split(','), filename, plaintextSha256, ciphertextSha256 }
      : undefined;
  const size = p.get('s') ?? p.get('size');
  return {
    url,
    ...displayMetadata(filename || p.get('name') || urlBasename(url), mime),
    dangerous:
      attachmentSafety(filename || p.get('name') || urlBasename(url), mime).dangerous ||
      attachmentSafety(urlBasename(url), '').dangerous,
    encrypted: true,
    ...(p.has('x') ? { sha256: p.get('x')! } : {}),
    keyHex,
    nonceHex,
    marmot,
    ...(p.get('caption') ? { caption: sanitizeAttachmentCaption(p.get('caption')!) } : {}),
    ...(size && /^\d+$/.test(size) && Number.isSafeInteger(Number(size))
      ? { size: Number(size) }
      : {}),
    available:
      isSafeFileUrl(url) &&
      !!nonceHex &&
      (!!marmot ||
        (alg === 'aes-gcm' &&
          /^[a-f0-9]{64}$/i.test(keyHex ?? '') &&
          /^[a-f0-9]{24}$/i.test(nonceHex) &&
          /^[a-f0-9]{64}$/i.test(p.get('x') ?? ''))),
  };
}

export function classifyAttachment(
  text: string,
  wireKind?: number,
): 'image' | 'voice' | 'file' | 'unknown' | 'text' {
  if (wireKind !== undefined && ![4, 9, 14, 15, 16, 17, 1068, 1018].includes(wireKind))
    return 'unknown';
  if (wireKind === 15 && parseFileAttachment(text)) return 'file';
  const fragment = text.split('#')[1];
  const mime = fragment ? new URLSearchParams(fragment).get('m') : null;
  if (mime?.startsWith('image/')) return 'image';
  if (mime?.startsWith('audio/')) return 'voice';
  return 'text';
}

/** Recognise whole-message document URLs only; ordinary web links stay links.
 * No request is made during classification, even for followed senders. */
export function parsePlainFileAttachment(text: string): FileAttachment | null {
  const raw = text.trim();
  if (!/^https?:\/\/[^\s]+$/i.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (new URLSearchParams(url.hash.slice(1)).get('lpe') === '1') return null;
    const name = urlBasename(raw);
    const extension = sanitizeAttachmentText(name)
      .replace(/[.\s]+$/u, '')
      .split('.')
      .pop()
      ?.toLowerCase();
    const mime = Object.entries(MIME_EXTENSIONS).find(([, extensions]) =>
      extensions.includes(extension ?? ''),
    )?.[0];
    if (
      !mime &&
      !DANGEROUS_EXTENSIONS.has(extension ?? '') &&
      !['ppt', 'pptx', 'epub', 'odt', 'rtf', '7z', 'gz', 'tar'].includes(extension ?? '')
    )
      return null;
    if (/^(image|audio)\//.test(mime ?? '') && mime !== 'image/svg+xml') return null;
    return {
      url: raw,
      encrypted: false,
      plainUrl: true,
      available: isSafeFileUrl(raw),
      ...displayMetadata(name, mime ?? 'application/octet-stream'),
    };
  } catch {
    return null;
  }
}
