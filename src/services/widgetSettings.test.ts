import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  DEFAULT_WIDGET_SETTINGS,
  WIDGET_SETTINGS_KEY,
  deleteWidgetSettings,
  normaliseWidgetSettings,
  readWidgetSettings,
  saveWidgetSettings,
  updateWidgetSettings,
} from './widgetSettings';

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('normaliseWidgetSettings', () => {
  it('defaults to the first wallet, Piggy pink, balance shown', () => {
    expect(normaliseWidgetSettings(undefined)).toEqual({
      walletId: null,
      walletIndex: 0,
      style: 'piggyPink',
      hideBalance: false,
    });
  });

  it('repairs invalid fields one by one', () => {
    expect(
      normaliseWidgetSettings({ walletId: '', walletIndex: -2, style: 'neon', hideBalance: 'yes' }),
    ).toEqual(DEFAULT_WIDGET_SETTINGS);
    expect(
      normaliseWidgetSettings({
        walletId: 'w2',
        walletIndex: 3,
        style: 'nightGlass',
        hideBalance: true,
      }),
    ).toEqual({ walletId: 'w2', walletIndex: 3, style: 'nightGlass', hideBalance: true });
  });
});

describe('widget settings storage', () => {
  it('stores settings per widget id', async () => {
    await saveWidgetSettings(7, { ...DEFAULT_WIDGET_SETTINGS, walletId: 'a', style: 'cleanWhite' });
    await saveWidgetSettings(8, { ...DEFAULT_WIDGET_SETTINGS, walletId: 'b', hideBalance: true });
    expect(await readWidgetSettings(7)).toMatchObject({ walletId: 'a', style: 'cleanWhite' });
    expect(await readWidgetSettings(8)).toMatchObject({ walletId: 'b', hideBalance: true });
    expect(await readWidgetSettings(9)).toEqual(DEFAULT_WIDGET_SETTINGS);
  });

  it('serialises concurrent updates so none is lost', async () => {
    await saveWidgetSettings(1, { ...DEFAULT_WIDGET_SETTINGS, walletIndex: 0 });
    const step = (widgetId: number) =>
      updateWidgetSettings(widgetId, (s) => ({ ...s, walletIndex: s.walletIndex + 1 }));
    await Promise.all([step(1), step(1), step(1), step(2)]);
    expect((await readWidgetSettings(1)).walletIndex).toBe(3);
    expect((await readWidgetSettings(2)).walletIndex).toBe(1);
  });

  it('forgets a deleted widget', async () => {
    await saveWidgetSettings(4, { ...DEFAULT_WIDGET_SETTINGS, walletId: 'x' });
    await deleteWidgetSettings(4);
    await deleteWidgetSettings(5); // never stored: a no-op
    expect(JSON.parse((await AsyncStorage.getItem(WIDGET_SETTINGS_KEY)) ?? '{}')).toEqual({});
  });

  it('reads corrupt storage as defaults', async () => {
    await AsyncStorage.setItem(WIDGET_SETTINGS_KEY, '[1,2');
    expect(await readWidgetSettings(1)).toEqual(DEFAULT_WIDGET_SETTINGS);
  });
});
