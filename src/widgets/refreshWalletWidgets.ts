// Redraw every placed widget from the latest snapshot (#1849) — called by
// the app after it writes or wipes the snapshot. A no-op (one native call)
// when no widget is on the home screen, and on iOS.
import { Platform } from 'react-native';
import { requestWidgetUpdate } from 'react-native-android-widget';
import type { WidgetSnapshot } from '../services/widgetSnapshot';
import { updateWidgetSettings } from '../services/widgetSettings';
import { renderWalletWidget } from './renderWalletWidget';
import { WALLET_WIDGET_NAMES, type WalletWidgetSize } from './WalletWidget';
import { settingsAfterWidgetEvent } from './widgetTaskLogic';

export async function refreshWalletWidgets(snapshot: WidgetSnapshot | null): Promise<void> {
  if (Platform.OS !== 'android') return;
  const sizes = Object.keys(WALLET_WIDGET_NAMES) as WalletWidgetSize[];
  await Promise.all(
    sizes.map((size) =>
      requestWidgetUpdate({
        widgetName: WALLET_WIDGET_NAMES[size],
        renderWidget: async ({ widgetId }) => {
          const settings = await updateWidgetSettings(widgetId, (current) =>
            settingsAfterWidgetEvent(current, snapshot),
          );
          return renderWalletWidget(size, snapshot, settings);
        },
      }).catch((e: unknown) => {
        if (__DEV__) console.warn('[widget] refresh failed:', e);
      }),
    ),
  );
}
