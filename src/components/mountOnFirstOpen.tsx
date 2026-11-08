import React, { useEffect, useState } from 'react';
import { perfLog } from '../utils/perfLog';

// Perf counters for the `ChatSheet mount` lines: sheets mounted right now,
// and mounts since launch.
let mountedNow = 0;
let mountedTotal = 0;

/**
 * Wrap a sheet so it mounts the first time it opens instead of with its
 * screen. Closed sheets still run their hooks (the voice sheet holds a native
 * recorder, Send/Receive run wallet and camera hooks), so a chat screen that
 * mounted every sheet up front paid for all of them before the first message
 * painted. Once opened the sheet stays mounted, so closing animations and
 * the sheet's own reset-on-open logic behave exactly as before.
 *
 * The sheet must present itself when it mounts already open — true of every
 * `visible`-driven sheet here: each one's open effect runs on mount.
 */
export function mountOnFirstOpen<P extends object>(
  Sheet: React.ComponentType<P>,
  name: string,
  isOpen: (props: P) => boolean,
): React.FC<P> {
  const MountedOnFirstOpen: React.FC<P> = (props) => {
    const open = isOpen(props);
    const [opened, setOpened] = useState(open);
    // Derived-state update during render: mounts in the same commit the
    // sheet opens in, with no closed frame in between.
    if (open && !opened) setOpened(true);
    const mounted = opened || open;
    useEffect(() => {
      if (!mounted) return;
      mountedNow++;
      mountedTotal++;
      perfLog(`ChatSheet mount ${name} (mounted=${mountedNow}, total=${mountedTotal})`);
      return () => {
        mountedNow--;
      };
    }, [mounted]);
    return mounted ? <Sheet {...props} /> : null;
  };
  MountedOnFirstOpen.displayName = `MountedOnFirstOpen(${name})`;
  return MountedOnFirstOpen;
}
