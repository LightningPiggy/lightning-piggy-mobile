// iPhone counterpart of refreshWalletWidgets.ts (#1849), called by
// useWidgetSnapshotSync after it writes or wipes the snapshot. The iPhone
// widget is a WidgetKit extension that can only read the App Group, so
// "redraw" here means: copy the same snapshot there (or wipe it there on
// sign-out / account switch, when the snapshot is null) and reload the
// widget timelines. See src/services/widgetAppGroup.ios.ts.
import type { WidgetSnapshot } from '../services/widgetSnapshot';
import { mirrorWidgetSnapshot, wipeWidgetAppGroup } from '../services/widgetAppGroup';

export async function refreshWalletWidgets(snapshot: WidgetSnapshot | null): Promise<void> {
  try {
    if (snapshot) mirrorWidgetSnapshot(JSON.stringify(snapshot));
    else wipeWidgetAppGroup();
  } catch (e: unknown) {
    if (__DEV__) console.warn('[widget] App Group update failed:', e);
  }
}
