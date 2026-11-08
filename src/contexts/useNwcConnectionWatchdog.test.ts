import { act, renderHook } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import * as nwcService from '../services/nwcService';
import * as walletStorage from '../services/walletStorageService';
import type { WalletState } from '../types/wallet';
import {
  HEALTH_SYNC_COALESCE_MS,
  PROBE_REPLY_TIMEOUT_MS,
  WATCHDOG_INTERVAL_MS,
  WATCHDOG_RESUME_DELAY_MS,
  useNwcConnectionWatchdog,
} from './useNwcConnectionWatchdog';

jest.mock('../services/nwcService', () => ({
  connect: jest.fn(async () => ({ success: true })),
  isWalletConnected: jest.fn(() => false),
  isSocketConnected: jest.fn(() => false),
  isRelayInCooldown: jest.fn(() => false),
  isConnectionInProgress: jest.fn(() => false),
  getWalletHealth: jest.fn(() => 'disconnected'),
  getBalance: jest.fn(async () => 1234),
  shouldProbeWallet: jest.fn(() => true),
  markWalletProbed: jest.fn(),
  subscribeWalletHealth: jest.fn(() => () => {}),
  isBalanceInFlight: jest.fn(() => false),
}));

const wallets = [
  { id: 'busy', walletType: 'nwc' },
  { id: 'idle', walletType: 'nwc' },
] as WalletState[];

let appStateListener: ((s: AppStateStatus) => void) | null = null;
const setAppState = (s: AppStateStatus) => {
  Object.defineProperty(AppState, 'currentState', { value: s, configurable: true });
};

beforeEach(() => {
  jest.clearAllMocks();
  jest.useFakeTimers();
  jest.spyOn(walletStorage, 'getNwcUrl').mockResolvedValue('nostr+walletconnect://fixture');
  setAppState('active');
  appStateListener = null;
  jest.spyOn(AppState, 'addEventListener').mockImplementation((_type, listener) => {
    appStateListener = listener as (s: AppStateStatus) => void;
    return { remove: jest.fn() };
  });
  jest.mocked(nwcService.connect).mockResolvedValue({ success: true });
  jest.mocked(nwcService.isWalletConnected).mockReturnValue(false);
  jest.mocked(nwcService.isSocketConnected).mockReturnValue(false);
  jest.mocked(nwcService.isRelayInCooldown).mockReturnValue(false);
  jest.mocked(nwcService.isConnectionInProgress).mockReturnValue(false);
  jest.mocked(nwcService.getWalletHealth).mockReturnValue('disconnected');
  jest.mocked(nwcService.getBalance).mockResolvedValue(1234);
  jest.mocked(nwcService.shouldProbeWallet).mockReturnValue(true);
  jest.mocked(nwcService.subscribeWalletHealth).mockReturnValue(() => {});
  jest.mocked(nwcService.isBalanceInFlight).mockReturnValue(false);
});
afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
});

const mount = (list: WalletState[], update = jest.fn()) =>
  renderHook(() => useNwcConnectionWatchdog({ current: list }, update, () => () => true));

const tick = async (ms: number) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
};

it('does not supersede a handshake that is already in flight', async () => {
  jest.mocked(nwcService.isConnectionInProgress).mockImplementation((id) => id === 'busy');
  const { unmount } = mount(wallets);
  await tick(WATCHDOG_INTERVAL_MS);
  expect(nwcService.connect).toHaveBeenCalledTimes(1);
  expect(nwcService.connect).toHaveBeenCalledWith(
    'idle',
    'nostr+walletconnect://fixture',
    undefined,
    expect.any(Function),
  );
  unmount();
});

