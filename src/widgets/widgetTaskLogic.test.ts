import type { WidgetSnapshot, WidgetWallet } from '../services/widgetSnapshot';
import { DEFAULT_WIDGET_SETTINGS, type WidgetSettings } from '../services/widgetSettings';
import { WIDGET_CLICK_NEXT, WIDGET_CLICK_PREVIOUS } from './widgetClickActions';
import { settingsAfterWidgetEvent } from './widgetTaskLogic';

const w = (id: string, order: number): WidgetWallet => ({
  id,
  name: id,
  walletType: 'nwc',
  balanceSats: 10,
  fiatValue: null,
  currency: 'USD',
  updatedAt: null,
  order,
  connected: true,
});
const snapshot = (ids: string[]): WidgetSnapshot => ({
  version: 1,
  locale: 'en',
  wallets: ids.map((id, i) => w(id, i)),
});
const settings = (patch: Partial<WidgetSettings> = {}): WidgetSettings => ({
  ...DEFAULT_WIDGET_SETTINGS,
  ...patch,
});

describe('settingsAfterWidgetEvent', () => {
  it('pins a new widget to the first wallet', () => {
    expect(settingsAfterWidgetEvent(settings(), snapshot(['a', 'b']))).toMatchObject({
      walletId: 'a',
      walletIndex: 0,
    });
  });

  it('› and ‹ step and wrap, keeping style and hide-balance', () => {
    const start = settings({
      walletId: 'b',
      walletIndex: 1,
      style: 'nightGlass',
      hideBalance: true,
    });
    const s = snapshot(['a', 'b', 'c']);
    expect(settingsAfterWidgetEvent(start, s, WIDGET_CLICK_NEXT)).toEqual({
      ...start,
      walletId: 'c',
      walletIndex: 2,
    });
    const last = settings({ walletId: 'c', walletIndex: 2 });
    expect(settingsAfterWidgetEvent(last, s, WIDGET_CLICK_NEXT)).toMatchObject({ walletId: 'a' });
    expect(settingsAfterWidgetEvent(start, s, WIDGET_CLICK_PREVIOUS)).toMatchObject({
      walletId: 'a',
      walletIndex: 0,
    });
  });

  it('re-pins a widget whose wallet was removed to the next wallet', () => {
    const before = settings({ walletId: 'b', walletIndex: 1 });
    expect(settingsAfterWidgetEvent(before, snapshot(['a', 'c']))).toMatchObject({
      walletId: 'c',
      walletIndex: 1,
    });
  });

  it('keeps the remembered choice while there are no wallets (signed out)', () => {
    const before = settings({ walletId: 'b', walletIndex: 1 });
    expect(settingsAfterWidgetEvent(before, null, WIDGET_CLICK_NEXT)).toBe(before);
    expect(settingsAfterWidgetEvent(before, snapshot([]))).toBe(before);
  });

  it('ignores unknown click actions', () => {
    const before = settings({ walletId: 'b', walletIndex: 1 });
    expect(settingsAfterWidgetEvent(before, snapshot(['a', 'b']), 'SOMETHING')).toMatchObject({
      walletId: 'b',
    });
  });
});
