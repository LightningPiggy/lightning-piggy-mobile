// The headless task Android runs for the home-screen widget (#1849): when a
// widget is added, resized or tapped (and when the app asks for a redraw).
// ‹ › taps switch wallet in place — read the snapshot, step, store, redraw —
// without opening the app. Buttons that open the app use OPEN_URI deep links
// and never reach this handler.
import type { WidgetTaskHandlerProps } from 'react-native-android-widget';
import { readWidgetSnapshot, type WidgetSnapshot } from '../services/widgetSnapshot';
import {
  deleteWidgetSettings,
  updateWidgetSettings,
  type WidgetSettings,
} from '../services/widgetSettings';
import { renderFallbackWidget, renderWalletWidget } from './renderWalletWidget';
import { walletWidgetSizeFor } from './WalletWidget';
import { settingsAfterWidgetEvent } from './widgetTaskLogic';

export interface WidgetTaskDeps {
  readSnapshot: () => Promise<WidgetSnapshot | null>;
  updateSettings: (
    widgetId: number,
    update: (current: WidgetSettings) => WidgetSettings,
  ) => Promise<WidgetSettings>;
  deleteSettings: (widgetId: number) => Promise<void>;
}

const defaultDeps: WidgetTaskDeps = {
  readSnapshot: readWidgetSnapshot,
  updateSettings: updateWidgetSettings,
  deleteSettings: deleteWidgetSettings,
};

export async function handleWidgetTask(
  props: WidgetTaskHandlerProps,
  deps: WidgetTaskDeps = defaultDeps,
): Promise<void> {
  const size = walletWidgetSizeFor(props.widgetInfo.widgetName);
  if (!size) return;
  const { widgetId } = props.widgetInfo;
  if (props.widgetAction === 'WIDGET_DELETED') {
    await deps.deleteSettings(widgetId);
    return;
  }
  let snapshot: WidgetSnapshot | null = null;
  try {
    snapshot = await deps.readSnapshot();
    const clickAction = props.widgetAction === 'WIDGET_CLICK' ? props.clickAction : undefined;
    const settings = await deps.updateSettings(widgetId, (current) =>
      settingsAfterWidgetEvent(current, snapshot, clickAction),
    );
    props.renderWidget(renderWalletWidget(size, snapshot, settings));
  } catch (e) {
    // Storage or drawing failed: never leave the tile blank.
    if (__DEV__) console.warn('[widget] task failed, drawing the fallback:', e);
    props.renderWidget(renderFallbackWidget(snapshot?.locale));
  }
}

export const widgetTaskHandler = (props: WidgetTaskHandlerProps): Promise<void> =>
  handleWidgetTask(props);
