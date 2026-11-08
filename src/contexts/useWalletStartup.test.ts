/** Cold-start wallet load: in-session retry and the gate-timeout legacy list (#1746). */
import { useState } from 'react';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as walletStorage from '../services/walletStorageService';
import { __resetWalletOwnerHintForTests } from '../services/walletOwnerHint';
import type { WalletMetadata, WalletState } from '../types/wallet';
import { useWalletStartup } from './useWalletStartup';

jest.mock('../services/nwcService', () => ({
  connect: jest.fn(async () => ({ success: false })),
  getInfo: jest.fn(),
}));
jest.mock('../services/swapRecoveryService', () => ({
  recoverPendingSwaps: jest.fn(async () => {}),
}));
jest.mock('../services/startupTasks', () => ({
  scheduleStartupTask: jest.fn(() => () => {}),
  STARTUP_SLOTS: { swapRecovery: 0 },
}));

const MIGRATED_KEY = 'per_account_storage_migrated_v1';
const readStorage = jest.mocked(AsyncStorage.getItem).getMockImplementation()!;

function wallet(id: string): WalletMetadata {
  return {
    id,
    alias: id,
    theme: 'lightning-piggy',
    order: 0,
    walletType: 'nwc',
    lightningAddress: null,
  };
}
const captureWalletIdentity = () => {
  const pk = walletStorage.getActivePubkey();
  return () => walletStorage.getActivePubkey() === pk;
};

function mount() {
  const setIsLoading = jest.fn();
  const view = renderHook(() => {
    const [wallets, setWallets] = useState<WalletState[]>([]);
    const [walletsHydrated, setWalletsHydrated] = useState(false);
    const retry = useWalletStartup({
      captureWalletIdentity,
      lastTxsJsonRef: { current: new Map() },
      hydrateSeenReceipts: async () => {},
      setIsOnboarded: () => {},
      setIsLoading,
      setWalletsHydrated,
      setWallets,
      setActiveWalletId: () => {},
    });
    return { wallets, walletsHydrated, retry };
  });
  return { ...view, setIsLoading };
}
const flush = () => act(async () => new Promise((r) => setTimeout(r, 0)));

beforeEach(async () => {
  jest.mocked(AsyncStorage.getItem).mockImplementation(readStorage);
  walletStorage.setActivePubkeyForWalletStorage(null);
  walletStorage.__resetWalletOwnerGateForTests();
  __resetWalletOwnerHintForTests();
  await AsyncStorage.clear();
  jest.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());

it('retries a failed startup load on pull-to-refresh and then stops', async () => {
  await AsyncStorage.setItem('wallet_list_A', JSON.stringify([wallet('w1')]));
  let failures = 2; // both cold-start attempts
  jest.mocked(AsyncStorage.getItem).mockImplementation(async (key: string) => {
    if (key === 'wallet_list_A' && failures > 0) {
      failures -= 1;
      throw new Error('storage unavailable');
    }
    return readStorage(key);
  });
  const { result, setIsLoading } = mount();
  act(() => walletStorage.setActivePubkeyForWalletStorage('A'));
  await waitFor(() => expect(setIsLoading).toHaveBeenCalledWith(false));
  expect(result.current.walletsHydrated).toBe(false);
  expect(result.current.wallets).toEqual([]);

  await act(() => result.current.retry());
  expect(result.current.walletsHydrated).toBe(true);
  expect(result.current.wallets.map((w) => w.id)).toEqual(['w1']);

  // Loaded: a later pull-to-refresh doesn't reload the list.
  const reads = jest.mocked(AsyncStorage.getItem).mock.calls.length;
  await act(() => result.current.retry());
  expect(jest.mocked(AsyncStorage.getItem).mock.calls.length).toBe(reads);
});

it('after a gate timeout on a per-account install, never renders the legacy list', async () => {
  await AsyncStorage.setItem(MIGRATED_KEY, 'true');
  // Left over from the migration: another account's wallet.
  await AsyncStorage.setItem('wallet_list', JSON.stringify([wallet('someone-elses')]));
  await AsyncStorage.setItem('wallet_list_B', JSON.stringify([wallet('b1')]));
  await walletStorage.awaitActivePubkeyHydrated(1); // auto-login took > 2 s
  const { result, setIsLoading } = mount();
  // The boot spinner ends, but Home stays neutral rather than showing the list.
  await waitFor(() => expect(setIsLoading).toHaveBeenCalledWith(false));
  await flush();
  expect(result.current.wallets).toEqual([]);
  expect(result.current.walletsHydrated).toBe(false);
  // The owner lands late: an ordinary account change (identity hydration loads
  // it); startup still never commits the legacy list.
  act(() => walletStorage.setActivePubkeyForWalletStorage('B'));
  await flush();
  expect(result.current.wallets.map((w) => w.id)).not.toContain('someone-elses');
});

it('after a gate timeout, loads the signed-out list once auto-login confirms signed-out', async () => {
  await AsyncStorage.setItem(MIGRATED_KEY, 'true');
  await AsyncStorage.setItem('wallet_list', JSON.stringify([wallet('signed-out')]));
  await walletStorage.awaitActivePubkeyHydrated(1);
  const { result } = mount();
  await flush();
  expect(result.current.walletsHydrated).toBe(false);
  act(() => walletStorage.resolveStartupWalletOwner(null));
  await waitFor(() => expect(result.current.walletsHydrated).toBe(true));
  expect(result.current.wallets.map((w) => w.id)).toEqual(['signed-out']);
});

it('after a gate timeout, a pre-migration install still reads its legacy list', async () => {
  await AsyncStorage.setItem('wallet_list', JSON.stringify([wallet('legacy')]));
  await walletStorage.awaitActivePubkeyHydrated(1);
  const { result } = mount();
  await waitFor(() => expect(result.current.walletsHydrated).toBe(true));
  expect(result.current.wallets.map((w) => w.id)).toEqual(['legacy']);
});

it('while waiting on the owner, a pull-to-refresh fails fast without reading the legacy list', async () => {
  await AsyncStorage.setItem(MIGRATED_KEY, 'true');
  await AsyncStorage.setItem('wallet_list', JSON.stringify([wallet('someone-elses')]));
  await walletStorage.awaitActivePubkeyHydrated(1);
  const { result } = mount();
  await flush();
  // Resolves (never hangs the spinner) and renders nothing.
  await act(() => result.current.retry());
  expect(result.current.wallets).toEqual([]);
  expect(result.current.walletsHydrated).toBe(false);
});

it('the retry armed during the wait stops once startup loads the confirmed owner', async () => {
  await AsyncStorage.setItem(MIGRATED_KEY, 'true');
  await AsyncStorage.setItem('wallet_list', JSON.stringify([wallet('signed-out')]));
  await walletStorage.awaitActivePubkeyHydrated(1);
  const { result } = mount();
  await flush();
  act(() => walletStorage.resolveStartupWalletOwner(null));
  await waitFor(() => expect(result.current.walletsHydrated).toBe(true));
  // Startup loaded it: a later pull does not reload the list.
  const reads = jest.mocked(AsyncStorage.getItem).mock.calls.length;
  await act(() => result.current.retry());
  expect(jest.mocked(AsyncStorage.getItem).mock.calls.length).toBe(reads);
});
