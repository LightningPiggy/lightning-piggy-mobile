import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useImageMediaUri } from './useImageMediaUri';
import { resolveRemoteMedia } from '../services/remoteMediaCache';
import {
  captureDecryptedMediaSession,
  peekDecryptedMedia,
  resolveDecryptedMedia,
} from '../services/decryptedMediaCache';

let mockOwner = 'alice';
jest.mock('./useActivePubkey', () => ({ useActivePubkey: () => mockOwner }));
jest.mock('../services/remoteMediaCache', () => ({ resolveRemoteMedia: jest.fn() }));
jest.mock('../services/decryptedMediaCache', () => ({
  captureDecryptedMediaSession: jest.fn((owner = 'alice') => ({ owner, assertCurrent: jest.fn() })),
  peekDecryptedMedia: jest.fn(() => null),
  resolveDecryptedMedia: jest.fn(),
  DecryptedMediaCancelledError: class extends Error {},
}));
const ref = {
  url: 'https://example.com/image',
  kind: 'image' as const,
  keyHex: 'key',
  nonceHex: 'nonce',
};
beforeEach(() => {
  jest.clearAllMocks();
  mockOwner = 'alice';
  jest.mocked(peekDecryptedMedia).mockReturnValue(null);
});
it.each([false, true])(
  'clears a mounted %s encrypted image on account change with unchanged props',
  async (encrypted) => {
    const resolver = jest.mocked(encrypted ? resolveDecryptedMedia : resolveRemoteMedia);
    let finish!: (uri: string) => void;
    resolver.mockResolvedValueOnce('file:///alice/image').mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const onResolved = jest.fn();
    const { result, rerender } = renderHook(() =>
      useImageMediaUri(ref, encrypted, true, onResolved),
    );
    await waitFor(() => expect(result.current.uri).toBe('file:///alice/image'));
    mockOwner = 'bob';
    rerender({});
    expect(result.current.uri).toBeNull();
    expect(resolver).toHaveBeenCalledTimes(2);
    await act(async () => finish('file:///bob/image'));
    expect(result.current.uri).toBe('file:///bob/image');
    expect(onResolved).toHaveBeenLastCalledWith('file:///bob/image');
  },
);
it.each([false, true])(
  'ignores late results from the previous account (%s encrypted)',
  async (encrypted) => {
    const resolver = jest.mocked(encrypted ? resolveDecryptedMedia : resolveRemoteMedia);
    let finishAlice!: (uri: string) => void;
    resolver
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishAlice = resolve;
          }),
      )
      .mockResolvedValueOnce('file:///bob/image');
    const onResolved = jest.fn();
    const { result, rerender } = renderHook(() =>
      useImageMediaUri(ref, encrypted, true, onResolved),
    );
    mockOwner = 'bob';
    rerender({});
    await waitFor(() => expect(result.current.uri).toBe('file:///bob/image'));
    await act(async () => finishAlice('file:///alice/image'));
    expect(result.current.uri).toBe('file:///bob/image');
    expect(onResolved).toHaveBeenCalledTimes(1);
  },
);
it('hides a previously resolved attachment when consent is withdrawn', async () => {
  jest.mocked(resolveRemoteMedia).mockResolvedValue('file:///alice/image');
  const { result, rerender } = renderHook(
    ({ enabled }: { enabled: boolean }) => useImageMediaUri(ref, false, enabled),
    {
      initialProps: { enabled: true },
    },
  );
  await waitFor(() => expect(result.current.uri).not.toBeNull());
  rerender({ enabled: false });
  expect(result.current.uri).toBeNull();
});

it('binds image resolution to the initiating owner and ignores a retired session', async () => {
  let current = true;
  jest.mocked(captureDecryptedMediaSession).mockReturnValueOnce({
    owner: 'alice',
    assertCurrent: () => {
      if (!current) throw new Error('cancelled');
    },
  });
  jest.mocked(resolveDecryptedMedia).mockImplementationOnce(async () => {
    current = false;
    return 'file:///old-image';
  });
  const onResolved = jest.fn();
  const { result } = renderHook(() => useImageMediaUri(ref, true, true, onResolved));
  await act(async () => {});
  expect(resolveDecryptedMedia).toHaveBeenCalledWith(ref, 'alice');
  expect(onResolved).not.toHaveBeenCalled();
  expect(result.current.uri).toBeNull();
});
