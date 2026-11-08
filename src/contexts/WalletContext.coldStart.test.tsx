/**
 * Cold-start wallet gate (#816): the wallet list hydrates exactly once, for
 * the owner NostrContext's auto-login settles on — never for the bootstrap
 * null publish, and never for a stale owner hint.
 */
import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as walletStorage from '../services/walletStorageService';
import { __resetWalletOwnerHintForTests } from '../services/walletOwnerHint';
import { WalletProvider, useWallet } from './WalletContext';
import type { WalletMetadata } from '../types/wallet';

jest.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => {}),
  deleteItemAsync: jest.fn(async () => {}),
}));
jest.mock('../services/nwcService', () => ({
  connect: jest.fn(async () => ({ success: false })),
  getBalance: jest.fn(async () => null),
  listTransactions: jest.fn(async () => []),
  disconnect: jest.fn(),
  getInfo: jest.fn(async () => null),
  lookupInvoice: jest.fn(async () => null),
  isWalletConnected: jest.fn(() => true),
  isSocketConnected: jest.fn(() => true),
  isRelayInCooldown: jest.fn(() => false),
  isConnectionInProgress: jest.fn(() => false),
  getWalletHealth: jest.fn(() => 'connected'),
}));
jest.mock('../services/swapRecoveryService', () => ({
  recoverPendingSwaps: jest.fn(async () => {}),
  ensureSwapMetaLoaded: jest.fn(async () => {}),
  getSwapMeta: jest.fn(() => undefined),
}));
jest.mock('../services/onchainService', () => ({
  syncAndRefresh: jest.fn(async () => ({ balance: 100, transactions: [] })),
}));
jest.mock('../services/nostrService', () => ({
  DEFAULT_RELAYS: [],
  getCurrentUserPubkey: jest.fn(() => null),
  getCurrentUserReadRelays: jest.fn(() => []),
  onCurrentUserPubkeyChange: jest.fn(() => () => {}),
  fetchZapReceiptsForRecipient: jest.fn(async () => []),
  parseZapReceipt: jest.fn(() => null),
  fetchProfiles: jest.fn(async () => new Map()),
}));
jest.mock('../services/fiatService', () => ({
  ...jest.requireActual('../services/fiatService'),
  getBtcPrice: jest.fn(async () => null),
}));

const HINT_KEY = 'wallet_owner_hint_v1';
const TX = { type: 'incoming', amount: 1000, settled_at: 1, paymentHash: 'h' };
function card(id: string): WalletMetadata {
  return {
    id,
    alias: id,
    theme: 'lightning-piggy',
    order: 0,
    walletType: 'nwc',
    lightningAddress: null,
  };
}

interface Snapshot {
  isLoading: boolean;
  ids: string[];
}
let renders: Snapshot[] = [];
let latest: ReturnType<typeof useWallet> | undefined;
function Probe() {
  latest = useWallet();
  renders.push({ isLoading: latest.isLoading, ids: latest.wallets.map((w) => w.id) });
  return null;
}
function renderProvider() {
  return render(
    <WalletProvider>
      <Probe />
    </WalletProvider>,
  );
}
async function flush() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}
/** NostrContext's auto-login outcome, then its layout-effect publish. */
async function autoLoginAs(owner: string | null) {
  await act(async () => {
    walletStorage.resolveStartupWalletOwner(owner);
    walletStorage.setActivePubkeyForWalletStorage(owner);
  });
}
const readWalletList = () => jest.spyOn(walletStorage, 'getWalletList');
const txReads = (walletId: string) =>
  jest.mocked(AsyncStorage.getItem).mock.calls.filter(([key]) => key === `txs_${walletId}`).length;

