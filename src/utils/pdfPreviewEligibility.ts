import type { FileAttachment } from './fileAttachment';

/** Above this a PDF isn't downloaded just to draw its first page. */
export const MAX_PDF_PREVIEW_BYTES = 10 * 1024 * 1024;

/** Whether a PDF is small enough (and its size known) to preview inline.
 * Pure, so the bubble can decide on the preview box before loading the
 * heavy preview service. */
export const pdfPreviewEligible = (file: Pick<FileAttachment, 'size'>): boolean =>
  file.size !== undefined && file.size <= MAX_PDF_PREVIEW_BYTES;
