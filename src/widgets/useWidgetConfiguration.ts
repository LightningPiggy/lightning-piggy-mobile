import { useCallback, useEffect, useState } from 'react';
import { readWidgetSnapshot, type WidgetSnapshot } from '../services/widgetSnapshot';
import {
  DEFAULT_WIDGET_SETTINGS,
  readWidgetSettings,
  saveWidgetSettings,
  type WidgetSettings,
} from '../services/widgetSettings';
import { selectWidgetWallet } from './walletCycling';

/**
 * State for the widget configuration screen (#1849): the snapshot's wallets
 * to pick from, and this widget's settings — its stored ones when
 * reconfiguring, the defaults (first wallet, Piggy pink, balance shown) when
 * it was just added.
 */
export function useWidgetConfiguration(widgetId: number) {
  const [loaded, setLoaded] = useState(false);
  const [snapshot, setSnapshot] = useState<WidgetSnapshot | null>(null);
  const [settings, setSettings] = useState<WidgetSettings>(DEFAULT_WIDGET_SETTINGS);

  useEffect(() => {
    let alive = true;
    void Promise.all([readWidgetSnapshot(), readWidgetSettings(widgetId)]).then(
      ([stored, current]) => {
        if (!alive) return;
        const { wallet, index } = selectWidgetWallet(stored?.wallets ?? [], current);
        setSnapshot(stored);
        setSettings({ ...current, walletId: wallet?.id ?? null, walletIndex: index });
        setLoaded(true);
      },
    );
    return () => {
      alive = false;
    };
  }, [widgetId]);

  const selectWallet = useCallback(
    (walletId: string) => {
      const index = snapshot?.wallets.findIndex((w) => w.id === walletId) ?? -1;
      if (index >= 0) setSettings((s) => ({ ...s, walletId, walletIndex: index }));
    },
    [snapshot],
  );
  const update = useCallback((patch: Partial<Pick<WidgetSettings, 'style' | 'hideBalance'>>) => {
    setSettings((s) => ({ ...s, ...patch }));
  }, []);
  const save = useCallback(() => saveWidgetSettings(widgetId, settings), [widgetId, settings]);

  return { loaded, snapshot, settings, selectWallet, update, save };
}
