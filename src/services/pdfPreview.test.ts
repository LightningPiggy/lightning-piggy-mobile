import { requireOptionalNativeModule } from 'expo-modules-core';
import { resolvePdfPreview } from './pdfPreview';
import {
  captureDecryptedMediaSession,
  resolveDecryptedMedia,
  publishDecryptedPreview,
  verifiedFileMetadata,
} from './decryptedMediaCache';
import type { FileAttachment } from '../utils/fileAttachment';

jest.mock('expo-modules-core', () => ({ requireOptionalNativeModule: jest.fn() }));
jest.mock('./decryptedMediaCache', () => ({
  PDF_PREVIEW_WIDTH: 480,
  captureDecryptedMediaSession: jest.fn((owner = 'alice') => ({ owner, assertCurrent: jest.fn() })),
  resolveDecryptedMedia: jest.fn(),
  verifiedFileMetadata: jest.fn(),
  publishDecryptedPreview: jest.fn((_uri, render) => render()),
}));
const file = {
  url: 'https://example.com/pdf',
  mime: 'application/pdf',
  size: 430,
} as FileAttachment;
const render = jest.fn();
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(requireOptionalNativeModule).mockReturnValue({ renderPdfFirstPageAsync: render });
  jest.mocked(resolveDecryptedMedia).mockResolvedValue('file:///cache/account/hash.pdf');
  jest.mocked(verifiedFileMetadata).mockReturnValue({ size: 414, mime: 'application/pdf' });
  render.mockResolvedValue('file:///cache/account/hash.pdf.preview-480.png');
});
it.each([null, {}])('skips downloads on old dev clients (%s)', async (native) => {
  jest.mocked(requireOptionalNativeModule).mockReturnValue(native);
  expect(await resolvePdfPreview(file, 'alice')).toBeNull();
  expect(resolveDecryptedMedia).not.toHaveBeenCalled();
});
it('skips declared oversized files before download and verified oversized files before rendering', async () => {
  expect(await resolvePdfPreview({ ...file, size: 10 * 1024 * 1024 + 1 }, 'alice')).toBeNull();
  expect(resolveDecryptedMedia).not.toHaveBeenCalled();
  jest
    .mocked(verifiedFileMetadata)
    .mockReturnValue({ size: 10 * 1024 * 1024 + 1, mime: 'application/pdf' });
  expect(await resolvePdfPreview(file, 'alice')).toBeNull();
  expect(render).not.toHaveBeenCalled();
});
it('rejects a misleading PDF declaration and download failures silently', async () => {
  jest
    .mocked(verifiedFileMetadata)
    .mockReturnValue({ size: 414, mime: 'application/octet-stream' });
  expect(await resolvePdfPreview(file, 'alice')).toBeNull();
  expect(render).not.toHaveBeenCalled();
  jest.mocked(resolveDecryptedMedia).mockRejectedValueOnce(new Error('verification failed'));
  expect(await resolvePdfPreview(file, 'alice')).toBeNull();
});
it('shares one in-flight render of the hash-keyed local file under the cleanup barrier', async () => {
  let finish!: (uri: string) => void;
  render.mockImplementationOnce(
    () =>
      new Promise<string>((resolve) => {
        finish = resolve;
      }),
  );
  const a = resolvePdfPreview(file, 'alice');
  const b = resolvePdfPreview(file, 'alice');
  await Promise.resolve();
  expect(render).toHaveBeenCalledTimes(1);
  expect(resolveDecryptedMedia).toHaveBeenCalledWith({ ...file, kind: 'file' }, 'alice');
  expect(render).toHaveBeenCalledWith('file:///cache/account/hash.pdf', 480);
  expect(publishDecryptedPreview).toHaveBeenCalledTimes(1);
  finish('file:///cache/preview.png');
  expect(await a).toBe('file:///cache/preview.png');
  expect(await b).toBe('file:///cache/preview.png');
});
it('silently falls back when native rendering fails', async () => {
  render.mockRejectedValueOnce(new Error('broken PDF'));
  expect(await resolvePdfPreview(file, 'alice')).toBeNull();
});

it('discards a preview if the captured session ends during native rendering', async () => {
  let current = true;
  jest.mocked(captureDecryptedMediaSession).mockReturnValueOnce({
    owner: 'alice',
    assertCurrent: () => {
      if (!current) throw new Error('cancelled');
    },
  });
  render.mockImplementationOnce(async () => {
    current = false;
    return 'file:///old-preview.png';
  });
  expect(await resolvePdfPreview(file, 'alice')).toBeNull();
});

it('skips files of unknown size before fetching or rendering', async () => {
  expect(await resolvePdfPreview({ ...file, size: undefined }, 'alice')).toBeNull();
  expect(resolveDecryptedMedia).not.toHaveBeenCalled();
  expect(render).not.toHaveBeenCalled();
});
