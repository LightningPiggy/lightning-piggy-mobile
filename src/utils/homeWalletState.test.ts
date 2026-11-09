import { selectHomeWalletState } from './homeWalletState';
import type { WalletState } from '../types/wallet';

function wallet(id: string, overrides: Partial<WalletState> = {}): WalletState {
  return {
    id,
    alias: id,
    theme: 'lightning-piggy',
    order: 0,
    walletType: 'nwc',
    lightningAddress: null,
    isConnected: true,
    balance: 12914,
    walletAlias: null,
    transactions: [{ type: 'incoming', amount: 1 }],
    ...overrides,
  };
}

it('keeps all actions enabled with the three wallets shown by four carousel dots', () => {
  const wallets = [wallet('notification'), wallet('second'), wallet('third')];
  const state = selectHomeWalletState(wallets, 'notification', true);
  expect(state.activeWallet).toBe(wallets[0]);
  expect(state.activeWallet?.transactions).toBe(wallets[0].transactions);
  expect(state).toMatchObject({
    hasWallets: true,
    showWelcome: false,
    isReceiveDisabled: false,
    isSendDisabled: false,
    isTransferDisabled: false,
    dimActions: false,
  });
});

it.each([false, true])('does not gate actions on connection health (hydrated=%s)', (hydrated) => {
  const wallets = [wallet('a', { isConnected: false }), wallet('b', { isConnected: false })];
  expect(selectHomeWalletState(wallets, 'a', hydrated)).toMatchObject({
    isReceiveDisabled: false,
    isSendDisabled: false,
    isTransferDisabled: false,
    dimActions: false,
  });
});

it('never dims the actions while a single wallet card is visible', () => {
  expect(selectHomeWalletState([wallet('a')], 'a', true)).toMatchObject({
    isReceiveDisabled: false,
    isSendDisabled: false,
    isTransferDisabled: true,
    dimActions: false,
  });
});

it('keeps Send pressable on a watch-only wallet so the tap can explain why (#1799)', () => {
  const watchOnly = wallet('watch', { walletType: 'onchain', onchainImportMethod: 'xpub' });
  expect(selectHomeWalletState([watchOnly, wallet('b')], 'watch', true)).toMatchObject({
    activeWallet: watchOnly,
    isReceiveDisabled: false,
    isSendDisabled: false,
    isSendWatchOnly: true,
    isTransferDisabled: false,
    dimActions: false,
  });
});

it('does not flag a signing wallet as watch-only', () => {
  const mnemonic = wallet('seed', { walletType: 'onchain', onchainImportMethod: 'mnemonic' });
  expect(selectHomeWalletState([mnemonic], 'seed', true).isSendWatchOnly).toBe(false);
  expect(selectHomeWalletState([wallet('a')], 'a', true).isSendWatchOnly).toBe(false);
});

it('uses only the current carousel list when the selected id belongs to an old identity', () => {
  const wallets = [wallet('new-a'), wallet('new-b')];
  expect(selectHomeWalletState(wallets, 'old-watch-only', true)).toMatchObject({
    activeWallet: null,
    hasWallets: true,
    isSendDisabled: false,
    dimActions: false,
  });
});

it('shows loading rather than the new-user prompt before the first storage read (#1396)', () => {
  expect(selectHomeWalletState([], null, false)).toMatchObject({
    hasWallets: false,
    activeWallet: null,
    showWelcome: false,
    isReceiveDisabled: false,
    isSendDisabled: false,
    isTransferDisabled: false,
    dimActions: false,
  });
});

it('shows the welcome prompt and disabled actions only after confirmed empty hydration', () => {
  expect(selectHomeWalletState([], null, true)).toMatchObject({
    showWelcome: true,
    isReceiveDisabled: true,
    isSendDisabled: true,
    isSendWatchOnly: false,
    isTransferDisabled: true,
    dimActions: true,
  });
});

it('does not flash the welcome prompt or retain old wallet state during an identity reload', () => {
  const before = selectHomeWalletState([wallet('old')], 'old', true);
  const switching = selectHomeWalletState([], null, false);
  const after = selectHomeWalletState([wallet('new-a'), wallet('new-b')], 'new-a', true);
  expect(before.activeWallet?.id).toBe('old');
  expect(switching.activeWallet).toBeNull();
  expect(switching.showWelcome).toBe(false);
  expect(switching.dimActions).toBe(false);
  expect(after.activeWallet?.id).toBe('new-a');
  expect(after.isTransferDisabled).toBe(false);
  expect(after.dimActions).toBe(false);
});