beforeEach(async () => {
  walletStorage.setActivePubkeyForWalletStorage(null);
  walletStorage.__resetWalletOwnerGateForTests();
  __resetWalletOwnerHintForTests();
  await AsyncStorage.clear();
  await AsyncStorage.multiSet([
    ['wallet_list_A', JSON.stringify([card('A1')])],
    ['wallet_list_B', JSON.stringify([card('B1')])],
    ['txs_A1', JSON.stringify([TX])],
    ['txs_B1', JSON.stringify([TX])],
    ['balance_A1', '10'],
    ['balance_B1', '20'],
  ]);
  jest.mocked(AsyncStorage.getItem).mockClear();
  renders = [];
});
afterEach(() => jest.restoreAllMocks());

it('hydrates once, for the auto-login owner, ignoring the bootstrap null publish', async () => {
  const lists = readWalletList();
  const view = renderProvider();
  // NostrProvider's first commit publishes null: the gate must stay shut.
  walletStorage.setActivePubkeyForWalletStorage(null);
  await flush();
  expect(lists).not.toHaveBeenCalled();
  expect(latest?.isLoading).toBe(true);

  await autoLoginAs('A');
  await waitFor(() => expect(latest?.isLoading).toBe(false));
  expect(lists.mock.calls).toEqual([['A']]);
  expect(txReads('A1')).toBe(1);
  expect(latest?.wallets[0]).toMatchObject({ id: 'A1', balance: 10, transactions: [TX] });
  // Home never mounts with an empty list that fills in a moment later.
  expect(renders.filter((r) => !r.isLoading).every((r) => r.ids.join() === 'A1')).toBe(true);
  expect(await AsyncStorage.getItem(HINT_KEY)).toBe('A');
  view.unmount();
});

it('hydrates the signed-out list once when auto-login finds no account', async () => {
  await AsyncStorage.setItem(HINT_KEY, 'A'); // left over from a previous sign-in
  const lists = readWalletList();
  const view = renderProvider();
  await flush();
  await autoLoginAs(null);
  await waitFor(() => expect(latest?.isLoading).toBe(false));
  expect(latest?.wallets).toEqual([]);
  // The hint's prefetch read A's list, but only the null owner's was used.
  expect(lists.mock.calls).toEqual([['A'], [null]]);
  expect(renders.some((r) => r.ids.includes('A1'))).toBe(false);
  expect(walletStorage.isWalletOwnerGateOpen()).toBe(true);
  expect(await AsyncStorage.getItem(HINT_KEY)).toBeNull();
  view.unmount();
});

it('discards a mismatched hint and shows only the real owner’s wallets', async () => {
  await AsyncStorage.setItem(HINT_KEY, 'A');
  const lists = readWalletList();
  const view = renderProvider();
  await waitFor(() => expect(lists).toHaveBeenCalledWith('A')); // prefetch underway
  await autoLoginAs('B'); // SecureStore says the active account is B
  await waitFor(() => expect(latest?.isLoading).toBe(false));
  expect(latest?.wallets.map((w) => w.id)).toEqual(['B1']);
  expect(renders.some((r) => r.ids.includes('A1'))).toBe(false);
  expect(txReads('B1')).toBe(1);
  expect(await AsyncStorage.getItem(HINT_KEY)).toBe('B');
  view.unmount();
});

it('reuses the hinted prefetch when auto-login confirms the same owner', async () => {
  await AsyncStorage.setItem(HINT_KEY, 'A');
  const lists = readWalletList();
  const view = renderProvider();
  await waitFor(() => expect(txReads('A1')).toBe(1)); // read before the owner is known
  await autoLoginAs('A');
  await waitFor(() => expect(latest?.isLoading).toBe(false));
  // A cheap list re-read validates the prefetch; the tx cache isn't read again.
  expect(lists.mock.calls).toEqual([['A'], ['A']]);
  expect(txReads('A1')).toBe(1);
  expect(latest?.wallets[0]).toMatchObject({ id: 'A1', balance: 10, transactions: [TX] });
  view.unmount();
});

