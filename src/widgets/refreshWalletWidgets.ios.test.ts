const mockMirror = jest.fn();
const mockWipe = jest.fn();

jest.mock('../services/widgetAppGroup', () => ({
  mirrorWidgetSnapshot: (json: string) => mockMirror(json),
  wipeWidgetAppGroup: () => mockWipe(),
}));

import { refreshWalletWidgets } from './refreshWalletWidgets.ios';
import { WIDGET_WALLET_KEYS, type WidgetSnapshot } from '../services/widgetSnapshot';

const snapshot: WidgetSnapshot = {
  version: 1,
  locale: 'de',
  wallets: [
    {
      id: 'w1',
      name: 'Big Hot',
      walletType: 'nwc',
      balanceSats: 92369,
      fiatValue: 68.81,
      currency: 'USD',
      updatedAt: 1_700_000_000_000,
      order: 0,
      connected: true,
    },
  ],
};

beforeEach(() => jest.clearAllMocks());

it('copies the snapshot JSON into the App Group, unchanged', async () => {
  await refreshWalletWidgets(snapshot);
  expect(mockMirror).toHaveBeenCalledTimes(1);
  const written = JSON.parse(mockMirror.mock.calls[0][0]);
  expect(written).toEqual(snapshot);
  // Only the allow-listed wallet keys reach the extension.
  expect(Object.keys(written.wallets[0]).sort()).toEqual([...WIDGET_WALLET_KEYS].sort());
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
