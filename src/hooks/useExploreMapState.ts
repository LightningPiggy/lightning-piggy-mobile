import { useCallback, useEffect, useRef, useState } from 'react';
import { idleScheduler } from '../utils/idleScheduler';
import {
  cacheExplorePins,
  loadExploreCamera,
  peekExploreCamera,
  peekExplorePins,
  saveExploreCamera,
  type ExploreCamera,
  type ExplorePins,
} from '../services/exploreMapState';
import { PERF_LOGS_ENABLED } from '../utils/perfLog';

/** Mount once after first paint, then replace stale pins after interactions. */
export function useExploreMapState(nextPins: ExplorePins) {
  const [camera, setCamera] = useState(peekExploreCamera);
  const [mounted, setMounted] = useState(false);
  const [pinsReady, setPinsReady] = useState(false);
  const revalidated = useRef(false);
  const [pins, setPins] = useState(peekExplorePins);
  const startedAt = useRef(Date.now());
  const mapLogged = useRef(false);
  const pinsLogged = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let firstPaint: ReturnType<typeof setTimeout> | undefined;
    loadExploreCamera().then((stored) => {
      if (!cancelled) {
        setCamera(stored);
        firstPaint = setTimeout(() => setMounted(true), 0);
      }
    });
    return () => {
      cancelled = true;
      clearTimeout(firstPaint);
    };
  }, []);

  useEffect(() => {
    if (!mounted) return;
    const task = idleScheduler.runWhenIdle(() => {
      // Keep cached pins while mount-time hydration/fetch is still empty.
      // After the first fresh set, an empty update can intentionally clear it.
      if (
        revalidated.current ||
        nextPins.merchants.length + nextPins.caches.length + nextPins.events.length
      ) {
        revalidated.current = true;
        cacheExplorePins(nextPins);
        setPins(nextPins);
      }
      setPinsReady(true);
    });
    return () => task.cancel();
  }, [mounted, nextPins.merchants, nextPins.caches, nextPins.events]); // eslint-disable-line react-hooks/exhaustive-deps

  // Runs after the pin commit, including when a late fetch supplies the first pins.
  useEffect(() => {
    if (
      !mounted ||
      !pinsReady ||
      pinsLogged.current ||
      !(pins.merchants.length + pins.caches.length + pins.events.length)
    )
      return;
    pinsLogged.current = true;
    if (PERF_LOGS_ENABLED) {
      console.log(`[PerfBlock] Explore map pins: ${Date.now() - startedAt.current}ms`);
    }
  }, [mounted, pins, pinsReady]);

  const onMapReady = useCallback(() => {
    if (mapLogged.current) return;
    mapLogged.current = true;
    if (PERF_LOGS_ENABLED) {
      console.log(`[PerfBlock] Explore map ready: ${Date.now() - startedAt.current}ms`);
    }
  }, []);
  const onCameraChange = useCallback((next: ExploreCamera) => {
    void saveExploreCamera(next);
  }, []);
  return { camera, mounted, pins, pinsReady, onMapReady, onCameraChange };
}
