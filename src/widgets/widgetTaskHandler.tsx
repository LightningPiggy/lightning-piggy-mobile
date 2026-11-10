// The headless task Android runs for the home-screen widget (#1849): when a
// widget is added, resized, periodically updated or tapped. ‹ › taps switch
// wallet in place — read the snapshot, step, store, redraw — without opening
// the app. Buttons that open the app use OPEN_URI deep links and never reach
// this handler.
import type { WidgetTaskHandlerProps } from 'react-native-android-widget';
import { readWidgetSnapshot } from '../services/widgetSnapshot';
import { deleteWidgetSettings, updateWidgetSettings } from '../services/widgetSettings';
import { renderWalletWidget } from './renderWalletWidget';
import { walletWidgetSizeFor } from './WalletWidget';
import { settingsAfterWidgetEvent } from './widgetTaskLogic';

export async function widgetTaskHandler(props: WidgetTaskHandlerProps): Promise<void> {
  const size = walletWidgetSizeFor(props.widgetInfo.widgetName);
  if (!size) return;
  const { widgetId } = props.widgetInfo;
  if (props.widgetAction === 'WIDGET_DELETED') {
    await deleteWidgetSettings(widgetId);
    return;
  }
  const snapshot = await readWidgetSnapshot();
  const clickAction = props.widgetAction === 'WIDGET_CLICK' ? props.clickAction : undefined;
  const settings = await updateWidgetSettings(widgetId, (current) =>
    settingsAfterWidgetEvent(current, snapshot, clickAction),
  );
  props.renderWidget(renderWalletWidget(size, snapshot, settings));
}
