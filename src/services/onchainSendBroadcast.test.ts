import { sendTransaction } from './onchainService';

// sendTransaction must report when it starts broadcasting, so the Move sheet
// can tell "nothing was sent" from "the tx may be in the mempool" (#1778).

const mockSync = jest.fn(async () => undefined);
const mockFinish = jest.fn(async () => ({ psbt: {} }));
const mockBroadcast = jest.fn(async () => undefined);

jest.mock('../contexts/nostrDecryptPacing', () => ({
  createYieldScheduler: () => ({ maybeYield: jest.fn(), dispose: jest.fn() }),
}));
jest.mock('../utils/yieldingBatch', () => ({ yieldMacrotask: async () => undefined }));
jest.mock('./walletStorageService', () => ({
  getXpub: async () => null,
  getMnemonic: async () => 'abandon abandon about',
  getElectrumServer: async () => 'electrum.example:50002:s',
}));
jest.mock('bdk-rn/lib/lib/enums', () => ({
  Network: { Bitcoin: 'bitcoin' },
  KeychainKind: { External: 0, Internal: 1 },
  AddressIndex: {},
}));
jest.mock('bdk-rn', () => {
  const builder = {
    addRecipient: async () => builder,
    feeRate: async () => builder,
    finish: () => mockFinish(),
  };
  return {
    Mnemonic: jest.fn(() => ({ fromString: async () => ({}) })),
    DescriptorSecretKey: jest.fn(() => ({ create: async () => ({}) })),
    Descriptor: jest.fn(() => ({ newBip84: async () => ({}) })),
    DatabaseConfig: jest.fn(() => ({ memory: async () => ({}) })),
    Blockchain: jest.fn(() => ({ create: async () => ({ broadcast: mockBroadcast }) })),
    Wallet: jest.fn(() => ({
      create: async () => ({
        sync: mockSync,
        sign: async () => ({ extractTx: async () => ({}), txid: async () => 'txid-1' }),
      }),
    })),
    Address: jest.fn(() => ({ create: async () => ({ scriptPubKey: async () => ({}) }) })),
    TxBuilder: jest.fn(() => ({ create: async () => builder })),
    Transaction: jest.fn(),
  };
});
jest.spyOn(console, 'log').mockImplementation(() => {});
jest.spyOn(console, 'warn').mockImplementation(() => {});

beforeEach(() => jest.clearAllMocks());

it('reports the broadcast attempt before broadcasting', async () => {
  const onBroadcastAttempted = jest.fn();
  await expect(
    sendTransaction('w1', 'bc1qdest', 1_000, undefined, onBroadcastAttempted),
  ).resolves.toBe('txid-1');
  expect(onBroadcastAttempted).toHaveBeenCalledTimes(1);
  expect(onBroadcastAttempted.mock.invocationCallOrder[0]).toBeLessThan(
    mockBroadcast.mock.invocationCallOrder[0],
  );
});

it('has reported the attempt when a broadcast reply is lost', async () => {
  mockBroadcast.mockRejectedValue(new Error('electrum: unexpected EOF'));
  const onBroadcastAttempted = jest.fn();
  await expect(
    sendTransaction('w1', 'bc1qdest', 1_000, undefined, onBroadcastAttempted),
  ).rejects.toThrow('unexpected EOF');
  expect(onBroadcastAttempted).toHaveBeenCalledTimes(1);
});

it('does not report an attempt when the transaction cannot be built', async () => {
  mockFinish.mockRejectedValueOnce(new Error('Insufficient funds'));
  const onBroadcastAttempted = jest.fn();
  await expect(
    sendTransaction('w1', 'bc1qdest', 1_000, undefined, onBroadcastAttempted),
  ).rejects.toThrow('Insufficient funds');
  expect(onBroadcastAttempted).not.toHaveBeenCalled();
  expect(mockBroadcast).not.toHaveBeenCalled();
});
