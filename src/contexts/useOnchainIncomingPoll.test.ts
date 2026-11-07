/**
 * Unit tests for the on-chain incoming-payment poll (#134, #1725).
 *
 * The hook drives a gentle background sweep of every on-chain wallet so
 * a mempool credit trips WalletContext's balance-diff receive detector.
 * Its lifecycle is non-trivial, so the contract is pinned here:
 *
 *   1. No BDK sync during cold start: the first sweep runs
 *      ONCHAIN_BOOT_DELAY_MS after launch, then every 2 minutes.
 *   2. It sweeps only on-chain wallets and commits a refreshed balance,
 *      skipping the write when nothing changed. No on-chain wallets → no work.
 *   3. A background→active transition sweeps after a ~3 s stagger (never
 *      inside the boot window); leaving the foreground cancels it.
 *   4. A wallet whose sync fails backs off exponentially (capped), without
 *      holding up healthy wallets; a success resets it.
 *   5. Overlapping triggers can't start a second concurrent sweep.
 *   6. Unmounting removes the AppState subscription and the pending timer.
 */
import { renderHook, act } from '@testing-library/react-native';
import { AppState } from 'react-native';
import type { MutableRefObject } from 'react';

import {
  ONCHAIN_BOOT_DELAY_MS,
  ONCHAIN_RESUME_DELAY_MS,
  ONCHAIN_RESUME_MIN_GAP_MS,
  useOnchainIncomingPoll,
} from './useOnchainIncomingPoll';
import {
  __onchainSyncBackoffSize,
  clearOnchainSyncBackoff,
  isOnchainSyncBackedOff,
  noteOnchainSyncSuccess,
  onchainRetryDelayMs,
  recordOnchainSyncFailure,
} from '../services/onchainSyncBackoff';
import * as onchainService from '../services/onchainService';
import type { WalletState } from '../types/wallet';

jest.mock('../services/onchainService', () => ({
  __esModule: true,
  getBalance: jest.fn(),
}));

const mockedGetBalance = onchainService.getBalance as jest.MockedFunction<
  typeof onchainService.getBalance
>;

const MIN = 60_000;
const POLL_MS = 2 * MIN;

// Captures the 'change' handler the hook registers so tests can drive
// AppState transitions without a real native event.
let latestChangeHandler: ((next: string) => void) | null = null;
const removeSub = jest.fn();
const captureIdentity = () => () => true;

function wallet(id: string, walletType: WalletState['walletType'], balance: number): WalletState {
  return { id, walletType, balance } as WalletState;
}

function refOf(wallets: WalletState[]): MutableRefObject<WalletState[]> {
  return { current: wallets };
}

function mount(wallets: WalletState[], updateWalletInState = jest.fn()) {
  const view = renderHook(() =>
    useOnchainIncomingPoll({
      captureIdentity,
      wallets,
      walletsRef: refOf(wallets),
      updateWalletInState,
    }),
  );
  return { ...view, updateWalletInState };
}

const advance = (ms: number) => act(() => jest.advanceTimersByTimeAsync(ms));
const setAppState = (next: 'active' | 'background' | 'inactive') =>
  act(async () => {
    (AppState as unknown as { currentState: string }).currentState = next;
    latestChangeHandler?.(next);
  });
const callsFor = (id: string) => mockedGetBalance.mock.calls.filter(([w]) => w === id).length;

