import { Buffer } from 'buffer';
import {
  detectImageMime,
  hasImageFilename,
  stripImageMetadataBytes,
} from '../utils/imageMetadataStrip';
import { stripImageMetadata } from './imageUploadService';

/** File attachments preserve non-image bytes; image failures must re-encode or abort. */
export async function prepareFileAttachment(
  uri: string,
  base64: string,
  mime: string,
  filename: string,
): Promise<{ uri: string; base64: string; mime: string; filename: string }> {
  // Decode only a bounded header before the non-image passthrough gate.
  const detected = detectImageMime(Buffer.from(base64.slice(0, 24), 'base64'));
  const declared = mime.toLowerCase().split(';')[0].trim();
  const generic = [
    '',
    'application/octet-stream',
    'binary/octet-stream',
    'application/binary',
  ].includes(declared);
  mime = detected ?? (generic && hasImageFilename(filename) ? 'image/unknown' : mime);
  if (!mime.toLowerCase().startsWith('image/')) return { uri, base64, mime, filename };
  try {
    const bytes = stripImageMetadataBytes(Buffer.from(base64, 'base64'), mime);
    return { uri, base64: Buffer.from(bytes).toString('base64'), mime, filename };
  } catch {
    // HEIC/other images and malformed streams take the existing native path.
    // Disable its GIF passthrough: arbitrary File images must also be sanitized.
    const stripped = await stripImageMetadata(uri, base64, { preserveGif: false });
    const png = /\.png$/i.test(stripped.uri);
    const extension = png ? '.png' : '.jpg';
    return {
      ...stripped,
      mime: png ? 'image/png' : 'image/jpeg',
      filename: filename.replace(/\.[^.]*$/, '') + extension,
    };
  }
}
