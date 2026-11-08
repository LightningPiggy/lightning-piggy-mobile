import React from 'react';
import { act, render, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import * as nwcService from '../services/nwcService';
import * as nostrService from '../services/nostrService';
import * as zapResolverFingerprintStorage from '../services/zapResolverFingerprintStorage';
import * as walletStorage from '../services/walletStorageService';
import * as swapRecoveryService from '../services/swapRecoveryService';
import { WalletProvider, useWallet, useWalletLive } from './WalletContext';
import { selectHomeWalletState } from '../utils/homeWalletState';
import type { WalletMetadata } from '../types/wallet';

jest.mock('expo-secure-store', () => {
  const store = new Map<string, string>();
  return {
    AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 0,
    getItemAsync: jest.fn(async (key: string) => store.get(key) ?? null),
    setItemAsync: jest.fn(async (key: string, value: string) => void store.set(key, value)),
    deleteItemAsync: jest.fn(async (key: string) => void store.delete(key)),
  };
});
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
  parseZapReceipt: jest.fn(() => ({ senderPubkey: 'alice', comment: 'hi', anonymous: false })),
  fetchProfiles: jest.fn(async () => new Map()),
}));
jest.mock('../services/fiatService', () => ({
  ...jest.requireActual('../services/fiatService'),
  getBtcPrice: jest.fn(async () => null),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

let latest: ReturnType<typeof useWallet> | undefined;
let latestLive: ReturnType<typeof useWalletLive> | undefined;
function Probe() {
  latest = useWallet();
  latestLive = useWalletLive();
  return null;
}

afterEach(() => jest.restoreAllMocks());

it('still recovers swaps and re-checks onboarding when an identity lands mid-startup', async () => {
  // The gate opens signed-out (auto-login found no account, or it timed out)
  // and an identity is published later — here, while migrating.
  walletStorage.setActivePubkeyForWalletStorage(null);
  walletStorage.resolveStartupWalletOwner(null);
  const migrating = deferred<void>();
  jest.spyOn(walletStorage, 'migrateLegacy').mockImplementation(() => migrating.promise);
  jest.spyOn(walletStorage, 'isOnboarded').mockResolvedValueOnce(false).mockResolvedValue(true);
  const readWalletList = jest.spyOn(walletStorage, 'getWalletList');
  const view = render(
    <WalletProvider>
      <Probe />
    </WalletProvider>,
  );
  await waitFor(() => expect(walletStorage.migrateLegacy).toHaveBeenCalled());
  await act(async () => walletStorage.setActivePubkeyForWalletStorage('B'));
  await act(async () => migrating.resolve());

  await waitFor(() => expect(swapRecoveryService.recoverPendingSwaps).toHaveBeenCalledTimes(1));
  expect(latest?.isOnboarded).toBe(true);
  // Startup bailed on the stale identity; the identity hydration's
  // completion is what ends the boot spinner.
  await waitFor(() => expect(latest?.isLoading).toBe(false));
  expect(latest?.walletsHydrated).toBe(true);
  // Only the identity hydration read the wallet list — startup's stale read
  // was skipped.
  expect(readWalletList).toHaveBeenCalledTimes(1);
  view.unmount();
});

function renderProvider() {
  return render(
    <WalletProvider>
      <Probe />
    </WalletProvider>,
  );
}
async function flushStartup() {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

it('migrates a legacy wallet into the identity that lands while its credential read waits', async () => {
  const LEGACY_URL = 'nostr+walletconnect://legacy-fixture';
  walletStorage.setActivePubkeyForWalletStorage(null);
  await AsyncStorage.clear();
  await SecureStore.setItemAsync('nwc_connection_url', LEGACY_URL);
  // Hold every read of the legacy credential until identity B has landed.
  const legacyRead = deferred<void>();
  const readSecure = jest.mocked(SecureStore.getItemAsync).getMockImplementation()!;
  jest.mocked(SecureStore.getItemAsync).mockImplementation(async (key, options) => {
    if (key === 'nwc_connection_url') await legacyRead.promise;
    return readSecure(key, options);
  });
  const view = renderProvider();
  await flushStartup(); // startup runs its migration under the bootstrap null identity
  await act(async () => walletStorage.setActivePubkeyForWalletStorage('B'));
  await act(async () => legacyRead.resolve());

  await waitFor(() => expect(latest?.wallets).toHaveLength(1));
  const [wallet] = latest!.wallets;
  expect(wallet.alias).toBe('My Wallet');
  expect(JSON.parse((await AsyncStorage.getItem('wallet_list_B'))!)).toEqual([
    expect.objectContaining({ id: wallet.id, walletType: 'nwc' }),
  ]);
  expect(await AsyncStorage.getItem('wallet_list')).toBeNull();
  expect(await readSecure(`nwc_url_${wallet.id}`)).toBe(LEGACY_URL);
  expect(await readSecure('nwc_connection_url')).toBeNull();
  expect(latest?.isOnboarded).toBe(true);
  view.unmount();
  walletStorage.setActivePubkeyForWalletStorage(null);
});

it('drops balance and transaction reads that finish after a B → C → B round trip', async () => {
  walletStorage.setActivePubkeyForWalletStorage(null);
  await AsyncStorage.clear();
  const metadata = { id: 'W', alias: 'W', theme: 'lightning-piggy', order: 0 };
  await AsyncStorage.multiSet([
    ['wallet_list_B', JSON.stringify([{ ...metadata, walletType: 'nwc', lightningAddress: null }])],
    ['balance_W', '42'],
  ]);
  const lateTxs = deferred<unknown[]>();
  const lateBalance = deferred<number | null>();
  jest.mocked(nwcService.listTransactions).mockImplementationOnce(() => lateTxs.promise);
  jest.mocked(nwcService.getBalance).mockImplementationOnce(() => lateBalance.promise);
  const view = renderProvider();
  await flushStartup();
  await act(async () => walletStorage.setActivePubkeyForWalletStorage('B'));
  // W hydrates with no cached history, which kicks off its first tx fetch.
  await waitFor(() =>
    expect(nwcService.listTransactions).toHaveBeenCalledWith('W', expect.any(Function)),
  );
  const refreshing = latest!.refreshActiveBalance();
  expect(nwcService.getBalance).toHaveBeenCalledWith('W');

  await act(async () => walletStorage.setActivePubkeyForWalletStorage('C'));
  await act(async () => walletStorage.setActivePubkeyForWalletStorage('B'));
  await waitFor(() => expect(latest?.wallets[0]?.id).toBe('W'));
  await act(async () => {
    lateBalance.resolve(999);
    lateTxs.resolve([{ type: 'incoming', amount: 5000, payment_hash: 'h', settled_at: 1 }]);
    await refreshing;
  });
  await flushStartup();

  expect(latest?.wallets[0]).toMatchObject({ balance: 42, transactions: [] });
  expect(await AsyncStorage.getItem('balance_W')).toBe('42');
  expect(await AsyncStorage.getItem('txs_W')).toBeNull();
  view.unmount();
  walletStorage.setActivePubkeyForWalletStorage(null);
});

describe('deferred zap attribution after a transaction fetch', () => {
  // One unattributed incoming tx (no bolt11, so it's matched by amount + time)
  // and a relay receipt that pairs with it.
  const zapped = { type: 'incoming', amount: 5000, settled_at: 1000, paymentHash: 'h0' };
  const other = { type: 'incoming', amount: 2100, settled_at: 2000, paymentHash: 'h1' };
  const receipt = {
    id: 'r0',
    created_at: 1000,
    tags: [['description', JSON.stringify({ tags: [['amount', '5000000']] })]],
  };

  // Hydrates B with W's cached history, fetches it, and holds the relay
  // receipt query that the deferred resolver pass issues.
  async function startResolvingUnderB() {
    walletStorage.setActivePubkeyForWalletStorage(null);
    await AsyncStorage.clear();
    zapResolverFingerprintStorage.__resetForTests();
    const metadata = { id: 'W', alias: 'W', theme: 'lightning-piggy', order: 0 };
    await AsyncStorage.multiSet([
      [
        'wallet_list_B',
        JSON.stringify([{ ...metadata, walletType: 'nwc', lightningAddress: null }]),
      ],
      ['txs_W', JSON.stringify([zapped])],
    ]);
    // Jest 29's restoreAllMocks strips the factory defaults, so re-arm them.
    jest.mocked(nostrService.getCurrentUserPubkey).mockReturnValue('pkB');
    jest.mocked(nostrService.getCurrentUserReadRelays).mockReturnValue([]);
    jest.mocked(nostrService.fetchProfiles).mockResolvedValue(new Map());
    jest
      .mocked(nostrService.parseZapReceipt)
      .mockReturnValue({ senderPubkey: 'alice', comment: 'hi', anonymous: false } as never);
    jest
      .mocked(nwcService.listTransactions)
      .mockResolvedValueOnce([
        { type: 'incoming', amount: 5000, settled_at: 1000, payment_hash: 'h0' },
      ]);
    const receipts = deferred<(typeof receipt)[]>();
    jest.mocked(nostrService.fetchZapReceiptsForRecipient).mockReturnValueOnce(receipts.promise);
    const view = renderProvider();
    await flushStartup();
    await act(async () => walletStorage.setActivePubkeyForWalletStorage('B'));
    await waitFor(() => expect(latest?.wallets[0]?.transactions).toHaveLength(1));
    await flushStartup();
    await act(async () => latest!.fetchTransactionsForWallet('W'));
    await flushStartup();
    await waitFor(() =>
      expect(nostrService.fetchZapReceiptsForRecipient).toHaveBeenCalledWith(['pkB'], [], {
        limit: 500,
      }),
    );
    return { view, receipts };
  }
  afterEach(() => {
    jest.mocked(nostrService.getCurrentUserPubkey).mockReturnValue(null);
    walletStorage.setActivePubkeyForWalletStorage(null);
  });

  it('attributes the zap when the identity is unchanged', async () => {
    const { view, receipts } = await startResolvingUnderB();
    await act(async () => receipts.resolve([receipt]));

    await waitFor(() =>
      expect(latest?.wallets[0]?.transactions[0]?.zapCounterparty).toMatchObject({
        pubkey: 'alice',
      }),
    );
    await waitFor(async () => expect(await zapResolverFingerprintStorage.get('W')).not.toBeNull());
    view.unmount();
  });

  it('drops receipts that land after B → C → B instead of merging them by index', async () => {
    const { view, receipts } = await startResolvingUnderB();
    await act(async () => walletStorage.setActivePubkeyForWalletStorage('C'));
    // B's history gained a newer row meanwhile, so index 0 is now `other`.
    const rehydrated = JSON.stringify([other, zapped]);
    await AsyncStorage.setItem('txs_W', rehydrated);
    await act(async () => walletStorage.setActivePubkeyForWalletStorage('B'));
    await waitFor(() => expect(latest?.wallets[0]?.transactions).toHaveLength(2));

    await act(async () => receipts.resolve([receipt]));
    await flushStartup();

    const [first, second] = latest!.wallets[0].transactions;
    expect(first.zapCounterparty).toBeUndefined();
    expect(second.zapCounterparty).toBeUndefined();
    expect(await AsyncStorage.getItem('txs_W')).toBe(rehydrated);
    zapResolverFingerprintStorage.__resetForTests();
    expect(await zapResolverFingerprintStorage.get('W')).toBeNull();
    view.unmount();
  });
});

it('ignores a pending expected-payment result after B → C → B', async () => {
  walletStorage.setActivePubkeyForWalletStorage(null);
  await AsyncStorage.clear();
  const metadata = {
    id: 'W',
    alias: 'W',
    theme: 'lightning-piggy',
    order: 0,
    walletType: 'nwc',
    lightningAddress: null,
  };
  await AsyncStorage.multiSet([
    ['wallet_list_B', JSON.stringify([metadata])],
    ['balance_W', '42'],
  ]);
  const view = renderProvider();
  await flushStartup();
  await act(async () => walletStorage.setActivePubkeyForWalletStorage('B'));
  await waitFor(() => expect(latest?.wallets[0]?.id).toBe('W'));
  const lookup = deferred<never>();
  const balance = deferred<number | null>();
  jest.mocked(nwcService.lookupInvoice).mockReturnValueOnce(lookup.promise);
  jest.mocked(nwcService.getBalance).mockReturnValueOnce(balance.promise);
  jest.useFakeTimers();
  try {
    act(() => latest!.expectPayment('W', 'hash', 50));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(1000);
    });
    expect(nwcService.lookupInvoice).toHaveBeenCalled();
    await act(async () => walletStorage.setActivePubkeyForWalletStorage('C'));
    await act(async () => walletStorage.setActivePubkeyForWalletStorage('B'));
    await act(async () => {
      lookup.resolve({ paid: true } as never);
      balance.resolve(999);
    });
    expect(latest?.wallets[0]?.balance).toBe(42);
    expect(latestLive?.lastIncomingPayment).toBeNull();
  } finally {
    view.unmount();
    jest.useRealTimers();
  }
});

function homeState() {
  const { wallets, activeWalletId, walletsHydrated } = latest!;
  return selectHomeWalletState(wallets, activeWalletId, walletsHydrated);
}

it('keeps Home neutral during delayed startup, then enables actions from the hydrated cards', async () => {
  walletStorage.setActivePubkeyForWalletStorage('home-startup');
  const pending = deferred<WalletMetadata[]>();
  jest.spyOn(walletStorage, 'getWalletList').mockImplementation(() => pending.promise);
  const cards: WalletMetadata[] = ['home-a', 'home-b', 'home-c'].map((id, order) => ({
    id,
    order,
    alias: id,
    theme: 'lightning-piggy',
    walletType: 'nwc',
    lightningAddress: null,
  }));
  const view = renderProvider();
  await waitFor(() => expect(walletStorage.getWalletList).toHaveBeenCalled());
  expect(latest?.walletsHydrated).toBe(false);
  expect(homeState()).toMatchObject({ showWelcome: false, dimActions: false });
  await act(async () => pending.resolve(cards));
  await waitFor(() => expect(latest?.walletsHydrated).toBe(true));
  expect(latest?.wallets.map((w) => w.id)).toEqual(cards.map((w) => w.id));
  expect(homeState()).toMatchObject({
    activeWallet: latest?.wallets[0],
    showWelcome: false,
    isReceiveDisabled: false,
    isSendDisabled: false,
    isTransferDisabled: false,
    dimActions: false,
  });
  view.unmount();
});

it('clears old cards during a delayed identity reload without flashing the new-user prompt', async () => {
  walletStorage.setActivePubkeyForWalletStorage('home-old');
  const oldCard: WalletMetadata = {
    id: 'home-old-card',
    order: 0,
    alias: 'old',
    theme: 'lightning-piggy',
    walletType: 'nwc',
    lightningAddress: null,
  };
  const read = jest.spyOn(walletStorage, 'getWalletList').mockResolvedValue([oldCard]);
  const view = renderProvider();
  await waitFor(() => expect(latest?.walletsHydrated).toBe(true));
  expect(homeState().activeWallet?.id).toBe(oldCard.id);
  const pending = deferred<WalletMetadata[]>();
  read.mockImplementation(() => pending.promise);
  await act(async () => walletStorage.setActivePubkeyForWalletStorage('home-new'));
  expect(latest?.wallets).toEqual([]);
  expect(latest?.activeWallet).toBeNull();
  expect(latest?.walletsHydrated).toBe(false);
  expect(homeState()).toMatchObject({ showWelcome: false, dimActions: false });
  await act(async () => pending.resolve([{ ...oldCard, id: 'home-new-card' }]));
  await waitFor(() => expect(latest?.walletsHydrated).toBe(true));
  expect(homeState()).toMatchObject({
    activeWallet: { id: 'home-new-card' },
    showWelcome: false,
    isReceiveDisabled: false,
    isSendDisabled: false,
    dimActions: false,
  });
  view.unmount();
});

it('finishes cached hydration before legacy key checks, then enables Send and Move', async () => {
  walletStorage.setActivePubkeyForWalletStorage('legacy-seed-profile');
  await AsyncStorage.clear();
  const card: WalletMetadata = {
    id: 'legacy-seed-card',
    alias: 'Seed',
    order: 0,
    theme: 'lightning-piggy',
    walletType: 'onchain',
    lightningAddress: null,
  };
  await walletStorage.saveWalletList([card], 'legacy-seed-profile');
  const keyRead = deferred<string | null>();
  const secureRead = jest
    .spyOn(SecureStore, 'getItemAsync')
    .mockImplementation(async (key) =>
      key === 'onchain_mnemonic_legacy-seed-card' ? keyRead.promise : null,
    );
  const view = renderProvider();
  await waitFor(() => expect(secureRead).toHaveBeenCalledWith('onchain_mnemonic_legacy-seed-card'));
  expect(latest?.isLoading).toBe(false);
  expect(latest?.walletsHydrated).toBe(true);
  expect(latest?.wallets[0].onchainImportMethod).toBeUndefined();
  await act(async () => keyRead.resolve(''));
  await waitFor(() => expect(latest?.wallets[0].onchainImportMethod).toBe('mnemonic'));
  expect(homeState().isSendDisabled).toBe(false);
  expect((await walletStorage.getWalletList('legacy-seed-profile'))[0].onchainImportMethod).toBe(
    'mnemonic',
  );
  view.unmount();
  secureRead.mockClear();
  const reload = renderProvider();
  await waitFor(() => expect(latest?.walletsHydrated).toBe(true));
  expect(latest?.wallets[0].onchainImportMethod).toBe('mnemonic');
  expect(secureRead.mock.calls.some(([key]) => key === 'onchain_mnemonic_legacy-seed-card')).toBe(
    false,
  );
  reload.unmount();
});
