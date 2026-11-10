// Everything the widget draws, decided in one pure function (#1849): which
// wallet, the balance or dots, the fiat / "updated" line, the page dots and
// the button links. The JSX in WalletWidget.tsx only lays this out.
import type { WidgetSnapshot } from '../services/widgetSnapshot';
import type { WidgetSettings, WidgetStyleId } from '../services/widgetSettings';
import { formatFiat } from '../services/fiatService';
import { buildWidgetDeepLink, type WidgetAction } from '../navigation/widgetDeepLinks';
import { selectWidgetWallet } from './walletCycling';
import type { WidgetTranslate } from './widgetI18n';

/** Shown instead of the amount when the balance is hidden. */
export const HIDDEN_BALANCE = '••••••';

export interface WalletWidgetModel {
  style: WidgetStyleId;
  /** No wallets to show (signed out, or none added yet). */
  empty: boolean;
  emptyText: string;
  walletId: string | null;
  name: string;
  connected: boolean;
  balanceText: string;
  /** "sats" beside the amount; null while the balance is hidden. */
  unitText: string | null;
  /** "≈ $68.81 · 2 min ago", "Updated 2 min ago", or null. */
  detailText: string | null;
  /** Spoken balance for screen readers. */
  balanceLabel: string;
  pageIndex: number;
  pageCount: number;
  canCycle: boolean;
  links: Record<WidgetAction, string>;
  labels: Record<WidgetAction | 'next' | 'previous', string>;
}

/** Hide the amount when the widget's switch is on, or when there is no
 *  amount to show (unknown, or hidden for this wallet in the app). */
export function shouldHideBalance(hideBalance: boolean, balanceSats: number | null): boolean {
  return hideBalance || balanceSats === null;
}

/** "just now" / "5 min ago" / "3 hours ago" / "2 days ago"; null if unknown. */
export function widgetAgeText(
  updatedAt: number | null,
  now: number,
  t: WidgetTranslate,
): string | null {
  if (updatedAt === null || !Number.isFinite(updatedAt)) return null;
  const minutes = Math.max(0, Math.floor((now - updatedAt) / 60_000));
  if (minutes < 1) return t('widget.age.justNow');
  if (minutes < 60) return t('widget.age.minutes', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('widget.age.hours', { count: hours });
  return t('widget.age.days', { count: Math.floor(hours / 24) });
}

function formatFiatSafe(value: number, currency: string, intlLocale: string): string | null {
  try {
    return formatFiat(value, currency, intlLocale);
  } catch {
    // An unknown currency code makes Intl throw; drop the fiat line instead.
    return null;
  }
}

export interface BuildModelInput {
  snapshot: WidgetSnapshot | null;
  settings: WidgetSettings;
  now: number;
  t: WidgetTranslate;
  intlLocale: string;
}

export function buildWalletWidgetModel({
  snapshot,
  settings,
  now,
  t,
  intlLocale,
}: BuildModelInput): WalletWidgetModel {
  const wallets = snapshot?.wallets ?? [];
  const { wallet, index } = selectWidgetWallet(wallets, settings);
  const walletId = wallet?.id ?? null;
  const hidden = shouldHideBalance(settings.hideBalance, wallet?.balanceSats ?? null);
  const age = widgetAgeText(wallet?.updatedAt ?? null, now, t);
  const fiat =
    !hidden && wallet?.fiatValue != null
      ? formatFiatSafe(wallet.fiatValue, wallet.currency, intlLocale)
      : null;
  let detailText: string | null = null;
  if (fiat && age) detailText = t('widget.fiatAndAge', { fiat, age });
  else if (fiat) detailText = t('widget.fiat', { fiat });
  else if (age) detailText = t('widget.updated', { age });
  const amount = hidden ? null : (wallet?.balanceSats ?? 0).toLocaleString(intlLocale);
  const name = wallet ? wallet.name || t('widget.unnamedWallet') : '';
  return {
    style: settings.style,
    empty: !wallet,
    emptyText: t('widget.empty'),
    walletId,
    name,
    connected: wallet?.connected ?? false,
    balanceText: amount ?? HIDDEN_BALANCE,
    unitText: amount === null ? null : t('widget.satsUnit'),
    detailText,
    balanceLabel:
      amount === null
        ? t('widget.a11y.balanceHidden', { name })
        : t('widget.a11y.balance', { name, amount }),
    pageIndex: index,
    pageCount: wallets.length,
    canCycle: wallets.length > 1,
    links: {
      receive: buildWidgetDeepLink('receive', walletId),
      send: buildWidgetDeepLink('send', walletId),
      scan: buildWidgetDeepLink('scan', walletId),
    },
    labels: {
      receive: t('widget.receive'),
      send: t('widget.send'),
      scan: t('widget.scan'),
      next: t('widget.a11y.nextWallet'),
      previous: t('widget.a11y.previousWallet'),
    },
  };
}
