import { resolveWalletHealth } from './walletHealthDisplay';

describe('resolveWalletHealth (#1768)', () => {
  it('shows neutral checking for NWC before the first health sync', () => {
    expect(resolveWalletHealth({ walletType: 'nwc', balance: 1000 })).toBe('checking');
    expect(resolveWalletHealth({ walletType: 'nwc', balance: null })).toBe('checking');
  });

  it('passes the live NWC health through once synced', () => {
    for (const h of ['checking', 'responsive', 'degraded', 'disconnected'] as const) {
      expect(resolveWalletHealth({ walletType: 'nwc', balance: 1, connectionHealth: h })).toBe(h);
    }
  });

  it('keeps on-chain binary on balance presence', () => {
    expect(resolveWalletHealth({ walletType: 'onchain', balance: 0 })).toBe('responsive');
    expect(resolveWalletHealth({ walletType: 'onchain', balance: null })).toBe('disconnected');
  });
});
