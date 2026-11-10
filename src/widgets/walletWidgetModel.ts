// Everything the widget draws, decided in one pure function (#1849): which
// wallet, the balance or dots, the fiat / "updated" line, the page dots and
// the button links. The JSX in WalletWidget.tsx only lays this out.
import type { WidgetSnapshot } from '../services/widgetSnapshot';
import type { WidgetSettings, WidgetStyleId } from '../services/widgetSettings';
import { formatFiat } from '../services/fiatService';
import { buildWidgetDeepLink, type WidgetAction } from '../navigation/widgetDeepLinks';
import { selectWidgetWallet } from './walletCycling';
import type { WidgetTranslate } from './widgetI18n';

/** Page dots shown at most; more wallets slide the window. */
export const MAX_PAGE_DOTS = 7;

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
  /** "≈ $68.81 · 14:32", "Updated 14:32", or null. */
  detailText: string | null;
  /** Spoken balance for screen readers. */
  balanceLabel: string;
  pageIndex: number;
  pageCount: number;
  /** The page dots actually drawn (capped at MAX_PAGE_DOTS). */
  dots: { count: number; active: number };
  canCycle: boolean;
  links: Record<WidgetAction, string>;
  labels: Record<WidgetAction | 'next' | 'previous', string>;
}

/** Hide the amount when the widget's switch is on, or when there is no
 *  amount to show (unknown, or hidden for this wallet in the app). */
export function shouldHideBalance(hideBalance: boolean, balanceSats: number | null): boolean {
  return hideBalance || balanceSats === null;
}

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/**
 * When the balance was fetched, as an absolute time in the user's locale:
 * "14:32" today, "yesterday 14:32", else the date ("3 Nov"). Absolute, so the
 * widget never needs a periodic redraw to keep "N min ago" true. A time in the
 * future (clock skew) reads as today. Null when unknown.
 */
export function widgetUpdatedTimeText(
  updatedAt: number | null,
  now: number,
  t: WidgetTranslate,
  intlLocale: string,
): string | null {
  if (updatedAt === null || !Number.isFinite(updatedAt)) return null;
  const at = new Date(Math.min(updatedAt, now));
  const today = new Date(now);
  const time = at.toLocaleTimeString(intlLocale, { hour: 'numeric', minute: '2-digit' });
  if (sameLocalDay(at, today)) return time;
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (sameLocalDay(at, yesterday)) return t('widget.yesterdayAt', { time });
  return at.toLocaleDateString(intlLocale, { day: 'numeric', month: 'short' });
}

/** At most `max` page dots, sliding so the current wallet's dot stays shown. */
export function visiblePageDots(
  pageCount: number,
  pageIndex: number,
  max = MAX_PAGE_DOTS,
): { count: number; active: number } {
  const count = Math.min(Math.max(pageCount, 0), max);
  if (pageCount <= max) return { count, active: pageIndex };
  const start = Math.min(Math.max(pageIndex - Math.floor(max / 2), 0), pageCount - max);
  return { count, active: pageIndex - start };
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
  const time = widgetUpdatedTimeText(wallet?.updatedAt ?? null, now, t, intlLocale);
  const fiat =
    !hidden && wallet?.fiatValue != null
      ? formatFiatSafe(wallet.fiatValue, wallet.currency, intlLocale)
      : null;
  let detailText: string | null = null;
  if (fiat && time) detailText = t('widget.fiatAndTime', { fiat, time });
  else if (fiat) detailText = t('widget.fiat', { fiat });
  else if (time) detailText = t('widget.updatedAt', { time });
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
    dots: visiblePageDots(wallets.length, index),
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
