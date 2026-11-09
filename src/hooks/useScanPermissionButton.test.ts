import { act, renderHook } from '@testing-library/react-native';
import { AppState, Linking } from 'react-native';
import { useScanPermissionButton } from './useScanPermissionButton';

const GRANTED = { granted: true, canAskAgain: true };
const BLOCKED = { granted: false, canAskAgain: false };

const mockGetPermission = jest.fn();
let mockInitial: typeof GRANTED | null = BLOCKED;
jest.mock('expo-camera', () => ({
  useCameraPermissions: () => [mockInitial, jest.fn(), mockGetPermission],
}));

let resume: ((state: string) => void) | null;
let remove: jest.Mock;

beforeEach(() => {
  jest.clearAllMocks();
  mockInitial = BLOCKED;
  resume = null;
  remove = jest.fn();
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, handler) => {
    resume = handler as (state: string) => void;
    return { remove } as unknown as ReturnType<typeof AppState.addEventListener>;
  });
  jest.spyOn(Linking, 'openSettings').mockResolvedValue(undefined);
});

afterEach(() => jest.restoreAllMocks());

async function returnToApp() {
  await act(async () => {
    resume?.('active');
  });
}

it('shows Open Settings while permanently denied', () => {
  const { result } = renderHook(() => useScanPermissionButton(false, jest.fn()));
  expect(result.current.blocked).toBe(true);
});

it('starts the camera with no extra tap after access is allowed in Settings', async () => {
  const request = jest.fn().mockResolvedValue(GRANTED);
  mockGetPermission.mockResolvedValue(GRANTED);
  const { result } = renderHook(() => useScanPermissionButton(false, request));

  await returnToApp();

  // The parent's request resolves without a prompt and flips its
  // `permissionGranted`, which swaps the button for the camera.
  expect(request).toHaveBeenCalledTimes(1);
  expect(result.current.blocked).toBe(false);
  expect(Linking.openSettings).not.toHaveBeenCalled();
});

it('keeps Open Settings when still denied on return', async () => {
  const request = jest.fn();
  mockGetPermission.mockResolvedValue(BLOCKED);
  const { result } = renderHook(() => useScanPermissionButton(false, request));

  await returnToApp();

  expect(request).not.toHaveBeenCalled();
  expect(result.current.blocked).toBe(true);
  expect(Linking.openSettings).not.toHaveBeenCalled();
});

it('ignores background transitions', async () => {
  renderHook(() => useScanPermissionButton(false, jest.fn()));
  await act(async () => {
    resume?.('background');
  });
  expect(mockGetPermission).not.toHaveBeenCalled();
});

it('removes the listener on unmount', () => {
  const { unmount } = renderHook(() => useScanPermissionButton(false, jest.fn()));
  expect(AppState.addEventListener).toHaveBeenCalledTimes(1);
  unmount();
  expect(remove).toHaveBeenCalledTimes(1);
});

it('removes the listener once granted, and never subscribes while granted', () => {
  const { rerender } = renderHook(
    ({ granted }: { granted: boolean }) => useScanPermissionButton(granted, jest.fn()),
    { initialProps: { granted: false } },
  );
  rerender({ granted: true });
  expect(remove).toHaveBeenCalledTimes(1);

  (AppState.addEventListener as jest.Mock).mockClear();
  mockInitial = GRANTED;
  renderHook(() => useScanPermissionButton(true, jest.fn()));
  expect(AppState.addEventListener).not.toHaveBeenCalled();
});

it('opens Settings when the button is tapped while blocked', async () => {
  const request = jest.fn().mockResolvedValue(BLOCKED);
  const { result } = renderHook(() => useScanPermissionButton(false, request));
  await act(async () => {
    await result.current.onPress();
  });
  expect(Linking.openSettings).toHaveBeenCalledTimes(1);
  expect(result.current.blocked).toBe(true);
});
