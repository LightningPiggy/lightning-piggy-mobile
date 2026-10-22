import { MAX_PDF_PREVIEW_BYTES, pdfPreviewEligible } from './pdfPreviewEligibility';

it('previews a declared size up to the cap', () => {
  expect(pdfPreviewEligible({ size: 414 })).toBe(true);
  expect(pdfPreviewEligible({ size: MAX_PDF_PREVIEW_BYTES })).toBe(true);
  expect(pdfPreviewEligible({ size: MAX_PDF_PREVIEW_BYTES + 1 })).toBe(false);
});

it('allows an unknown size only for a tap-gated plain link', () => {
  expect(pdfPreviewEligible({ size: undefined })).toBe(false);
  expect(pdfPreviewEligible({ size: undefined, plainUrl: true })).toBe(true);
});
