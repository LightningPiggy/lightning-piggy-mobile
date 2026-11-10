import type { WalletState } from '../types/wallet';
import { nextWidgetLaunchStep, resolveWidgetLaunchWallet } from './widgetLaunch';

const wallet = (id: string, patch: Partial<WalletState> = {}): WalletState => ({
  id,
  alias: id,
  theme: 'lightning-piggy',
  order: 0,
  walletType: 'nwc',
  lightningAddress: null,
  isConnected: true,
  balance: 100,
  walletAlias: null,
  transactions: [],
  ...patch,
});
const wallets = [wallet('a'), wallet('b')];

describe('resolveWidgetLaunchWallet', () => {
  it('uses the requested wallet when it exists', () => {
    expect(resolveWidgetLaunchWallet('b', wallets, 'a')).toBe('b');
  });
  it('falls back to the active wallet for an unknown or missing id', () => {
    expect(resolveWidgetLaunchWallet('gone', wallets, 'b')).toBe('b');
    expect(resolveWidgetLaunchWallet(null, wallets, 'b')).toBe('b');
  });
  it('falls back to the first wallet when the active one is unknown too', () => {
    expect(resolveWidgetLaunchWallet('gone', wallets, 'also-gone')).toBe('a');
    expect(resolveWidgetLaunchWallet('gone', wallets, null)).toBe('a');
  });
  it('is null without wallets', () => {
    expect(resolveWidgetLaunchWallet('a', [], null)).toBeNull();
  });
});

describe('nextWidgetLaunchStep', () => {
  const base = { wallets, activeWalletId: 'a', walletsHydrated: true };

  it('waits for the wallet list on a cold start', () => {
    expect(
      nextWidgetLaunchStep({ ...base, action: 'send', walletId: 'b', walletsHydrated: false }),
    ).toEqual({
      kind: 'wait',
    });
  });

  it('selects the requested wallet first, then opens the sheet', () => {
    expect(nextWidgetLaunchStep({ ...base, action: 'receive', walletId: 'b' })).toEqual({
      kind: 'select',
      walletId: 'b',
    });
    expect(
      nextWidgetLaunchStep({ ...base, activeWalletId: 'b', action: 'receive', walletId: 'b' }),
    ).toEqual({ kind: 'open', sheet: 'receive' });
  });

  it.each(['send', 'scan'] as const)('opens %s on the active wallet', (action) => {
    expect(nextWidgetLaunchStep({ ...base, action, walletId: 'a' })).toEqual({
      kind: 'open',
      sheet: action,
    });
  });

  it('opens on the current wallet when the link’s wallet is unknown', () => {
    expect(nextWidgetLaunchStep({ ...base, action: 'send', walletId: 'removed' })).toEqual({
      kind: 'open',
      sheet: 'send',
    });
  });

  it('explains instead of opening Send on a watch-only wallet', () => {
    const watchOnly = wallet('w', { walletType: 'onchain', onchainImportMethod: 'xpub' });
    const input = { wallets: [watchOnly], activeWalletId: 'w', walletsHydrated: true };
    expect(nextWidgetLaunchStep({ ...input, action: 'scan', walletId: 'w' })).toEqual({
      kind: 'watchOnly',
    });
    expect(nextWidgetLaunchStep({ ...input, action: 'receive', walletId: 'w' })).toEqual({
      kind: 'open',
      sheet: 'receive',
    });
  });

  it('just lands on Home with no wallets', () => {
    expect(
      nextWidgetLaunchStep({
        wallets: [],
        activeWalletId: null,
        walletsHydrated: true,
        action: 'receive',
        walletId: 'a',
      }),
    ).toEqual({ kind: 'done' });
  });
});
