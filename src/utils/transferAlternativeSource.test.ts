import type { WalletState } from '../types/wallet';
import { findSameChainAlternative } from './transferAlternativeSource';

jest.mock('../components/BrandedAlert', () => ({ Alert: { alert: jest.fn() } }));

const wallet = (over: Partial<WalletState>): WalletState =>
  ({
    id: 'w',
    alias: 'Wallet',
    walletType: 'nwc',
    isConnected: true,
    balance: 0,
    walletAlias: null,
    transactions: [],
    ...over,
  }) as WalletState;

describe('findSameChainAlternative', () => {
  const src = wallet({ id: 'src', walletType: 'onchain', onchainImportMethod: 'mnemonic' });

  it('picks the best-funded connected Lightning wallet for on-chain → Lightning', () => {
    const small = wallet({ id: 'small', balance: 600 });
    const big = wallet({ id: 'big', balance: 900 });
    const offline = wallet({ id: 'off', balance: 5_000, isConnected: false });
    const result = findSameChainAlternative(
      [src, small, big, offline],
      'src',
      'onchain-to-ln',
      500,
    );
    expect(result?.id).toBe('big');
  });

  it('only offers spendable (mnemonic) on-chain wallets for Lightning → on-chain', () => {
    const watchOnly = wallet({
      id: 'xpub',
      walletType: 'onchain',
      onchainImportMethod: 'xpub',
      balance: 9_000,
    });
    const spendable = wallet({
      id: 'seed',
      walletType: 'onchain',
      onchainImportMethod: 'mnemonic',
      balance: 1_000,
    });
    const ln = wallet({ id: 'ln', balance: 5_000 });
    expect(
      findSameChainAlternative([ln, watchOnly, spendable], 'ln', 'ln-to-onchain', 800)?.id,
    ).toBe('seed');
  });

  it('returns null when no wallet can cover the amount or the move is same-chain', () => {
    const ln = wallet({ id: 'ln', balance: 100 });
    expect(findSameChainAlternative([src, ln], 'src', 'onchain-to-ln', 500)).toBeNull();
    expect(findSameChainAlternative([src, ln], 'src', 'ln-to-ln', 50)).toBeNull();
  });
});
