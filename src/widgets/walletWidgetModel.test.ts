import type { WidgetSnapshot, WidgetWallet } from '../services/widgetSnapshot';
import { DEFAULT_WIDGET_SETTINGS, type WidgetSettings } from '../services/widgetSettings';
import {
  HIDDEN_BALANCE,
  buildWalletWidgetModel,
  shouldHideBalance,
  widgetAgeText,
} from './walletWidgetModel';
import { resolveWidgetLocale, widgetTranslator } from './widgetI18n';

const NOW = 1_800_000_000_000;
const MIN = 60_000;
const en = widgetTranslator('en');

const w = (id: string, patch: Partial<WidgetWallet> = {}): WidgetWallet => ({
  id,
  name: `Piggy ${id}`,
  walletType: 'nwc',
  balanceSats: 92_369,
  fiatValue: 68.81,
  currency: 'USD',
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
    intlLocale: 'en-US',
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

describe('widgetAgeText', () => {
  it.each([
    [0, 'just now'],
    [59_000, 'just now'],
    [MIN, '1 min ago'],
    [5 * MIN, '5 min ago'],
    [59 * MIN, '59 min ago'],
    [60 * MIN, '1 hour ago'],
    [5 * 60 * MIN, '5 hours ago'],
    [24 * 60 * MIN, '1 day ago'],
    [3 * 24 * 60 * MIN, '3 days ago'],
  ])('%p ms old → %p', (age, text) => {
    expect(widgetAgeText(NOW - age, NOW, en.t)).toBe(text);
  });

  it('clamps a future time to just now, and is null when unknown', () => {
    expect(widgetAgeText(NOW + 10 * MIN, NOW, en.t)).toBe('just now');
    expect(widgetAgeText(null, NOW, en.t)).toBeNull();
  });

  it('speaks the user’s language', () => {
    expect(widgetAgeText(NOW - 5 * MIN, NOW, widgetTranslator('de').t)).toBe('vor 5 Min.');
  });
});

describe('buildWalletWidgetModel', () => {
  it('shows the balance, fiat and age by default', () => {
    const model = build(snapshot([w('a'), w('b')]));
    expect(model).toMatchObject({
      empty: false,
      walletId: 'a',
      name: 'Piggy a',
      connected: true,
      balanceText: '92,369',
      unitText: 'sats',
      detailText: '≈ $68.81 · 2 min ago',
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
    expect(model.detailText).toBe('Updated 2 min ago');
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
    expect(build(snapshot([w('a', { fiatValue: null })])).detailText).toBe('Updated 2 min ago');
    expect(build(snapshot([w('a', { updatedAt: null })])).detailText).toBe('≈ $68.81');
    expect(build(snapshot([w('a', { currency: 'NOT-A-CODE' })])).detailText).toBe(
      'Updated 2 min ago',
    );
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
