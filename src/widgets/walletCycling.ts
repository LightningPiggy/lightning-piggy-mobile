// Which wallet a widget shows, and ‹ › cycling through the account's wallets
// in the app's carousel order (#1849). Pure: no storage, no rendering.
import type { WidgetWallet } from '../services/widgetSnapshot';
import type { WidgetSettings } from '../services/widgetSettings';

export interface WidgetWalletSelection {
  wallet: WidgetWallet | null;
  index: number;
}

/**
 * The wallet a widget shows. Its remembered wallet if it still exists;
 * otherwise (it was removed) the wallet now in its old carousel slot — the
 * next one — clamped to the last wallet; null when there are no wallets.
 */
export function selectWidgetWallet(
  wallets: readonly WidgetWallet[],
  settings: Pick<WidgetSettings, 'walletId' | 'walletIndex'>,
): WidgetWalletSelection {
  if (wallets.length === 0) return { wallet: null, index: 0 };
  const found = settings.walletId ? wallets.findIndex((w) => w.id === settings.walletId) : -1;
  const index =
    found >= 0 ? found : Math.min(Math.max(settings.walletIndex, 0), wallets.length - 1);
  return { wallet: wallets[index], index };
}

/** Step to the next (+1) or previous (-1) wallet, wrapping at either end. */
export function cycleWidgetWallet(
  wallets: readonly WidgetWallet[],
  settings: Pick<WidgetSettings, 'walletId' | 'walletIndex'>,
  direction: 1 | -1,
): WidgetWalletSelection {
  if (wallets.length === 0) return { wallet: null, index: 0 };
  const { index } = selectWidgetWallet(wallets, settings);
  const next = (index + direction + wallets.length) % wallets.length;
  return { wallet: wallets[next], index: next };
}
