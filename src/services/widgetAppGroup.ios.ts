// iOS half of the home-screen widget's storage (#1849). The iPhone widget is a
// separate WidgetKit extension (targets/widget, Swift), so it can't read the
// app's AsyncStorage: the app mirrors the same allow-listed snapshot JSON that
// widgetSnapshot.ts writes into the App Group `group.<bundle id>` (declared
// in app.config.ts for the app and in targets/widget/expo-target.config.js for
// the extension), then asks WidgetKit to redraw. The wipe removes the snapshot
// and the widget's own ‹ › positions, so a signed-out phone shows nothing.
//
// Keys must match targets/widget/Snapshot.swift (`WidgetStore`).
// ExtensionStorage is @bacons/apple-targets' native module; on a build
// without it (Expo Go, an older dev client) its calls are no-ops.
import * as Application from 'expo-application';
import { ExtensionStorage } from '@bacons/apple-targets';

export const APP_GROUP_SNAPSHOT_KEY = 'widget_snapshot_v1';
export const APP_GROUP_CURSORS_KEY = 'widget_cursors_v1';

/** `group.<bundle id>`: one App Group per build variant. */
export function appGroupIdentifier(
  bundleId: string | null = Application.applicationId,
): string | null {
  return bundleId ? `group.${bundleId}` : null;
}

let storage: ExtensionStorage | null | undefined;

function appGroupStorage(): ExtensionStorage | null {
  if (storage === undefined) {
    const group = appGroupIdentifier();
    storage = group ? new ExtensionStorage(group) : null;
  }
  return storage;
}

/** Writes the snapshot JSON (already shaped by widgetSnapshot.ts) for the widget. */
export function mirrorWidgetSnapshot(json: string): void {
  const target = appGroupStorage();
  if (!target) return;
  target.set(APP_GROUP_SNAPSHOT_KEY, json);
  ExtensionStorage.reloadWidget();
}

/** Sign-out / account switch: forget every wallet and every widget position. */
export function wipeWidgetAppGroup(): void {
  const target = appGroupStorage();
  if (!target) return;
  target.remove(APP_GROUP_SNAPSHOT_KEY);
  target.remove(APP_GROUP_CURSORS_KEY);
  ExtensionStorage.reloadWidget();
}

/** Test seam: forget the cached App Group handle. */
export function resetWidgetAppGroupForTests(): void {
  storage = undefined;
}
