import { requireOptionalNativeModule } from 'expo-modules-core';
import {
  captureDecryptedMediaSession,
  DecryptedMediaCancelledError,
  resolveDecryptedMedia,
  publishDecryptedPreview,
  verifiedFileMetadata,
  PDF_PREVIEW_WIDTH,
} from './decryptedMediaCache';
import type { FileAttachment } from '../utils/fileAttachment';
import { MAX_PDF_PREVIEW_BYTES, pdfPreviewEligible } from '../utils/pdfPreviewEligibility';

const previews = new Map<string, Promise<string | null>>();
/** fetchBounded's error for a body over its byte cap. */
const OVER_LIMIT = 'Remote body exceeds limit';

/** Resolve only after trust consent. Native output is beside the account's hash-keyed local file.
 * Resolves null when there's no preview to show (too big, not really a PDF,
 * the render failed); rejects when the download or decrypt failed, so the
 * caller can offer a retry. */
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
    if (!native?.renderPdfFirstPageAsync || !pdfPreviewEligible(file)) return null;
    // An unknown-size link is fetched with the preview cap, not the 50 MB
    // file cap: a preview never pulls more than it could render.
    const uri = await resolveDecryptedMedia(
      { ...file, size: file.size ?? MAX_PDF_PREVIEW_BYTES, kind: 'file' },
      owner,
    );
    session.assertCurrent();
    const metadata = verifiedFileMetadata(uri);
    if (!metadata || metadata.mime !== 'application/pdf' || metadata.size > MAX_PDF_PREVIEW_BYTES)
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
  } catch (error) {
    if (error instanceof DecryptedMediaCancelledError) return null;
    // Over the preview cap: nothing to preview (Save/Share still fetch it).
    if (file.size === undefined && error instanceof Error && error.message === OVER_LIMIT)
      return null;
    throw error;
  }
}
