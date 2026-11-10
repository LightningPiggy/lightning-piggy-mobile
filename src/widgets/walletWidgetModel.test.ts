import type { WidgetSnapshot, WidgetWallet } from '../services/widgetSnapshot';
import { DEFAULT_WIDGET_SETTINGS, type WidgetSettings } from '../services/widgetSettings';
import {
  HIDDEN_BALANCE,
  buildWalletWidgetModel,
  MAX_PAGE_DOTS,
  shouldHideBalance,
  visiblePageDots,
  widgetUpdatedTimeText,
} from './walletWidgetModel';
import { resolveWidgetLocale, widgetTranslator } from './widgetI18n';

// Local time, so the today / yesterday split is timezone-proof.
const NOW = new Date(2026, 10, 10, 14, 32).getTime();
const MIN = 60_000;
const en = widgetTranslator('en');

const w = (id: string, patch: Partial<WidgetWallet> = {}): WidgetWallet => ({
  id,
  name: `Piggy ${id}`,
  walletType: 'nwc',
  balanceSats: 92_369,
  fiatValue: 68.81,
  currency: 'GBP',
  updatedAt: NOW - 2 * MIN,
  order: 0,
  connected: true,
  ...patch,
});
const snapshot = (wallets: WidgetWallet[]): WidgetSnapshot => ({
  version: 1,
  locale: 'en',
  wallets,
});
const build = (snap: WidgetSnapshot | null, patch: Partial<WidgetSettings> = {}) =>
  buildWalletWidgetModel({
    snapshot: snap,
    settings: { ...DEFAULT_WIDGET_SETTINGS, ...patch },
    now: NOW,
    t: en.t,
    intlLocale: 'en-GB',
  });

describe('shouldHideBalance', () => {
  it('shows the balance by default', () => {
    expect(shouldHideBalance(false, 1000)).toBe(false);
    expect(shouldHideBalance(false, 0)).toBe(false);
  });
  it('hides it when the widget’s switch is on, or there is no amount', () => {
    expect(shouldHideBalance(true, 1000)).toBe(true);
    expect(shouldHideBalance(false, null)).toBe(true);
  });
});

describe('widgetUpdatedTimeText', () => {
  const at = (d: number, h: number, m: number) => new Date(2026, 10, d, h, m).getTime();

  it('is the time today, "yesterday" + time, else the date', () => {
    expect(widgetUpdatedTimeText(at(10, 9, 5), NOW, en.t, 'en-GB')).toBe('9:05');
    expect(widgetUpdatedTimeText(at(10, 0, 0), NOW, en.t, 'en-GB')).toBe('0:00');
    expect(widgetUpdatedTimeText(at(9, 23, 59), NOW, en.t, 'en-GB')).toBe('yesterday 23:59');
    expect(widgetUpdatedTimeText(at(7, 14, 32), NOW, en.t, 'en-GB')).toBe('7 Nov');
  });

  it('crosses month and year boundaries for "yesterday"', () => {
    const newYear = new Date(2027, 0, 1, 8, 0).getTime();
    const nye = new Date(2026, 11, 31, 22, 15).getTime();
    expect(widgetUpdatedTimeText(nye, newYear, en.t, 'en-GB')).toBe('yesterday 22:15');
  });

  it('reads a future time (clock skew) as now, and is null when unknown', () => {
    expect(widgetUpdatedTimeText(NOW + 3 * MIN, NOW, en.t, 'en-GB')).toBe('14:32');
    expect(widgetUpdatedTimeText(null, NOW, en.t, 'en-GB')).toBeNull();
  });

  it('speaks the user’s language and time format', () => {
    const de = widgetTranslator('de');
    expect(widgetUpdatedTimeText(at(9, 8, 7), NOW, de.t, de.intlLocale)).toMatch(/8:07/);
  });
});

