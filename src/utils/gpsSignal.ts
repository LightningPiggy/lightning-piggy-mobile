// Maps the GPS fix accuracy (metres) onto a 0–3 bar signal level for the
// full-map header indicator. The fused-location provider does not expose a
// satellite count, so accuracy is the only honest proxy we have.
//   < 10 m        → 3 bars (strong)
//   10–30 m       → 2 bars (good)
//   30–100 m      → 1 bar  (weak)
//   > 100 m / n/a → 0 bars (no fix)
export type GpsSignalBars = 0 | 1 | 2 | 3;

export function gpsSignalBars(accuracyMetres: number | null | undefined): GpsSignalBars {
  if (typeof accuracyMetres !== 'number' || !Number.isFinite(accuracyMetres)) return 0;
  if (accuracyMetres > 100) return 0;
  if (accuracyMetres < 10) return 3;
  if (accuracyMetres < 30) return 2;
  return 1;
}

// Picks the freshest fix that carries a usable accuracy: the live fix when it
// has one, otherwise the initial fix the map was centred on.
export function gpsBarsForFixes(
  livePos: { accuracy: number | null } | null | undefined,
  initialPos: { accuracy: number | null } | null | undefined
): GpsSignalBars {
  return gpsSignalBars(livePos?.accuracy ?? initialPos?.accuracy ?? null);
}
