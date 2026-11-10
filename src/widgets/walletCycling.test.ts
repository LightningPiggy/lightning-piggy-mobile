import type { WidgetWallet } from '../services/widgetSnapshot';
import { cycleWidgetWallet, selectWidgetWallet } from './walletCycling';

const w = (id: string, order: number): WidgetWallet => ({
  id,
  name: id.toUpperCase(),
  walletType: 'nwc',
  balanceSats: 1,
  fiatValue: null,
  currency: 'USD',
  updatedAt: null,
  order,
  connected: true,
});
const wallets = [w('a', 0), w('b', 1), w('c', 2)];

describe('selectWidgetWallet', () => {
  it('shows the remembered wallet', () => {
    expect(selectWidgetWallet(wallets, { walletId: 'b', walletIndex: 0 })).toEqual({
      wallet: wallets[1],
      index: 1,
    });
  });

  it('starts on the first wallet when none is remembered', () => {
    expect(selectWidgetWallet(wallets, { walletId: null, walletIndex: 0 }).wallet?.id).toBe('a');
  });

  it('moves a removed wallet’s widget to the next wallet (the one now in its slot)', () => {
    // "b" (slot 1) was removed: "c" slid into slot 1.
    const after = [w('a', 0), w('c', 1)];
    expect(selectWidgetWallet(after, { walletId: 'b', walletIndex: 1 }).wallet?.id).toBe('c');
  });

  it('falls back to the last wallet when the removed one was last', () => {
    const after = [w('a', 0), w('b', 1)];
    expect(selectWidgetWallet(after, { walletId: 'c', walletIndex: 2 })).toEqual({
      wallet: after[1],
      index: 1,
    });
  });

  it('shows nothing when there are no wallets', () => {
    expect(selectWidgetWallet([], { walletId: 'a', walletIndex: 0 })).toEqual({
      wallet: null,
      index: 0,
    });
  });
});

describe('cycleWidgetWallet', () => {
  it('steps through the wallets in carousel order', () => {
    expect(cycleWidgetWallet(wallets, { walletId: 'a', walletIndex: 0 }, 1).wallet?.id).toBe('b');
    expect(cycleWidgetWallet(wallets, { walletId: 'b', walletIndex: 1 }, 1).wallet?.id).toBe('c');
    expect(cycleWidgetWallet(wallets, { walletId: 'c', walletIndex: 2 }, -1).wallet?.id).toBe('b');
  });

  it('wraps around at both ends', () => {
    expect(cycleWidgetWallet(wallets, { walletId: 'c', walletIndex: 2 }, 1)).toEqual({
      wallet: wallets[0],
      index: 0,
    });
    expect(cycleWidgetWallet(wallets, { walletId: 'a', walletIndex: 0 }, -1)).toEqual({
      wallet: wallets[2],
      index: 2,
    });
  });

  it('stays put with a single wallet, and is empty with none', () => {
    expect(cycleWidgetWallet([w('a', 0)], { walletId: 'a', walletIndex: 0 }, 1).wallet?.id).toBe(
      'a',
    );
    expect(cycleWidgetWallet([], { walletId: null, walletIndex: 0 }, 1).wallet).toBeNull();
  });
});