describe('liveness probe (#1768)', () => {
  const live = [{ id: 'w1', walletType: 'nwc', balance: 1000, isConnected: true }] as WalletState[];

  beforeEach(() => {
    jest.mocked(nwcService.isWalletConnected).mockReturnValue(true);
    jest.mocked(nwcService.isSocketConnected).mockReturnValue(true);
  });

  it('probes an idle connected wallet with one bounded get_balance and stores the balance', async () => {
    const update = jest.fn();
    const { unmount } = mount(live, update);
    await tick(WATCHDOG_INTERVAL_MS);
    expect(nwcService.markWalletProbed).toHaveBeenCalledWith('w1');
    expect(nwcService.getBalance).toHaveBeenCalledWith('w1', {
      replyTimeoutMs: PROBE_REPLY_TIMEOUT_MS,
    });
    expect(update).toHaveBeenCalledWith('w1', { balance: 1234 });
    expect(nwcService.connect).not.toHaveBeenCalled();
    unmount();
  });

  it('does not overwrite a balance stored while the probe was out (#1768 review)', async () => {
    const list = [
      { id: 'w1', walletType: 'nwc', balance: 1000, isConnected: true },
    ] as WalletState[];
    let resolveProbe!: (v: number) => void;
    jest
      .mocked(nwcService.getBalance)
      .mockImplementationOnce(() => new Promise<number | null>((r) => (resolveProbe = r)));
    const update = jest.fn();
    const { unmount } = mount(list, update);
    await tick(WATCHDOG_INTERVAL_MS);
    // A post-payment read lands first and stores the newer balance…
    list[0] = { ...list[0], balance: 400 };
    // …then the probe's older reply arrives.
    await act(async () => resolveProbe(1000));
    expect(update).not.toHaveBeenCalledWith('w1', { balance: 1000 });
    unmount();
  });

  it('skips the probe when the wallet answered recently (throttle says no)', async () => {
    jest.mocked(nwcService.shouldProbeWallet).mockReturnValue(false);
    const { unmount } = mount(live);
    await tick(WATCHDOG_INTERVAL_MS);
    expect(nwcService.getBalance).not.toHaveBeenCalled();
    unmount();
  });

  it('respects the relay cooldown / rate-limit back-off', async () => {
    jest.mocked(nwcService.isRelayInCooldown).mockReturnValue(true);
    const { unmount } = mount(live);
    await tick(WATCHDOG_INTERVAL_MS);
    expect(nwcService.getBalance).not.toHaveBeenCalled();
    expect(nwcService.markWalletProbed).not.toHaveBeenCalled();
    unmount();
  });

  it('skips the probe while a get_balance for that wallet is already in flight', async () => {
    jest.mocked(nwcService.isBalanceInFlight).mockReturnValue(true);
    const { unmount } = mount(live);
    await tick(WATCHDOG_INTERVAL_MS);
    expect(nwcService.getBalance).not.toHaveBeenCalled();
    expect(nwcService.markWalletProbed).not.toHaveBeenCalled();
    unmount();
  });

  it('never probes a handshake in flight or while the app is backgrounded', async () => {
    jest.mocked(nwcService.isConnectionInProgress).mockReturnValue(true);
    const first = mount(live);
    await tick(WATCHDOG_INTERVAL_MS);
    expect(nwcService.getBalance).not.toHaveBeenCalled();
    first.unmount();

    jest.mocked(nwcService.isConnectionInProgress).mockReturnValue(false);
    setAppState('background');
    const second = mount(live);
    await tick(WATCHDOG_INTERVAL_MS);
    expect(nwcService.getBalance).not.toHaveBeenCalled();
    second.unmount();
  });

  it('syncs the four-state health after the probe (writes only on change)', async () => {
    jest.mocked(nwcService.getWalletHealth).mockReturnValue('checking');
    const update = jest.fn();
    const { unmount } = mount(live, update);
    await tick(WATCHDOG_INTERVAL_MS);
    expect(update).toHaveBeenCalledWith('w1', { isConnected: true, connectionHealth: 'checking' });
    unmount();
  });
});

