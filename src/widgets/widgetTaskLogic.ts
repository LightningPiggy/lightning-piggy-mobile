// How a widget's remembered wallet changes for each widget event (#1849).
// Pure, so the switching rules are unit-tested; widgetTaskHandler.tsx does
// the storage and drawing around it.
import type { WidgetSnapshot } from '../services/widgetSnapshot';
import type { WidgetSettings } from '../services/widgetSettings';
import { cycleWidgetWallet, selectWidgetWallet } from './walletCycling';
import { WIDGET_CLICK_NEXT, WIDGET_CLICK_PREVIOUS } from './widgetClickActions';

/**
 * The settings to draw (and store) after an event. A ‹ / › tap steps through
 * the wallets; any event also re-pins the widget to the wallet it now shows,
 * so a widget whose wallet was removed moves on to the next one for good.
 */
export function settingsAfterWidgetEvent(
  settings: WidgetSettings,
  snapshot: WidgetSnapshot | null,
  clickAction?: string,
): WidgetSettings {
  const wallets = snapshot?.wallets ?? [];
  const direction =
    clickAction === WIDGET_CLICK_NEXT ? 1 : clickAction === WIDGET_CLICK_PREVIOUS ? -1 : 0;
  const { wallet, index } =
    direction === 0
      ? selectWidgetWallet(wallets, settings)
      : cycleWidgetWallet(wallets, settings, direction);
  // No wallets (signed out / none yet): keep the remembered choice for later.
  if (!wallet) return settings;
  return { ...settings, walletId: wallet.id, walletIndex: index };
}
