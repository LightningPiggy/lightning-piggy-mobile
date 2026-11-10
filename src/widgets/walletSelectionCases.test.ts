// Shared cases for wallet selection and page dots (#1849). The same JSON is
// run against the Swift port (targets/widget: WalletSelection, PageDotsWindow)
// by scripts/ios-tests/WidgetLogicTests.swift in CI, so the Android and
// iPhone widgets can't drift apart.
import cases from './walletSelectionCases.json';
import { cycleWidgetWallet, selectWidgetWallet } from './walletCycling';
import { visiblePageDots } from './walletWidgetModel';
import type { WidgetWallet } from '../services/widgetSnapshot';

function wallets(ids: string[]): WidgetWallet[] {
  return ids.map((id, order) => ({
    id,
    name: id,
    walletType: 'nwc',
    balanceSats: 1,
    fiatValue: null,
    currency: 'USD',
    updatedAt: null,
    order,
    connected: true,
  }));
}

describe.each(cases.selection)('$name', (c) => {
  // iOS keeps {walletId, index} once a wallet has been shown; before that it
  // has only the starting wallet — Android's settings with slot 0.
  const settings = c.cursor
    ? { walletId: c.cursor.walletId, walletIndex: c.cursor.index }
    : { walletId: c.start, walletIndex: 0 };
  const list = wallets(c.wallets);

  it('shows the expected wallet', () => {
    const { wallet, index } = selectWidgetWallet(list, settings);
    expect(wallet ? index : null).toBe(c.shown);
  });

  it('steps to the expected next and previous wallets', () => {
    const next = cycleWidgetWallet(list, settings, 1);
    const previous = cycleWidgetWallet(list, settings, -1);
    expect(next.wallet ? next.index : null).toBe(c.next);
    expect(previous.wallet ? previous.index : null).toBe(c.previous);
  });
});

it.each(cases.pageDots)(
  'page dots for $pageCount wallets at $pageIndex',
  ({ pageCount, pageIndex, count, active }) => {
    expect(visiblePageDots(pageCount, pageIndex)).toEqual({ count, active });
  },
);
