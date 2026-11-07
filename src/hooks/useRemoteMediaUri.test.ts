import { act, renderHook, waitFor } from '@testing-library/react-native';
import { resolveRemoteMedia } from '../services/remoteMediaCache';
import { useRemoteMedia, useRemoteMediaWithAutoRetry } from './useRemoteMediaUri';
import { MEDIA_MAX_BYTES } from '../utils/remoteUrlPolicy';
import { __resetFailedMediaForTests, hasFailedMedia } from '../utils/failedMediaMemory';

let mockOwner = 'alice';
jest.mock('./useActivePubkey', () => ({ useActivePubkey: () => mockOwner }));
jest.mock('../services/remoteMediaCache', () => ({
  resolveRemoteMedia: jest.fn(),
  evictRemoteMedia: jest.fn(async () => undefined),
}));
const url = 'https://example.com/voice.mp3';
beforeEach(() => {
  jest.clearAllMocks();
  mockOwner = 'alice';
  __resetFailedMediaForTests();
});
it('retries a failed plain voice download without changing the URL or consent', async () => {
  jest
    .mocked(resolveRemoteMedia)
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce('file:///alice/voice');
  const { result } = renderHook(() => useRemoteMedia(url, MEDIA_MAX_BYTES));
  await waitFor(() => expect(result.current.failed).toBe(true));
  expect(result.current.uri).toBeNull();
  act(() => result.current.retry());
  await waitFor(() => expect(result.current.uri).toBe('file:///alice/voice'));
  expect(result.current.failed).toBe(false);
  expect(resolveRemoteMedia).toHaveBeenCalledTimes(2);
  expect(resolveRemoteMedia).toHaveBeenLastCalledWith(url, MEDIA_MAX_BYTES);
});
it('clears failure on account change and ignores a late previous-account result', async () => {
  let finish!: (uri: string) => void;
  jest
    .mocked(resolveRemoteMedia)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockRejectedValueOnce(new Error('offline'));
  const { result, rerender } = renderHook(() => useRemoteMedia(url, MEDIA_MAX_BYTES));
  mockOwner = 'bob';
  rerender({});
  await waitFor(() => expect(result.current.failed).toBe(true));
  await act(async () => finish('file:///alice/voice'));
  expect(result.current.uri).toBeNull();
  mockOwner = 'carol';
  jest.mocked(resolveRemoteMedia).mockResolvedValueOnce('file:///carol/voice');
  rerender({});
  expect(result.current.failed).toBe(false);
  await waitFor(() => expect(result.current.uri).toBe('file:///carol/voice'));
});
it('does not download or retry before consent', async () => {
  const { result } = renderHook(() => useRemoteMedia(null, MEDIA_MAX_BYTES));
  act(() => result.current.retry());
  await act(async () => {});
  expect(resolveRemoteMedia).not.toHaveBeenCalled();
});

describe('useRemoteMediaWithAutoRetry: per-session failed-URL memory', () => {
  const image = 'https://example.com/gone.jpg';
  const mount = () => renderHook(() => useRemoteMediaWithAutoRetry(image, MEDIA_MAX_BYTES, 0));

  it('a dead URL costs its two downloads once; a remounted row shows "tap to retry" without fetching', async () => {
    jest.mocked(resolveRemoteMedia).mockRejectedValue(new Error('404'));
    const first = mount();
    await waitFor(() => expect(first.result.current.failed).toBe(true));
    expect(resolveRemoteMedia).toHaveBeenCalledTimes(2); // load + automatic retry
    expect(hasFailedMedia(image)).toBe(true);
    first.unmount();

    // A recycled / remounted row meeting the same URL.
    const second = mount();
    expect(second.result.current.failed).toBe(true);
    expect(second.result.current.uri).toBeNull();
    await act(async () => {});
    expect(resolveRemoteMedia).toHaveBeenCalledTimes(2);
  });

  it('a retry tap on a remembered URL downloads once and forgets it on success', async () => {
    jest.mocked(resolveRemoteMedia).mockRejectedValue(new Error('404'));
    const first = mount();
    await waitFor(() => expect(first.result.current.failed).toBe(true));
    first.unmount();

    jest.mocked(resolveRemoteMedia).mockReset().mockResolvedValueOnce('file:///back');
    const second = mount();
    act(() => second.result.current.retry());
    expect(hasFailedMedia(image)).toBe(false);
    await waitFor(() => expect(second.result.current.uri).toBe('file:///back'));
    expect(second.result.current.failed).toBe(false);
    expect(resolveRemoteMedia).toHaveBeenCalledTimes(1);
  });

  it('a retry tap that fails again costs one download (no extra auto-retry) and is remembered again', async () => {
    jest.mocked(resolveRemoteMedia).mockRejectedValue(new Error('404'));
    const first = mount();
    await waitFor(() => expect(first.result.current.failed).toBe(true));
    first.unmount();

    jest.mocked(resolveRemoteMedia).mockClear();
    const second = mount();
    act(() => second.result.current.retry());
    await waitFor(() => expect(resolveRemoteMedia).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(second.result.current.failed).toBe(true));
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(resolveRemoteMedia).toHaveBeenCalledTimes(1);
    expect(hasFailedMedia(image)).toBe(true);
  });

  it('remembers an undecodable image too, which already skips the automatic retry', async () => {
    jest.mocked(resolveRemoteMedia).mockResolvedValue('file:///html-page');
    const first = mount();
    await waitFor(() => expect(first.result.current.uri).toBe('file:///html-page'));
    act(() => first.result.current.reportBroken());
    await waitFor(() => expect(first.result.current.failed).toBe(true));
    expect(resolveRemoteMedia).toHaveBeenCalledTimes(1);
    expect(hasFailedMedia(image)).toBe(true);
    first.unmount();

    const second = mount();
    expect(second.result.current.failed).toBe(true);
    await act(async () => {});
    expect(resolveRemoteMedia).toHaveBeenCalledTimes(1);
  });

  it('a transient failure that the automatic retry fixes is not remembered', async () => {
    jest
      .mocked(resolveRemoteMedia)
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('file:///ok');
    const { result } = mount();
    await waitFor(() => expect(result.current.uri).toBe('file:///ok'));
    expect(hasFailedMedia(image)).toBe(false);
  });
});
