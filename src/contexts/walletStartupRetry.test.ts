/** In-session retry of a failed cold-start wallet load (#1746). */
import { AppState, type AppStateStatus } from 'react-native';
import { renderHook } from '@testing-library/react-native';
import {
  createWalletLoadRetry,
  useWalletLoadRetryOnResume,
  WALLET_RETRY_MAX_RESUME_ATTEMPTS,
  WALLET_RETRY_RESUME_DELAY_MS,
} from './walletStartupRetry';

let clock = 0;
const now = () => clock;
beforeEach(() => {
  clock = 0;
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it('does nothing until armed, and stops after a success', async () => {
  const load = jest.fn(async () => {});
  const retry = createWalletLoadRetry(load, now);
  await retry.attempt('resume');
  expect(load).not.toHaveBeenCalled();
  retry.arm(() => true);
  await retry.attempt('resume');
  expect(load).toHaveBeenCalledTimes(1);
  expect(retry.isArmed()).toBe(false);
  await retry.attempt('refresh');
  expect(load).toHaveBeenCalledTimes(1);
});

it('backs off between resume retries and gives up after the cap', async () => {
  const load = jest.fn(async () => {
    throw new Error('storage unavailable');
  });
  const retry = createWalletLoadRetry(load, now);
  retry.arm(() => true);
  await retry.attempt('resume');
  expect(load).toHaveBeenCalledTimes(1);
  // Inside the 5 s backoff: skipped.
  clock += 4_999;
  await retry.attempt('resume');
  expect(load).toHaveBeenCalledTimes(1);
  clock += 1;
  await retry.attempt('resume');
  expect(load).toHaveBeenCalledTimes(2);
  // The next wait doubled to 10 s.
  clock += 9_999;
  await retry.attempt('resume');
  expect(load).toHaveBeenCalledTimes(2);
  for (let i = 0; i < 10; i++) {
    clock += 10 * 60_000;
    await retry.attempt('resume');
  }
  expect(load).toHaveBeenCalledTimes(WALLET_RETRY_MAX_RESUME_ATTEMPTS);
  // A pull-to-refresh is the user asking: it still goes through.
  await retry.attempt('refresh');
  expect(load).toHaveBeenCalledTimes(WALLET_RETRY_MAX_RESUME_ATTEMPTS + 1);
});

it('drops the retry once the failed identity is superseded', async () => {
  let current = true;
  const load = jest.fn(async () => {});
  const retry = createWalletLoadRetry(load, now);
  retry.arm(() => current);
  current = false; // account switch: the identity hydration owns the load now
  expect(retry.isArmed()).toBe(false);
  await retry.attempt('refresh');
  expect(load).not.toHaveBeenCalled();
});

it('runs one retry at a time', async () => {
  let release!: () => void;
  const load = jest.fn(() => new Promise<void>((r) => (release = r)));
  const retry = createWalletLoadRetry(load, now);
  retry.arm(() => true);
  const first = retry.attempt('refresh');
  const second = retry.attempt('refresh');
  expect(load).toHaveBeenCalledTimes(1);
  release();
  await Promise.all([first, second]);
  expect(retry.isArmed()).toBe(false);
});

describe('useWalletLoadRetryOnResume', () => {
  let emit: (state: AppStateStatus) => void;
  const remove = jest.fn();
  beforeEach(() => {
    jest.useFakeTimers();
    jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
      emit = listener as (state: AppStateStatus) => void;
      return { remove } as unknown as ReturnType<typeof AppState.addEventListener>;
    });
  });
  afterEach(() => jest.useRealTimers());

  it('staggers the retry ~3 s after resume and cancels it on re-background', () => {
    const load = jest.fn(async () => {});
    const retry = createWalletLoadRetry(load);
    retry.arm(() => true);
    const { unmount } = renderHook(() => useWalletLoadRetryOnResume(retry));

    emit('active');
    jest.advanceTimersByTime(WALLET_RETRY_RESUME_DELAY_MS - 1);
    expect(load).not.toHaveBeenCalled();
    emit('background');
    jest.advanceTimersByTime(WALLET_RETRY_RESUME_DELAY_MS);
    expect(load).not.toHaveBeenCalled();

    emit('active');
    jest.advanceTimersByTime(WALLET_RETRY_RESUME_DELAY_MS);
    expect(load).toHaveBeenCalledTimes(1);
    unmount();
    expect(remove).toHaveBeenCalled();
  });

  it('schedules nothing while the load is not armed', () => {
    const load = jest.fn(async () => {});
    renderHook(() => useWalletLoadRetryOnResume(createWalletLoadRetry(load)));
    emit('active');
    jest.advanceTimersByTime(WALLET_RETRY_RESUME_DELAY_MS * 2);
    expect(load).not.toHaveBeenCalled();
  });
});
