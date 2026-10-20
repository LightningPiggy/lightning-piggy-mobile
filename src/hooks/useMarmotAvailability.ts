import { useCallback, useEffect, useRef, useState } from 'react';
import { getMarmotSession } from '../services/marmotSession';
import {
  checkMarmotAvailability,
  peekMarmotAvailability,
  type MarmotAvailability,
} from '../utils/marmotAvailability';

/**
 * A contact's Marmot availability while the message-type picker is open.
 * Reads the session cache synchronously (a reopen shows the answer at once),
 * otherwise starts ONE bounded lookup off the render path and sets state once
 * when it settles. `retry` forces a fresh lookup. Idle (null) when there's no
 * contact or the picker is closed.
 */
export function useMarmotAvailability(
  peer: string | null | undefined,
  active: boolean,
): { availability: MarmotAvailability | null; retry: () => void } {
  const [availability, setAvailability] = useState<MarmotAvailability | null>(null);
  // Guards a late answer for a previous peer / closed picker.
  const runRef = useRef(0);

  const run = useCallback(
    (force: boolean) => {
      if (!peer) return;
      const id = ++runRef.current;
      const session = getMarmotSession();
      const known = force ? null : peekMarmotAvailability(session, peer);
      if (known) {
        setAvailability(known);
        return;
      }
      setAvailability('checking');
      void checkMarmotAvailability(session, peer, { force }).then((result) => {
        if (runRef.current === id) setAvailability(result);
      });
    },
    [peer],
  );

  useEffect(() => {
    if (!active || !peer) {
      runRef.current++;
      setAvailability(null);
      return;
    }
    run(false);
  }, [active, peer, run]);

  const retry = useCallback(() => run(true), [run]);
  return { availability, retry };
}
