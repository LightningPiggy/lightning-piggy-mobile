import { renderHook, act } from '@testing-library/react-native';
import { InteractionManager } from 'react-native';
import { useDmCatchUpOnOpen } from './useDmCatchUpOnOpen';

const mockArm = jest.fn();
const mockRefresh = jest.fn(
  async (_opts: { includeNonFollows: boolean; signal: AbortSignal }) => {},
);
let mockTier = 'friends';
jest.mock('../contexts/NostrContext', () => ({
  useNostrDmInbox: () => ({ armLiveDmSub: mockArm, refreshDmInbox: mockRefresh }),
}));
// Focus = mount here: the screen under test is always focused.
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => void | (() => void)) =>
    jest.requireActual('react').useEffect(effect, [effect]),
}));
jest.mock('../contexts/GroupsContext', () => ({
  useGroups: () => ({ effectiveWotTier: mockTier }),
}));

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  jest.spyOn(InteractionManager, 'runAfterInteractions').mockImplementation((task?: unknown) => {
    queueMicrotask(() => (task as () => void)());
    return { cancel: jest.fn() } as unknown as ReturnType<
      typeof InteractionManager.runAfterInteractions
    >;
  });
});
afterEach(() => jest.useRealTimers());

it('arms the live sub and catches up once the chat has painted (#1325)', async () => {
  mockTier = 'all';
  const { rerender } = renderHook(() => useDmCatchUpOnOpen(true));
  expect(mockArm).toHaveBeenCalledTimes(1);
  expect(mockRefresh).not.toHaveBeenCalled();
  await act(async () => {
    await Promise.resolve();
    jest.advanceTimersByTime(120);
  });
  expect(mockRefresh).toHaveBeenCalledTimes(1);
  expect(mockRefresh.mock.calls[0][0].includeNonFollows).toBe(true);
  // Re-renders don't refresh again.
  rerender({});
  await act(async () => {
    await Promise.resolve();
    jest.advanceTimersByTime(500);
  });
  expect(mockRefresh).toHaveBeenCalledTimes(1);
});

it('aborts the catch-up when the chat closes', async () => {
  mockTier = 'friends';
  const { unmount } = renderHook(() => useDmCatchUpOnOpen(true));
  await act(async () => {
    await Promise.resolve();
    jest.advanceTimersByTime(120);
  });
  const { includeNonFollows, signal } = mockRefresh.mock.calls[0][0];
  expect(includeNonFollows).toBe(false);
  expect(signal.aborted).toBe(false);
  unmount();
  expect(signal.aborted).toBe(true);
});

it('waits for sign-in before catching up (cold start)', async () => {
  const { rerender } = renderHook(
    ({ loggedIn }: { loggedIn: boolean }) => useDmCatchUpOnOpen(loggedIn),
    {
      initialProps: { loggedIn: false },
    },
  );
  await act(async () => {
    await Promise.resolve();
    jest.advanceTimersByTime(500);
  });
  expect(mockRefresh).not.toHaveBeenCalled();
  rerender({ loggedIn: true });
  await act(async () => {
    await Promise.resolve();
    jest.advanceTimersByTime(120);
  });
  expect(mockRefresh).toHaveBeenCalledTimes(1);
});
