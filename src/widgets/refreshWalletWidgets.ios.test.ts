const mockMirror = jest.fn();
const mockWipe = jest.fn();

jest.mock('../services/widgetAppGroup', () => ({
  mirrorWidgetSnapshot: (json: string) => mockMirror(json),
  wipeWidgetAppGroup: () => mockWipe(),
}));

import { refreshWalletWidgets } from './refreshWalletWidgets.ios';
import { buildWidgetSnapshot, WIDGET_WALLET_KEYS } from '../services/widgetSnapshot';
import type { WalletState } from '../types/wallet';

// Values that must never reach the App Group, whatever field they hide in.
const SECRETS = {
  nwcUrl: 'nostr+walletconnect://abc?relay=wss://r&secret=deadbeef',
  mnemonic:
    'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  xpub: 'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz',
  nsec: 'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5',
  lnurl: 'lnurl1dp68gurn8ghj7um9wfmxjcm99e3k7mf0v9cxj0m385ekvcenxc6r2c35xvukxefcv5mkvv34x5ekzd3ev',
  lightningAddress: 'piggy@example.com',
  walletAlias: 'node alias',
};

function walletWithSecrets(id: string, order: number): WalletState {
  return {
    id,
    alias: `Piggy ${id}`,
    theme: 'lightning-piggy',
    order,
    walletType: 'nwc',
    isConnected: true,
    connectionHealth: 'responsive',
    balance: 92_369,
    transactions: [],
    ...SECRETS,
  } as unknown as WalletState;
}

const snapshot = buildWidgetSnapshot(
  [walletWithSecrets('w2', 1), walletWithSecrets('w1', 0)],
  'de',
  {
    btcPrice: 74_500,
    currency: 'USD',
    fetchedAt: () => 1_800_000_000_000,
  },
);

beforeEach(() => jest.clearAllMocks());

it('mirrors only the allow-listed snapshot into the App Group', async () => {
  await refreshWalletWidgets(snapshot);
  expect(mockMirror).toHaveBeenCalledTimes(1);
  const json: string = mockMirror.mock.calls[0][0];
  for (const secret of Object.values(SECRETS)) expect(json).not.toContain(secret);
  const written = JSON.parse(json) as { version: number; locale: string; wallets: object[] };
  expect(Object.keys(written).sort()).toEqual(['locale', 'version', 'wallets']);
  expect(written.wallets).toHaveLength(2);
  for (const wallet of written.wallets) {
    expect(Object.keys(wallet).sort()).toEqual([...WIDGET_WALLET_KEYS].sort());
  }
  // Carousel order, as the Swift widget expects.
  expect(written.wallets.map((w) => (w as { id: string }).id)).toEqual(['w1', 'w2']);
  expect(mockWipe).not.toHaveBeenCalled();
});

it('wipes the App Group when there is no snapshot (sign-out, account switch)', async () => {
  await refreshWalletWidgets(null);
  expect(mockWipe).toHaveBeenCalledTimes(1);
  expect(mockMirror).not.toHaveBeenCalled();
});

it('never throws into the snapshot writer', async () => {
  mockMirror.mockImplementationOnce(() => {
    throw new Error('native module missing');
  });
  await expect(refreshWalletWidgets(snapshot)).resolves.toBeUndefined();
});
