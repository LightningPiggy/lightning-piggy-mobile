import { syncAndRefresh, getTransactions } from './onchainService';
import { isOnchainSyncBackedOff, recordOnchainSyncFailure } from './onchainSyncBackoff';
const mockSync = jest.fn(async () => true);
const mockList = jest.fn(async () => [
  { txid: 'old', received: 9, sent: 2, confirmationTime: { height: 5, timestamp: 10 } },
  { txid: 'pending', received: 0, sent: 4, confirmationTime: null },
]);
const mockYield = jest.fn(async () => undefined);
const mockDispose = jest.fn();
const mockMacrotask = jest.fn(async () => undefined);
const mockXpub = jest.fn(async () => 'xpub-test');
jest.mock('../contexts/nostrDecryptPacing', () => ({
  createYieldScheduler: () => ({ maybeYield: mockYield, dispose: mockDispose }),
}));
jest.mock('../utils/yieldingBatch', () => ({ yieldMacrotask: () => mockMacrotask() }));
jest.mock('./walletStorageService', () => ({
  getXpub: () => mockXpub(),
  getMnemonic: async () => null,
  getElectrumServer: async () => 'electrum.blockstream.info:50002:s',
}));
jest.mock('bdk-rn/lib/lib/enums', () => ({ Network: { Bitcoin: 'bitcoin' } }));
jest.mock('bdk-rn', () => ({
  Descriptor: jest.fn(() => ({ create: async () => ({}) })),
  DatabaseConfig: jest.fn(() => ({ memory: async () => ({}) })),
  Blockchain: jest.fn(() => ({ create: async () => ({}) })),
  Wallet: jest.fn(() => ({
    create: async () => ({
      sync: mockSync,
      getBalance: async () => ({ total: 7 }),
      listTransactions: mockList,
    }),
  })),
}));

beforeEach(() => {
  jest.clearAllMocks();
  mockXpub.mockResolvedValue('xpub-test');
});

it.each(['balance and history', 'history'])(
  'yields around native sync and paces %s mapping',
  async (path) => {
    const result =
      path === 'history' ? await getTransactions(path) : (await syncAndRefresh(path)).transactions;
    expect(mockMacrotask).toHaveBeenCalledTimes(2);
    expect(mockMacrotask.mock.invocationCallOrder[0]).toBeLessThan(
      mockSync.mock.invocationCallOrder[0],
    );
    expect(mockSync.mock.invocationCallOrder[0]).toBeLessThan(
      mockMacrotask.mock.invocationCallOrder[1],
    );
    expect(mockMacrotask.mock.invocationCallOrder[1]).toBeLessThan(
      mockList.mock.invocationCallOrder[0],
    );
    expect(mockYield).toHaveBeenCalledTimes(2);
    expect(mockDispose).toHaveBeenCalledTimes(1);
    expect(result).toEqual([
      {
        txid: 'pending',
        type: 'outgoing',
        amount: 4,
        confirmed: false,
        blockHeight: null,
        timestamp: null,
      },
      { txid: 'old', type: 'incoming', amount: 7, confirmed: true, blockHeight: 5, timestamp: 10 },
    ]);
  },
);

it('paces individual Esplora inputs and outputs as well as transactions', async () => {
  mockXpub.mockResolvedValue('bc1qabcdefghi');
  const originalFetch = global.fetch;
  global.fetch = jest
    .fn()
    .mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        chain_stats: { funded_txo_sum: 20, spent_txo_sum: 5 },
        mempool_stats: { funded_txo_sum: 0, spent_txo_sum: 0 },
      }),
    })
    .mockResolvedValueOnce({
      ok: true,
      json: async () => [
        {
          txid: 'esplora',
          status: { confirmed: false },
          vin: [{ prevout: { scriptpubkey_address: 'bc1qabcdefghi', value: 5 } }],
          vout: [{ scriptpubkey_address: 'bc1qabcdefghi', value: 20 }, { value: 8 }],
        },
      ],
    });
  try {
    const result = await syncAndRefresh('address');
    expect(result.balance).toBe(15);
    expect(result.transactions[0]).toMatchObject({ amount: 15, type: 'incoming' });
    expect(mockYield).toHaveBeenCalledTimes(4);
    expect(mockDispose).toHaveBeenCalledTimes(1);
  } finally {
    global.fetch = originalFetch;
  }
});

it('lifts the background poll backoff on success only (#1725)', async () => {
  recordOnchainSyncFailure('w');
  expect(isOnchainSyncBackedOff('w')).toBe(true);
  // A failed sync (e.g. pull-to-refresh while offline) leaves the backoff alone.
  mockSync.mockRejectedValueOnce(new Error('electrum down'));
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  expect((await syncAndRefresh('w')).ok).toBe(false);
  warn.mockRestore();
  expect(isOnchainSyncBackedOff('w')).toBe(true);
  // Any successful sync of the wallet lifts it.
  expect((await syncAndRefresh('w')).ok).toBe(true);
  expect(isOnchainSyncBackedOff('w')).toBe(false);
});