describe('visiblePageDots', () => {
  it('shows every dot up to the cap', () => {
    expect(visiblePageDots(3, 2)).toEqual({ count: 3, active: 2 });
    expect(visiblePageDots(7, 6)).toEqual({ count: 7, active: 6 });
    expect(visiblePageDots(0, 0)).toEqual({ count: 0, active: 0 });
  });

  it('caps at 7 and keeps the current wallet’s dot visible', () => {
    for (let index = 0; index < 20; index++) {
      const dots = visiblePageDots(20, index);
      expect(dots.count).toBe(MAX_PAGE_DOTS);
      expect(dots.active).toBeGreaterThanOrEqual(0);
      expect(dots.active).toBeLessThan(MAX_PAGE_DOTS);
    }
    expect(visiblePageDots(20, 0).active).toBe(0);
    expect(visiblePageDots(20, 10).active).toBe(3);
    expect(visiblePageDots(20, 19).active).toBe(6);
  });
});

describe('buildWalletWidgetModel', () => {
  it('shows the balance, fiat and fetch time by default', () => {
    const model = build(snapshot([w('a'), w('b')]));
    expect(model).toMatchObject({
      empty: false,
      walletId: 'a',
      name: 'Piggy a',
      connected: true,
      balanceText: '92,369',
      unitText: 'sats',
      detailText: '≈ £68.81 · 14:30',
      dots: { count: 2, active: 0 },
      pageIndex: 0,
      pageCount: 2,
      canCycle: true,
      style: 'piggyPink',
    });
    expect(model.links).toEqual({
      receive: 'lightningpiggy://receive?wallet=a',
      send: 'lightningpiggy://send?wallet=a',
      scan: 'lightningpiggy://scan?wallet=a',
    });
    expect(model.balanceLabel).toBe('Piggy a: 92,369 sats');
  });

  it('shows dots and no amount anywhere when Hide balance is on', () => {
    const model = build(snapshot([w('a')]), { hideBalance: true });
    expect(model.balanceText).toBe(HIDDEN_BALANCE);
    expect(model.unitText).toBeNull();
    expect(model.detailText).toBe('Updated 14:30');
    expect(model.balanceLabel).toBe('Piggy a: balance hidden');
    expect(JSON.stringify(model)).not.toContain('92');
    expect(JSON.stringify(model)).not.toContain('68.81');
  });

  it('shows dots for a wallet whose balance is unknown or hidden in the app', () => {
    const model = build(snapshot([w('a', { balanceSats: null, fiatValue: null })]));
    expect(model.balanceText).toBe(HIDDEN_BALANCE);
  });

  it('follows the remembered wallet and its page dot', () => {
    const model = build(snapshot([w('a'), w('b'), w('c')]), { walletId: 'c', walletIndex: 2 });
    expect(model.walletId).toBe('c');
    expect(model.pageIndex).toBe(2);
  });

  it('drops the fiat line parts it can’t show', () => {
    expect(build(snapshot([w('a', { fiatValue: null })])).detailText).toBe('Updated 14:30');
    expect(build(snapshot([w('a', { updatedAt: null })])).detailText).toBe('≈ £68.81');
    expect(build(snapshot([w('a', { currency: 'NOT-A-CODE' })])).detailText).toBe('Updated 14:30');
  });

  it('hides wallet switching with a single wallet', () => {
    expect(build(snapshot([w('a')])).canCycle).toBe(false);
  });

  it('is the empty state with no snapshot or no wallets', () => {
    for (const snap of [null, snapshot([])]) {
      const model = build(snap);
      expect(model.empty).toBe(true);
      expect(model.emptyText).toBe('Add a wallet in Lightning Piggy');
      expect(model.walletId).toBeNull();
    }
  });

  it('names an unnamed wallet', () => {
    expect(build(snapshot([w('a', { name: '' })])).name).toBe('Wallet');
  });
});

describe('resolveWidgetLocale', () => {
  it('uses the language the app wrote', () => {
    expect(resolveWidgetLocale('uk', 'en-GB')).toBe('uk');
  });
  it('falls back to the phone’s language, then English', () => {
    expect(resolveWidgetLocale('xx', 'es-MX')).toBe('es');
    expect(resolveWidgetLocale(null, 'zh-Hant-TW')).toBe('zh-Hans');
    expect(resolveWidgetLocale(undefined, 'fr-FR')).toBe('en');
    expect(resolveWidgetLocale(null, null)).toBe('en');
  });
});
