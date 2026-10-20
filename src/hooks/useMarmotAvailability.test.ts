import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useMarmotAvailability } from './useMarmotAvailability';
import { resetMarmotAvailabilityCache } from '../utils/marmotAvailability';
import { MarmotKeyPackageLookupError } from '../services/marmotKeyPackages';

const peer = 'b'.repeat(64);
const canMessage = jest.fn();
const mockSession = {
  pubkey: 'a'.repeat(64),
  ready: Promise.resolve(),
  findDm: () => undefined,
  canMessage,
};
jest.mock('../services/marmotSession', () => ({ getMarmotSession: () => mockSession }));

beforeEach(() => {
  resetMarmotAvailabilityCache();
  canMessage.mockReset();
});

it('is idle while the picker is closed or has no contact', () => {
  const closed = renderHook(() => useMarmotAvailability(peer, false));
  expect(closed.result.current.availability).toBeNull();
  const none = renderHook(() => useMarmotAvailability(null, true));
  expect(none.result.current.availability).toBeNull();
  expect(canMessage).not.toHaveBeenCalled();
});

it('shows checking, then the answer; a reopen reads the cache without re-checking', async () => {
  canMessage.mockResolvedValue(false);
  const h = renderHook(({ open }: { open: boolean }) => useMarmotAvailability(peer, open), {
    initialProps: { open: true },
  });
  expect(h.result.current.availability).toBe('checking');
  await waitFor(() => expect(h.result.current.availability).toBe('unavailable'));
  h.rerender({ open: false });
  expect(h.result.current.availability).toBeNull();
  h.rerender({ open: true });
  expect(h.result.current.availability).toBe('unavailable');
  expect(canMessage).toHaveBeenCalledTimes(1);
});

it('surfaces a failed lookup as an error that retry re-checks', async () => {
  canMessage.mockRejectedValueOnce(new MarmotKeyPackageLookupError(peer)).mockResolvedValue(true);
  const h = renderHook(() => useMarmotAvailability(peer, true));
  await waitFor(() => expect(h.result.current.availability).toBe('error'));
  act(() => h.result.current.retry());
  expect(h.result.current.availability).toBe('checking');
  await waitFor(() => expect(h.result.current.availability).toBe('available'));
  expect(canMessage).toHaveBeenCalledTimes(2);
});
