import { useEffect, useRef, useState } from 'react';
import { PERF_LOGS_ENABLED, perfLog } from '../utils/perfLog';

/**
 * `[Perf] ChatOpen <label> first messages <ms>ms (rows=N)`: from the chat
 * screen mounting to the frame after its first non-loading render, once per
 * screen instance. `rows` is what that first paint showed.
 */
export function useChatOpenTiming(label: string, loading: boolean, rowCount: number): void {
  const [openedAt] = useState(Date.now);
  const logged = useRef(false);
  useEffect(() => {
    if (!PERF_LOGS_ENABLED || loading || logged.current) return;
    const frame = requestAnimationFrame(() => {
      logged.current = true;
      perfLog(`ChatOpen ${label} first messages ${Date.now() - openedAt}ms (rows=${rowCount})`);
    });
    return () => cancelAnimationFrame(frame);
  }, [label, loading, rowCount, openedAt]);
}
