// What Home does with a widget deep link (#1849), one step at a time:
// wait for the wallet list, select the requested wallet, then open the sheet.
// Selecting first (and opening only once that wallet is active) means the
// Receive / Send sheet captures the right wallet when it opens. Pure, so the
// fallbacks are unit-tested: an unknown or missing wallet id keeps the
// current wallet (or the first one) rather than failing.
import type { WalletState } from '../types/wallet';
import type { WidgetAction } from '../navigation/widgetDeepLinks';
import { selectHomeWalletState } from './homeWalletState';

export type WidgetLaunchStep =
  /** Wallets are still loading: keep the request and look again later. */
  | { kind: 'wait' }
  /** Make this wallet active, then look again. */
  | { kind: 'select'; walletId: string }
  /** The right wallet is active: open the sheet. */
  | { kind: 'open'; sheet: WidgetAction }
  /** Send/Scan on a watch-only wallet: explain instead of opening Send. */
  | { kind: 'watchOnly' }
  /** Nothing to open (no wallets, or this wallet can't send): stay on Home. */
  | { kind: 'done' };

export interface WidgetLaunchInput {
  action: WidgetAction;
  walletId: string | null;
  wallets: readonly WalletState[];
  activeWalletId: string | null;
  walletsHydrated: boolean;
}

/** The wallet a widget link should land on: the requested one if it still
 *  exists, else the active wallet, else the first. null = no wallets. */
export function resolveWidgetLaunchWallet(
  walletId: string | null,
  wallets: readonly Pick<WalletState, 'id'>[],
  activeWalletId: string | null,
): string | null {
  if (walletId && wallets.some((w) => w.id === walletId)) return walletId;
  if (activeWalletId && wallets.some((w) => w.id === activeWalletId)) return activeWalletId;
  return wallets[0]?.id ?? null;
}

export function nextWidgetLaunchStep({
  action,
  walletId,
  wallets,
  activeWalletId,
  walletsHydrated,
}: WidgetLaunchInput): WidgetLaunchStep {
  if (!walletsHydrated) return { kind: 'wait' };
  const target = resolveWidgetLaunchWallet(walletId, wallets, activeWalletId);
  if (!target) return { kind: 'done' };
  if (target !== activeWalletId) return { kind: 'select', walletId: target };
  if (action === 'receive') return { kind: 'open', sheet: 'receive' };
  const { isSendWatchOnly, isSendDisabled } = selectHomeWalletState(wallets, target, true);
  if (isSendWatchOnly) return { kind: 'watchOnly' };
  if (isSendDisabled) return { kind: 'done' };
  return { kind: 'open', sheet: action };
}