it('drops the prefetch when the confirmed owner’s list changed in the meantime', async () => {
  await AsyncStorage.setItem(HINT_KEY, 'A');
  const view = renderProvider();
  await waitFor(() => expect(txReads('A1')).toBe(1));
  // e.g. a migration rewrote A's list before the gate opened.
  await AsyncStorage.setItem('wallet_list_A', JSON.stringify([card('A1'), card('A2')]));
  await autoLoginAs('A');
  await waitFor(() => expect(latest?.isLoading).toBe(false));
  expect(latest?.wallets.map((w) => w.id)).toEqual(['A1', 'A2']);
  view.unmount();
});

it('still re-hydrates on account switch and logout after a single cold-start load', async () => {
  const lists = readWalletList();
  const view = renderProvider();
  await autoLoginAs('A');
  await waitFor(() => expect(latest?.wallets.map((w) => w.id)).toEqual(['A1']));

  await act(async () => walletStorage.setActivePubkeyForWalletStorage('B'));
  await waitFor(() => expect(latest?.wallets.map((w) => w.id)).toEqual(['B1']));
  expect(await AsyncStorage.getItem(HINT_KEY)).toBe('B');

  await act(async () => walletStorage.setActivePubkeyForWalletStorage(null));
  await waitFor(() => expect(latest?.wallets).toEqual([]));
  expect(lists.mock.calls).toEqual([['A'], [], []]);
  expect(await AsyncStorage.getItem(HINT_KEY)).toBeNull();
  view.unmount();
});

it('retries a failed owner hydration once instead of confirming an empty list', async () => {
  // A spy calls through to the real read after its one rejection.
  jest.spyOn(walletStorage, 'getWalletList').mockRejectedValueOnce(new Error('storage busy'));
  const view = renderProvider();
  await autoLoginAs('A');
  await waitFor(() => expect(latest?.walletsHydrated).toBe(true));
  expect(latest?.wallets.map((w) => w.id)).toEqual(['A1']);
  expect(latest?.isLoading).toBe(false);
  view.unmount();
});

it('ends the spinner without claiming an empty list when the retry fails too', async () => {
  jest.spyOn(walletStorage, 'getWalletList').mockRejectedValue(new Error('storage down'));
  jest.spyOn(walletStorage, 'isOnboarded').mockResolvedValue(true);
  const view = renderProvider();
  await autoLoginAs('A');
  await waitFor(() => expect(latest?.isLoading).toBe(false));
  expect(walletStorage.getWalletList).toHaveBeenCalledTimes(2);
  // Not hydrated: Home stays neutral (no new-user welcome) and the watcher
  // bridge doesn't publish an empty NWC wallet set.
  expect(latest?.walletsHydrated).toBe(false);
  expect(latest?.wallets).toEqual([]);
  view.unmount();
});

it('falls back to the signed-out list after 2 s, then loads the owner when it lands', async () => {
  jest.useFakeTimers();
  try {
    const lists = readWalletList();
    const view = renderProvider();
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1999);
    });
    expect(lists).not.toHaveBeenCalled();
    expect(latest?.isLoading).toBe(true);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1);
    });
    expect(latest?.isLoading).toBe(false);
    expect(lists.mock.calls).toEqual([[null]]);
    // The late owner is an ordinary account change, so it does hydrate.
    await autoLoginAs('A');
    await act(async () => {
      await jest.advanceTimersByTimeAsync(0);
    });
    expect(latest?.wallets.map((w) => w.id)).toEqual(['A1']);
    expect(lists.mock.calls).toEqual([[null], []]);
    view.unmount();
  } finally {
    jest.useRealTimers();
  }
});

it('still loads the owner’s wallets when the first onboarding read fails', async () => {
  // Startup owns the gate-opening load, so nothing before the gate may abort it.
  jest.spyOn(walletStorage, 'isOnboarded').mockRejectedValueOnce(new Error('storage busy'));
  const view = renderProvider();
  await autoLoginAs('A');
  await waitFor(() => expect(latest?.wallets.map((w) => w.id)).toEqual(['A1']));
  expect(latest?.isLoading).toBe(false);
  view.unmount();
});
