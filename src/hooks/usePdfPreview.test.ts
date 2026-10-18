import { act, renderHook, waitFor } from '@testing-library/react-native';
import { captureDecryptedMediaSession } from '../services/decryptedMediaCache';
import { usePdfPreview } from './usePdfPreview';
import { resolvePdfPreview } from '../services/pdfPreview';
import type { FileAttachment } from '../utils/fileAttachment';

let mockOwner = 'alice';
jest.mock('./useActivePubkey', () => ({ useActivePubkey: () => mockOwner }));
jest.mock('../services/decryptedMediaCache', () => ({
  captureDecryptedMediaSession: jest.fn((owner = 'alice') => ({ owner, assertCurrent: jest.fn() })),
}));
jest.mock('../services/pdfPreview', () => ({ resolvePdfPreview: jest.fn() }));
const file = { url: 'https://example.com/file.pdf', mime: 'application/pdf' } as FileAttachment;
beforeEach(() => {
  jest.clearAllMocks();
  mockOwner = 'alice';
});

it('never starts resolution if unmounted before the deferred import completes', async () => {
  const { unmount } = renderHook(() => usePdfPreview(file, true));
  unmount();
  await act(async () => {});
  expect(resolvePdfPreview).not.toHaveBeenCalled();
});

it('cancels the old deferred import and binds the new resolution to the current owner', async () => {
  jest.mocked(resolvePdfPreview).mockResolvedValue('file:///bob/preview.png');
  const { result, rerender } = renderHook(() => usePdfPreview(file, true));
  mockOwner = 'bob';
  rerender({});
  await waitFor(() => expect(result.current).toBe('file:///bob/preview.png'));
  expect(resolvePdfPreview).toHaveBeenCalledTimes(1);
  expect(resolvePdfPreview).toHaveBeenCalledWith(
    file,
    'bob',
    expect.objectContaining({ owner: 'bob' }),
  );
});

it('ignores a previous account preview that finishes after the switch', async () => {
  let finish!: (uri: string) => void;
  jest
    .mocked(resolvePdfPreview)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce('file:///bob/preview.png');
  const { result, rerender } = renderHook(() => usePdfPreview(file, true));
  await waitFor(() => expect(resolvePdfPreview).toHaveBeenCalledTimes(1));
  mockOwner = 'bob';
  rerender({});
  expect(result.current).toBeNull();
  await waitFor(() => expect(result.current).toBe('file:///bob/preview.png'));
  await act(async () => {
    finish('file:///alice/preview.png');
  });
  expect(result.current).toBe('file:///bob/preview.png');
});

it('does not resolve after its session ends before the deferred import', async () => {
  jest.mocked(captureDecryptedMediaSession).mockReturnValueOnce({
    owner: 'alice',
    assertCurrent: () => {
      throw new Error('cancelled');
    },
  });
  renderHook(() => usePdfPreview(file, true));
  await act(async () => {});
  expect(resolvePdfPreview).not.toHaveBeenCalled();
});
