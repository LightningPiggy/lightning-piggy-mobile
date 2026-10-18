import { act, renderHook } from '@testing-library/react-native';
import { useRelayPublishSheet } from './useRelayPublishSheet';
import { Toast } from '../components/BrandedToast';
import { setCurrentUserPubkey } from '../services/nostrActiveAccount';
import type { PublishProgress } from '../utils/relayPublishProgress';

jest.mock('../components/BrandedToast', () => ({ Toast: { show: jest.fn() } }));
jest.mock('../contexts/LocaleContext', () => ({ useTranslation: () => (key: string) => key }));
const pk = 'a'.repeat(64);
const accepted = { url: 'wss://accepted', ok: true };
const rejected = { url: 'wss://rejected', ok: false, message: 'blocked: payment required' };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}
beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  setCurrentUserPubkey(pk);
});
afterEach(() => {
  jest.useRealTimers();
  setCurrentUserPubkey(null);
});
it('opens before the signer resolves, batches relay progress, and keeps the final result', async () => {
  const outcome = deferred<{ ok: true; results: (typeof accepted)[] }>();
  let progress!: PublishProgress;
  const publish = jest.fn((callback: PublishProgress) => {
    progress = callback;
    callback({ targets: [accepted.url, rejected.url] });
    return outcome.promise;
  });
  const { result } = renderHook(() => useRelayPublishSheet(pk));
  let running!: Promise<void>;
  act(() => {
    running = result.current.run('Your relays (NIP-65)', publish, 'publishedRelays');
  });
  expect(result.current.open).toBe(true);
  expect(result.current.phase).toBe('waiting');
  expect(result.current.rows.map((row) => row.status)).toEqual(['pending', 'pending']);
  act(() => {
    progress({ signed: true });
    progress({ result: accepted });
    progress({ result: rejected });
    jest.advanceTimersByTime(150);
  });
  expect(result.current.phase).toBe('publishing');
  expect(result.current.rows).toEqual([
    { url: accepted.url, status: 'accepted' },
    { url: rejected.url, status: 'rejected', reason: rejected.message },
  ]);
  await act(async () => {
    outcome.resolve({ ok: true, results: [accepted, rejected] });
    await running;
  });
  expect(result.current.phase).toBe('finished');
  expect(Toast.show).not.toHaveBeenCalled();
});
it.each(['dismiss', 'unmount'] as const)(
  'continues publishing after %s and delivers the result through a toast',
  async (action) => {
    const outcome = deferred<{ ok: true; results: (typeof accepted)[] }>();
    const { result, unmount } = renderHook(() => useRelayPublishSheet(pk));
    let running!: Promise<void>;
    act(() => {
      running = result.current.run('Publishing', () => outcome.promise, 'publishedRelays');
    });
    act(() => {
      if (action === 'dismiss') result.current.dismiss();
      else unmount();
    });
    await act(async () => {
      outcome.resolve({ ok: true, results: [accepted] });
      await running;
    });
    expect(Toast.show).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'success',
        text2: expect.stringContaining('relayPublishSheet.accepted'),
      }),
    );
  },
);
it('ignores a stale account result and prevents duplicate taps', async () => {
  const outcome = deferred<{ ok: true; results: (typeof accepted)[] }>();
  const publish = jest.fn(() => outcome.promise);
  const { result, rerender } = renderHook<
    ReturnType<typeof useRelayPublishSheet>,
    { owner: string }
  >(({ owner }) => useRelayPublishSheet(owner), { initialProps: { owner: pk } });
  let running!: Promise<void>;
  act(() => {
    running = result.current.run('Publishing', publish, 'publishedRelays');
    void result.current.run('Publishing', publish, 'publishedRelays');
  });
  expect(publish).toHaveBeenCalledTimes(1);
  setCurrentUserPubkey('b'.repeat(64));
  rerender({ owner: 'b'.repeat(64) });
  await act(async () => {
    outcome.resolve({ ok: true, results: [accepted] });
    await running;
  });
  expect(Toast.show).not.toHaveBeenCalled();
  expect(result.current.rows).toEqual([]);
  expect(result.current.open).toBe(false);
});
it('shows signer refusal or thrown failures without leaving a spinner running', async () => {
  const { result } = renderHook(() => useRelayPublishSheet(pk));
  await act(async () => {
    await result.current.run(
      'Publishing',
      async () => ({ ok: false, error: 'not-signed' }),
      'publishedRelays',
    );
  });
  expect(result.current.phase).toBe('finished');
  expect(result.current.error).toBe('publishedRelays.error.not-signed');
  await act(async () => {
    await result.current.run(
      'Publishing',
      async () => {
        throw new Error('signer');
      },
      'publishedRelays',
    );
  });
  expect(result.current.phase).toBe('finished');
});
