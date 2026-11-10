// Wiping the home-screen widget's snapshot everywhere it lives (#1849).
//
// The app keeps the snapshot in AsyncStorage (widgetSnapshot.ts); on iPhone
// the widget reads a copy in the App Group (widgetAppGroup.ios.ts — a no-op
// on Android). The App Group copy is cleared FIRST and synchronously, so a
// failing AsyncStorage removal can never leave the previous account's wallet
// names and balances on the home screen. The writer's later refresh(null)
// clears it again, which is harmless.
import { wipeWidgetAppGroup } from './widgetAppGroup';
import { wipeWidgetSnapshot } from './widgetSnapshot';
import type { WidgetSnapshotWriter } from './widgetSnapshotWriter';

function wipeAppGroupNow(): void {
  try {
    wipeWidgetAppGroup();
  } catch (e: unknown) {
    if (__DEV__) console.warn('[widget] App Group wipe failed:', e);
  }
}

/** No wallets left: wipe the App Group copy, then the stored snapshot. */
export function wipeAllWidgetSnapshots(
  wipeStored: () => Promise<void> = wipeWidgetSnapshot,
): Promise<void> {
  wipeAppGroupNow();
  return wipeStored();
}

/** Sign-out / account switch (`wiped` is the stored snapshot's removal). */
export function handleWidgetAccountChange(
  writer: Pick<WidgetSnapshotWriter, 'accountChanged'>,
  wiped: Promise<void>,
): Promise<void> {
  wipeAppGroupNow();
  return writer.accountChanged(wiped);
}
