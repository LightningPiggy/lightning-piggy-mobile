import { memo } from 'react';
import { useWidgetSnapshotSync } from '../hooks/useWidgetSnapshotSync';

/** Mount-only host for the home-screen widget's snapshot writer (#1849).
 *  Lives in App.tsx, not WalletContext, so that over-cap file doesn't grow. */
function WidgetSnapshotSync(): null {
  useWidgetSnapshotSync();
  return null;
}

export default memo(WidgetSnapshotSync);