describe('resume stagger (#1768, CLAUDE.md #554/#1031)', () => {
  const live = [{ id: 'w1', walletType: 'nwc', balance: 1000, isConnected: true }] as WalletState[];

  beforeEach(() => {
    jest.mocked(nwcService.isWalletConnected).mockReturnValue(true);
    jest.mocked(nwcService.isSocketConnected).mockReturnValue(true);
  });

  it('runs the check ~3 s after resume, not immediately', async () => {
    const { unmount } = mount(live);
    act(() => appStateListener?.('active'));
    await tick(WATCHDOG_RESUME_DELAY_MS - 1);
    expect(nwcService.getBalance).not.toHaveBeenCalled();
    await tick(1);
    expect(nwcService.getBalance).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('skips an overdue interval tick that lands inside the resume stagger window', async () => {
    const { unmount } = mount(live);
    // Resume 1 s before the 30 s tick: the tick must not probe unstaggered.
    await tick(WATCHDOG_INTERVAL_MS - 1_000);
    act(() => appStateListener?.('active'));
    await tick(1_000);
    expect(nwcService.getBalance).not.toHaveBeenCalled();
    // The staggered resume pass still runs once at +3 s.
    await tick(WATCHDOG_RESUME_DELAY_MS - 1_000);
    expect(nwcService.getBalance).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('syncs every wallet health before any probe goes out (#1768 review)', async () => {
    const list = [
      { id: 'w1', walletType: 'nwc', isConnected: true, connectionHealth: 'responsive' },
      { id: 'w2', walletType: 'nwc', isConnected: true, connectionHealth: 'responsive' },
    ] as WalletState[];
    jest.mocked(nwcService.getWalletHealth).mockReturnValue('checking');
    jest.mocked(nwcService.getBalance).mockImplementation(() => new Promise(() => {}));
    const update = jest.fn();
    const { unmount } = mount(list, update);
    act(() => appStateListener?.('active'));
    await tick(WATCHDOG_RESUME_DELAY_MS);
    // w1's probe is still hanging, yet BOTH stale greens have already decayed.
    expect(nwcService.getBalance).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('w1', { isConnected: true, connectionHealth: 'checking' });
    expect(update).toHaveBeenCalledWith('w2', { isConnected: true, connectionHealth: 'checking' });
    unmount();
  });

  it('cancels the pending resume check if the app backgrounds again', async () => {
    const { unmount } = mount(live);
    act(() => appStateListener?.('active'));
    await tick(1_000);
    act(() => appStateListener?.('background'));
    await tick(WATCHDOG_RESUME_DELAY_MS);
    expect(nwcService.getBalance).not.toHaveBeenCalled();
    unmount();
  });

  it('cancels the pending resume check on unmount', async () => {
    const { unmount } = mount(live);
    act(() => appStateListener?.('active'));
    unmount();
    await tick(WATCHDOG_RESUME_DELAY_MS);
    expect(nwcService.getBalance).not.toHaveBeenCalled();
  });
});

describe('coalesced health sync (#1768)', () => {
  it('re-reads health once per burst of notifications, without network', async () => {
    let notify: (id: string) => void = () => {};
    jest.mocked(nwcService.subscribeWalletHealth).mockImplementation((listener) => {
      notify = listener;
      return () => {};
    });
    jest.mocked(nwcService.isWalletConnected).mockReturnValue(true);
    jest.mocked(nwcService.isSocketConnected).mockReturnValue(true);
    jest.mocked(nwcService.getWalletHealth).mockReturnValue('responsive');
    const update = jest.fn();
    const list = [
      { id: 'w1', walletType: 'nwc', isConnected: true, connectionHealth: 'checking' },
    ] as WalletState[];
    const { unmount } = mount(list, update);
    notify('w1');
    notify('w1');
    notify('w1');
    await tick(HEALTH_SYNC_COALESCE_MS - 1);
    expect(update).not.toHaveBeenCalled();
    await tick(1);
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith('w1', {
      isConnected: true,
      connectionHealth: 'responsive',
    });
    expect(nwcService.getBalance).not.toHaveBeenCalled();
    unmount();
  });
});
