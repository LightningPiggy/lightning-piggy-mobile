// Jest manual mock for @secondts/bark-react-native: the uniffi native module
// cannot load under Jest. Jest picks this up automatically for every suite
// (root __mocks__ next to node_modules), so no test ever touches the real
// bindings. Tests reach the fake wallets through `__wallet` / `__onchain`
// and restore defaults with `__resetBarkMock()`.

export const Network = { Bitcoin: 0, Testnet: 1, Signet: 2, Regtest: 3 } as const;

export const LightningSendStatus_Tags = {
  Unknown: 'Unknown',
  InProgress: 'InProgress',
  Paid: 'Paid',
} as const;

export const Config = { create: (c: Record<string, unknown>) => c };

const balance = () => ({
  spendableSats: 21_000n,
  pendingInRoundSats: 1_000n,
  pendingExitSats: 0n,
  pendingLightningSendSats: 0n,
  claimableLightningReceiveSats: 500n,
  pendingBoardSats: 0n,
});

const fee = (feeSats: bigint, gross = 0n) => ({
  grossAmountSats: gross,
  feeSats,
  netAmountSats: gross - feeSats,
  vtxosSpent: [],
});

function buildWallet() {
  return {
    sync: jest.fn(async () => {}),
    balance: jest.fn(async () => balance()),
    newAddressWithIndex: jest.fn(async () => ({ address: 'tark1fresh', index: 0 })),
    peekAddress: jest.fn(async (index: number) => `tark1peek${index}`),
    stopDaemonWait: jest.fn(async () => {}),
    tryClaimAllLightningReceives: jest.fn(async () => []),
    getFirstExpiringVtxoBlockheight: jest.fn(async (): Promise<number | undefined> => 1_000),
    getVtxosToRefresh: jest.fn(async (): Promise<{ id: string }[]> => []),
    spendableVtxos: jest.fn(async (): Promise<{ id: string }[]> => [{ id: 'v1' }, { id: 'v2' }]),
    refreshVtxos: jest.fn(async () => 'round-1'),
    listClaimableExits: jest.fn(async () => []),
    history: jest.fn(async () => []),
    bolt11Invoice: jest.fn(async (amount: bigint) => ({
      invoice: 'lntbs1invoice',
      paymentHash: 'hash',
      amountSats: amount,
    })),
    isInvoicePaid: jest.fn(async () => false),
    estimateArkoorPaymentFee: jest.fn(async () => fee(0n)),
    estimateLightningSendFee: jest.fn(async () => fee(10n)),
    estimateSendOnchainFee: jest.fn(async () => fee(300n)),
    estimateOffboardAllFee: jest.fn(async () => fee(400n, 21_000n)),
    validateArkoorAddress: jest.fn(async () => true),
    sendArkoorPayment: jest.fn(async () => {}),
    sendOnchain: jest.fn(async () => 'txid'),
    payLightningInvoice: jest.fn(async () => ({ tag: 'Paid' })),
    payLightningAddress: jest.fn(async () => ({ tag: 'InProgress' })),
    payLnurl: jest.fn(async () => ({ tag: 'InProgress' })),
    boardAll: jest.fn(async () => ({ vtxoId: 'b1', amountSats: 50_000n, txid: 'boardtx' })),
    offboardAll: jest.fn(async () => ({ txid: 'offboardtx' })),
    startExitForEntireWallet: jest.fn(async () => {}),
    progressExits: jest.fn(async () => []),
    hasPendingExits: jest.fn(async () => false),
    syncExits: jest.fn(async () => {}),
    drainExits: jest.fn(async () => ({ psbtBase64: 'unsigned', feeSats: 200n })),
    signExitClaimInputs: jest.fn(async () => 'signed'),
    broadcastTx: jest.fn(async () => 'claimtx'),
  };
}

function buildOnchain() {
  return {
    sync: jest.fn(async () => 0n),
    balance: jest.fn(async () => ({ confirmedSats: 0n, pendingSats: 0n, totalSats: 0n })),
    tipHeight: jest.fn(async () => 900),
    newAddress: jest.fn(async () => 'tb1qboarding'),
  };
}

export const __wallet = buildWallet();
export const __onchain = buildOnchain();

export const Wallet = { open: jest.fn(async () => __wallet) };
export const OnchainWallet = { default_: jest.fn(async () => __onchain) };
export const generateMnemonic = jest.fn(() => 'abandon '.repeat(11) + 'about');
export const validateMnemonic = jest.fn((m: string) => m.trim().split(/\s+/).length >= 12);
export const extractTxFromPsbt = jest.fn((psbt: string) => `hex(${psbt})`);

/** Restore every fake to its default behaviour. */
export function __resetBarkMock(): void {
  Object.assign(__wallet, buildWallet());
  Object.assign(__onchain, buildOnchain());
  Wallet.open.mockReset().mockImplementation(async () => __wallet);
  OnchainWallet.default_.mockReset().mockImplementation(async () => __onchain);
  generateMnemonic.mockReset().mockImplementation(() => 'abandon '.repeat(11) + 'about');
  validateMnemonic
    .mockReset()
    .mockImplementation((m: string) => m.trim().split(/\s+/).length >= 12);
  extractTxFromPsbt.mockReset().mockImplementation((psbt: string) => `hex(${psbt})`);
}
