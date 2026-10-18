import { requireOptionalNativeModule } from 'expo-modules-core';
import {
  captureDecryptedMediaSession,
  resolveDecryptedMedia,
  publishDecryptedPreview,
  verifiedFileMetadata,
  PDF_PREVIEW_WIDTH,
} from './decryptedMediaCache';
import type { FileAttachment } from '../utils/fileAttachment';

const previews = new Map<string, Promise<string | null>>();
const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;

/** Resolve only after trust consent. Native output is beside the account's hash-keyed local file. */
export async function resolvePdfPreview(
  file: FileAttachment,
  owner: string | null,
  session = captureDecryptedMediaSession(owner),
): Promise<string | null> {
  try {
    session.assertCurrent();
    const native = requireOptionalNativeModule<{
      renderPdfFirstPageAsync?: (uri: string, width: number) => Promise<string | null>;
    }>('DocumentMetadata');
    if (
      !native?.renderPdfFirstPageAsync ||
      file.size === undefined ||
      file.size > MAX_PREVIEW_BYTES
    )
      return null;
    const uri = await resolveDecryptedMedia({ ...file, kind: 'file' }, owner);
    session.assertCurrent();
    const metadata = verifiedFileMetadata(uri);
    if (!metadata || metadata.mime !== 'application/pdf' || metadata.size > MAX_PREVIEW_BYTES)
      return null;
    let pending = previews.get(uri);
    if (!pending) {
      pending = publishDecryptedPreview(uri, () =>
        native.renderPdfFirstPageAsync!(uri, PDF_PREVIEW_WIDTH),
      )
        .catch(() => null)
        .finally(() => previews.delete(uri));
      previews.set(uri, pending);
    }
    const result = await pending;
    session.assertCurrent();
    return result;
  } catch {
    return null;
  }
}