beforeEach(() => {
  jest.useFakeTimers();
  clearOnchainSyncBackoff(); // module state: don't leak backoff between tests
  jest.clearAllMocks();
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

describe('onchainRetryDelayMs', () => {
  it('doubles from 4 min and caps at 30 min', () => {
    expect([0, 1, 2, 3, 4, 10].map(onchainRetryDelayMs)).toEqual([
      0,
      4 * MIN,
      8 * MIN,
      16 * MIN,
      30 * MIN,
      30 * MIN,
    ]);
  });
});

describe('useOnchainIncomingPoll', () => {
  it('runs no BDK sync during cold start, then sweeps once the boot delay passes', async () => {
    mockedGetBalance.mockResolvedValue(500);
    const { updateWalletInState } = mount([wallet('oc', 'onchain', 100), wallet('ln', 'nwc', 0)]);

    await advance(ONCHAIN_BOOT_DELAY_MS - 1);
    expect(mockedGetBalance).not.toHaveBeenCalled();

    await advance(1);
    expect(mockedGetBalance).toHaveBeenCalledTimes(1);
    // Lightning wallet is never synced.
    expect(mockedGetBalance).toHaveBeenCalledWith('oc');
    expect(updateWalletInState).toHaveBeenCalledWith('oc', { balance: 500 });
  });

  it('keeps polling every 2 minutes while foregrounded', async () => {
    mockedGetBalance.mockResolvedValue(100);
    mount([wallet('oc', 'onchain', 100)]);
    await advance(ONCHAIN_BOOT_DELAY_MS);
    expect(mockedGetBalance).toHaveBeenCalledTimes(1);
    await advance(POLL_MS);
    await advance(POLL_MS);
    expect(mockedGetBalance).toHaveBeenCalledTimes(3);
  });

  it('skips the state write when the balance is unchanged', async () => {
    mockedGetBalance.mockResolvedValue(100);
    const { updateWalletInState } = mount([wallet('oc', 'onchain', 100)]);
    await advance(ONCHAIN_BOOT_DELAY_MS);
    expect(mockedGetBalance).toHaveBeenCalledTimes(1);
    expect(updateWalletInState).not.toHaveBeenCalled();
  });

  it('does no work and registers no polling when there are no on-chain wallets', async () => {
    mount([wallet('ln', 'nwc', 0)]);
    await advance(10 * MIN);
    expect(mockedGetBalance).not.toHaveBeenCalled();
    expect(AppState.addEventListener).not.toHaveBeenCalled();
  });

  it('staggers the resume sweep and cancels it when leaving the foreground', async () => {
    mockedGetBalance.mockResolvedValue(500);
    mount([wallet('oc', 'onchain', 100)]);
    await advance(ONCHAIN_BOOT_DELAY_MS);
    expect(mockedGetBalance).toHaveBeenCalledTimes(1);

    // Backgrounding stops the poll: nothing runs while away.
    await setAppState('background');
    await advance(10 * MIN);
    expect(mockedGetBalance).toHaveBeenCalledTimes(1);

    // Resume: not immediately, but after the stagger.
    await setAppState('active');
    await advance(ONCHAIN_RESUME_DELAY_MS - 1);
    expect(mockedGetBalance).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(mockedGetBalance).toHaveBeenCalledTimes(2);

    // Leaving again inside the stagger cancels the pending resume sweep.
    await setAppState('background');
    await setAppState('active');
    await advance(ONCHAIN_RESUME_DELAY_MS - 1);
    await setAppState('background');
    await advance(10 * MIN);
    expect(mockedGetBalance).toHaveBeenCalledTimes(2);
  });

  it('ignores iOS inactive flickers: no extra sweep, and the poll keeps running', async () => {
    mockedGetBalance.mockResolvedValue(100);
    mount([wallet('oc', 'onchain', 100)]);
    await advance(ONCHAIN_BOOT_DELAY_MS);
    expect(mockedGetBalance).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 5; i++) {
      await setAppState('inactive'); // notification shade, Face ID, share sheet
      await setAppState('active');
      await advance(ONCHAIN_RESUME_DELAY_MS);
    }
    expect(mockedGetBalance).toHaveBeenCalledTimes(1);
    await advance(POLL_MS - 5 * ONCHAIN_RESUME_DELAY_MS); // the 2-min cadence survives
    expect(mockedGetBalance).toHaveBeenCalledTimes(2);
  });

  it('skips a resume sweep right after one ran, but keeps the poll going', async () => {
    mockedGetBalance.mockResolvedValue(100);
    mount([wallet('oc', 'onchain', 100)]);
    await advance(ONCHAIN_BOOT_DELAY_MS);
    await advance(10_000);
    await setAppState('background'); // stops the timer
    await setAppState('active'); // 10 s after the last sweep
    await advance(ONCHAIN_RESUME_DELAY_MS);
    expect(mockedGetBalance).toHaveBeenCalledTimes(1);
    await advance(POLL_MS - 10_000 - ONCHAIN_RESUME_DELAY_MS);
    expect(mockedGetBalance).toHaveBeenCalledTimes(2);
  });

  it('waits out the boot delay even when resumed inside it', async () => {
    mockedGetBalance.mockResolvedValue(100);
    mount([wallet('oc', 'onchain', 100)]);
    await advance(5_000);
    await setAppState('background');
    await setAppState('active');
    await advance(ONCHAIN_BOOT_DELAY_MS - 5_000 - 1);
    expect(mockedGetBalance).not.toHaveBeenCalled();
    await advance(1);
    expect(mockedGetBalance).toHaveBeenCalledTimes(1);
  });

  it('backs a failing wallet off exponentially, without holding up a healthy one', async () => {
    mockedGetBalance.mockImplementation(async (id) => (id === 'bad' ? null : 100));
    mount([wallet('bad', 'onchain', 0), wallet('ok', 'onchain', 100)]);

    // Attempt times for `bad`: boot, then +4, +8, +16, +30, +30 min (rounded
    // up to the next 2-min tick). `ok` keeps its 2-min cadence throughout.
    await advance(ONCHAIN_BOOT_DELAY_MS);
    expect(callsFor('bad')).toBe(1);
    const attemptsAfter = async (minutes: number) => {
      await advance(minutes * MIN);
      return callsFor('bad');
    };
    expect(await attemptsAfter(2)).toBe(1); // in backoff: skipped
    expect(await attemptsAfter(2)).toBe(2); // +4 min
    expect(await attemptsAfter(6)).toBe(2);
    expect(await attemptsAfter(2)).toBe(3); // +8 min
    expect(await attemptsAfter(16)).toBe(4); // +16 min
    expect(await attemptsAfter(28)).toBe(4);
    expect(await attemptsAfter(2)).toBe(5); // +30 min (cap)
    expect(await attemptsAfter(30)).toBe(6); // still capped
    // 2 h of polling: ~60 failing syncs (and new Electrum connections) before, 6 now.
    expect(callsFor('ok')).toBe(1 + (2 + 2 + 6 + 2 + 16 + 28 + 2 + 30) / 2);
  });

  it('lifts the backoff on resume from background (the network may have changed)', async () => {
    let failing = true;
    mockedGetBalance.mockImplementation(async () => (failing ? null : 500));
    const { updateWalletInState } = mount([wallet('oc', 'onchain', 100)]);
    await advance(ONCHAIN_BOOT_DELAY_MS); // fail #1 → retry in 4 min
    await advance(4 * MIN); // fail #2 → retry in 8 min
    await advance(8 * MIN); // fail #3 → retry in 16 min
    expect(mockedGetBalance).toHaveBeenCalledTimes(3);

    // Out of the tunnel: a payment lands while backgrounded, then resume.
    failing = false;
    await setAppState('background');
    await advance(MIN);
    await setAppState('active');
    await advance(ONCHAIN_RESUME_DELAY_MS);
    expect(mockedGetBalance).toHaveBeenCalledTimes(4);
    expect(updateWalletInState).toHaveBeenCalledWith('oc', { balance: 500 });
  });

  it('lifts the backoff when the wallet syncs successfully elsewhere (pull-to-refresh)', async () => {
    mockedGetBalance.mockResolvedValue(null);
    mount([wallet('oc', 'onchain', 100)]);
    await advance(ONCHAIN_BOOT_DELAY_MS); // fail → retry in 4 min
    expect(isOnchainSyncBackedOff('oc')).toBe(true);
    // onchainService.syncAndRefresh reports any successful sync of the wallet.
    noteOnchainSyncSuccess('oc');
    mockedGetBalance.mockResolvedValue(100);
    await advance(POLL_MS); // the very next tick syncs it again
    expect(mockedGetBalance).toHaveBeenCalledTimes(2);
  });

  it('forgets other accounts and removed wallets', async () => {
    let generation = 0;
    const capture = () => {
      const ticket = generation;
      return () => ticket === generation;
    };
    mockedGetBalance.mockResolvedValue(100);
    const wallets = [wallet('oc', 'onchain', 100)];
    renderHook(() =>
      useOnchainIncomingPoll({
        wallets,
        walletsRef: refOf(wallets),
        updateWalletInState: jest.fn(),
        captureIdentity: capture,
      }),
    );
    recordOnchainSyncFailure('gone'); // a wallet no longer in the list
    await advance(ONCHAIN_BOOT_DELAY_MS);
    expect(__onchainSyncBackoffSize()).toBe(0);

    recordOnchainSyncFailure('oc', Date.now());
    generation++; // account switch; the same wallet id may now be another wallet
    await advance(POLL_MS);
    expect(isOnchainSyncBackedOff('oc')).toBe(false);
    expect(mockedGetBalance).toHaveBeenCalledTimes(2);
  });

  it('resets the backoff after a successful sync', async () => {
    let failing = true;
    mockedGetBalance.mockImplementation(async () => (failing ? null : 100));
    mount([wallet('oc', 'onchain', 100)]);
    await advance(ONCHAIN_BOOT_DELAY_MS); // fail #1 → retry in 4 min
    await advance(4 * MIN); // fail #2 → retry in 8 min
    expect(mockedGetBalance).toHaveBeenCalledTimes(2);
    failing = false;
    await advance(8 * MIN); // success
    expect(mockedGetBalance).toHaveBeenCalledTimes(3);
    await advance(POLL_MS); // back on the 2-min cadence
    expect(mockedGetBalance).toHaveBeenCalledTimes(4);
  });

  it('treats a thrown sync like a failed one', async () => {
    mockedGetBalance.mockRejectedValue(new Error('electrum down'));
    mount([wallet('oc', 'onchain', 100)]);
    await advance(ONCHAIN_BOOT_DELAY_MS);
    await advance(POLL_MS);
    expect(mockedGetBalance).toHaveBeenCalledTimes(1);
    await advance(POLL_MS);
    expect(mockedGetBalance).toHaveBeenCalledTimes(2);
  });

  it('does not start a second concurrent sweep while one is in flight', async () => {
    let resolveBalance: (n: number) => void = () => {};
    mockedGetBalance.mockReturnValue(
      new Promise<number>((res) => {
        resolveBalance = res;
      }),
    );
    mount([wallet('oc', 'onchain', 100)]);
    await advance(ONCHAIN_BOOT_DELAY_MS);
    expect(mockedGetBalance).toHaveBeenCalledTimes(1);

    // A resume that lands mid-sweep (past the resume gap: a slow BDK sync)
    // must be dropped by the in-flight guard.
    await advance(ONCHAIN_RESUME_MIN_GAP_MS);
    await setAppState('active');
    await advance(ONCHAIN_RESUME_DELAY_MS);
    expect(mockedGetBalance).toHaveBeenCalledTimes(1);

    // Once the first sweep settles, later triggers proceed normally.
    await act(async () => resolveBalance(500));
    mockedGetBalance.mockResolvedValue(500);
    await advance(ONCHAIN_RESUME_MIN_GAP_MS);
    await setAppState('active');
    await advance(ONCHAIN_RESUME_DELAY_MS);
    expect(mockedGetBalance).toHaveBeenCalledTimes(2);
  });

  it('removes the AppState subscription and the pending timer on unmount', async () => {
    mockedGetBalance.mockResolvedValue(100);
    const { unmount } = mount([wallet('oc', 'onchain', 100)]);
    unmount();
    expect(removeSub).toHaveBeenCalled();
    await advance(10 * MIN);
    expect(mockedGetBalance).not.toHaveBeenCalled();
  });
});

it('discards an on-chain balance finishing in a later identity generation', async () => {
  let finish!: (n: number) => void;
  mockedGetBalance.mockReturnValueOnce(
    new Promise((r) => {
      finish = r;
    }),
  );
  let generation = 0;
  const capture = () => {
    const ticket = generation;
    return () => ticket === generation;
  };
  const updateWalletInState = jest.fn();
  const wallets = [wallet('oc', 'onchain', 100)];
  const ref = refOf(wallets);
  const view = renderHook(() =>
    useOnchainIncomingPoll({
      wallets,
      walletsRef: ref,
      updateWalletInState,
      captureIdentity: capture,
    }),
  );
  await advance(ONCHAIN_BOOT_DELAY_MS);
  generation += 2; // B → C → B, wallet id reused
  await act(async () => finish(999));
  expect(updateWalletInState).not.toHaveBeenCalled();
  view.unmount();
});
