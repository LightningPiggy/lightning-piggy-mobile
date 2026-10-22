import type { FileAttachment } from './fileAttachment';

/** Above this a PDF isn't downloaded just to draw its first page. */
export const MAX_PDF_PREVIEW_BYTES = 10 * 1024 * 1024;

/** Whether a PDF may be fetched to preview inline. A declared size must be
 * within the cap. An unknown size is allowed only for a pasted plain link:
 * those always wait for the reader's tap, and the download is still bounded
 * (the decoded size is re-checked before rendering). Pure, so the bubble can
 * decide on the preview box before loading the heavy preview service. */
export const pdfPreviewEligible = (file: Pick<FileAttachment, 'size' | 'plainUrl'>): boolean =>
  file.size !== undefined ? file.size <= MAX_PDF_PREVIEW_BYTES : !!file.plainUrl;
