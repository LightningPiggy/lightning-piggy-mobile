/**
 * Active NWC wallet balance refresh (#657): immediate on focus, staggered on
 * foreground resume (#554), cancelled on re-background, skipped when fresh.
 */
import { renderHook, act } from '@testing-library/react-native';
import { AppState } from 'react-native';

import {
  BALANCE_RESUME_DELAY_MS,
  BALANCE_RESUME_MIN_GAP_MS,
  useActiveWalletBalanceRefresh,
} from './useActiveWalletBalanceRefresh';
import * as nwcService from '../services/nwcService';
import type { WalletState } from '../types/wallet';

jest.mock('../services/nwcService', () => ({
  __esModule: true,
  getBalance: jest.fn(),
  isRelayInCooldown: jest.fn(() => false),
}));

const mockedGetBalance = nwcService.getBalance as jest.MockedFunction<typeof nwcService.getBalance>;

let latestChangeHandler: ((next: string) => void) | null = null;
const removeSub = jest.fn();
const captureIdentity = () => () => true;
const wallets = [{ id: 'nwc', walletType: 'nwc', isConnected: true, balance: 1 } as WalletState];

function mount(demand = 1, updateWalletInState = jest.fn()) {
  return {
    updateWalletInState,
    ...renderHook(() =>
      useActiveWalletBalanceRefresh({
        activeWalletId: 'nwc',
        activeWalletConnected: true,
        balancePollDemand: demand,
        walletsRef: { current: wallets },
        captureIdentity,
        updateWalletInState,
      }),
    ),
  };
}

const advance = (ms: number) => act(() => jest.advanceTimersByTimeAsync(ms));
const setAppState = (next: 'active' | 'background' | 'inactive') =>
  act(async () => {
    (AppState as unknown as { currentState: string }).currentState = next;
    latestChangeHandler?.(next);
  });

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  mockedGetBalance.mockResolvedValue(42);
  latestChangeHandler = null;
  (AppState as unknown as { currentState: string }).currentState = 'active';
  jest.spyOn(AppState, 'addEventListener').mockImplementation((type, handler) => {
    if (type === 'change') latestChangeHandler = handler as (next: string) => void;
    return { remove: removeSub } as unknown as ReturnType<typeof AppState.addEventListener>;
  });
});

afterEach(() => {
  jest.useRealTimers();
  (AppState.addEventListener as jest.Mock).mockRestore?.();
});

describe('useActiveWalletBalanceRefresh', () => {
  it('refreshes at once when a balance surface gains focus', async () => {
    const { updateWalletInState } = mount();
    await advance(0);
    expect(mockedGetBalance).toHaveBeenCalledTimes(1);
    expect(updateWalletInState).toHaveBeenCalledWith('nwc', { balance: 42 });
  });

  it('does nothing while no surface needs the balance', async () => {
    mount(0);
    await advance(60_000);
    expect(mockedGetBalance).not.toHaveBeenCalled();
  });

  it('staggers the resume refresh instead of firing on the transition', async () => {
    mount();
    await advance(BALANCE_RESUME_MIN_GAP_MS);
    expect(mockedGetBalance).toHaveBeenCalledTimes(1);

    await setAppState('background');
    await setAppState('active');
    expect(mockedGetBalance).toHaveBeenCalledTimes(1);
    await advance(BALANCE_RESUME_DELAY_MS - 1);
    expect(mockedGetBalance).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mockedGetBalance).toHaveBeenCalledTimes(2);
  });

  it('cancels a pending resume refresh when the app backgrounds again', async () => {
    mount();
    await advance(BALANCE_RESUME_MIN_GAP_MS);
    await setAppState('background');
    await setAppState('active');
    await advance(BALANCE_RESUME_DELAY_MS - 1);
    await setAppState('background');
    await advance(60_000);
    expect(mockedGetBalance).toHaveBeenCalledTimes(1);
  });

  it('skips a resume refresh when the balance was refreshed moments ago', async () => {
    mount();
    await advance(1_000);
    await setAppState('inactive');
    await setAppState('active');
    await advance(BALANCE_RESUME_DELAY_MS * 2);
    expect(mockedGetBalance).toHaveBeenCalledTimes(1);
  });

  it('still refreshes on the next resume when the previous refresh failed', async () => {
    mockedGetBalance.mockResolvedValueOnce(null);
    mount();
    await advance(1_000);
    expect(mockedGetBalance).toHaveBeenCalledTimes(1);
    await setAppState('background');
    await setAppState('active');
    await advance(BALANCE_RESUME_DELAY_MS);
    expect(mockedGetBalance).toHaveBeenCalledTimes(2);
  });

  it("does not let another wallet's fresh balance suppress the resume refresh", async () => {
    const both = [
      { id: 'a', walletType: 'nwc', isConnected: true, balance: 1 },
      { id: 'b', walletType: 'nwc', isConnected: true, balance: 1 },
    ] as WalletState[];
    const update = jest.fn();
    const view = renderHook(
      ({ id }: { id: string }) =>
        useActiveWalletBalanceRefresh({
          activeWalletId: id,
          activeWalletConnected: true,
          balancePollDemand: 1,
          walletsRef: { current: both },
          captureIdentity,
          updateWalletInState: update,
        }),
      { initialProps: { id: 'a' } },
    );
    await advance(1_000); // wallet a refreshed
    await setAppState('background');
    view.rerender({ id: 'b' }); // b becomes active; focus refresh is skipped while backgrounded
    mockedGetBalance.mockClear();
    await setAppState('active');
    await advance(BALANCE_RESUME_DELAY_MS);
    expect(mockedGetBalance).toHaveBeenCalledWith('b', expect.anything());
  });

  it('clears the pending resume timer and subscription on unmount', async () => {
    const { unmount } = mount();
    await advance(BALANCE_RESUME_MIN_GAP_MS);
    await setAppState('background');
    await setAppState('active');
    unmount();
    expect(removeSub).toHaveBeenCalled();
    await advance(60_000);
    expect(mockedGetBalance).toHaveBeenCalledTimes(1);
  });
});
