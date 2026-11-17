import React, { useEffect, useMemo } from 'react';
import {
  Canvas,
  Group,
  Path,
  Fill,
  BlurMask,
  Skia,
  Shader,
  interpolateColors,
  vec,
  type SkPath,
} from '@shopify/react-native-skia';
import {
  useSharedValue,
  useDerivedValue,
  useFrameCallback,
  type SharedValue,
} from 'react-native-reanimated';
import { generateBolt, boltToSvgPath, type Point } from '../utils/lightningBolt';
import { LIGHTNING_AMBIENT_SKSL } from './lightning.sksl';
import { createLightningOverlayStyles } from '../styles/LightningOverlay.styles';

// Endpoint colours for the purple→green tint. Frozen module-scope literals so
// the Skia worklets capture stable strings (same pattern as the bubbles'
// interpolateColor in PaymentProgressOverlay). PURPLE = in-flight,
// GREEN = success, RED = failure — matched to the brand palette so the two
// animation options transition identically.
const PURPLE = '#9B40FF';
const GREEN = '#4CAF50';
const RED = '#F44336';
// Near-white-blue core so the bolt's centre reads as a hot electric arc on top
// of the coloured halo.
const CORE = '#EAF2FF';

// How many bolt slots flash at once. Lightning is meant to be INTENSE —
// continuous, overlapping strikes — so several slots are mid-flash at any
// instant, reading as a relentless storm rather than the occasional strike.
const POOL_SIZE = 16;
// How many distinct pre-generated bolt geometries the slots cycle through. More
// variants = less obvious repetition. Generated once on mount; the animation
// then indexes into them purely from the clock (no per-frame geometry work).
const PATH_VARIANTS = 30;
// Full strike→fade cycle per slot (ms). Slots are phase-staggered across this
// window so a fresh bolt lands roughly every CYCLE_MS / POOL_SIZE ms — dense
// and continuous.
const CYCLE_MS = 540;

interface Props {
  // Same colour driver the bubbles use: 0 = in-flight (purple), 1 = success
  // (green), -1 = failure (red). Passed straight from
  // PaymentProgressOverlay's `colorProgress`.
  progress: SharedValue<number>;
  width: number;
  height: number;
}

const ambientEffect = Skia.RuntimeEffect.Make(LIGHTNING_AMBIENT_SKSL);

// Build one fresh bolt path on the JS thread: a roughly top→bottom strike whose
// endpoints wander across the width so consecutive bolts hit different parts of
// the screen. Geometry comes from the pure, unit-tested generator. Called only
// at mount to fill the variant pool — never per frame.
function makeBoltPath(width: number, height: number): SkPath {
  const start: Point = { x: width * (0.12 + Math.random() * 0.76), y: -20 };
  const end: Point = { x: width * (0.08 + Math.random() * 0.84), y: height + 20 };
  const branches = generateBolt(start, end, Math.random, {
    detail: 6,
    displacement: 0.16 + Math.random() * 0.12,
    forkProbability: 0.38,
  });
  // Merge trunk + forks into one SkPath so a single stroke pass draws the
  // whole tree — cheaper than one Path node per branch.
  const combined = Skia.PathBuilder.Make();
  branches.forEach((b) => {
    const sub = Skia.Path.MakeFromSVGString(boltToSvgPath(b.points));
    if (sub) combined.addPath(sub);
  });
  return combined.detach();
}

interface BoltLayerProps {
  index: number;
  paths: SharedValue<SkPath[]>;
  clock: SharedValue<number>;
  // Skia's interpolateColors yields an RGBA float array (its Color form).
  haloColor: SharedValue<number[]>;
}

// One bolt slot. EVERYTHING here runs on the UI thread off the shared `clock`,
// so the field keeps firing even while the JS thread is busy (e.g. handling the
// payment-success response) — that JS stall is what used to make the storm
// "stop then start". Each slot marches through the pre-generated variants on a
// phase-staggered cycle, flashing bright then fading.
function BoltLayer({ index, paths, clock, haloColor }: BoltLayerProps) {
  // Per-slot phase offset spreads the 16 slots evenly across one cycle so a new
  // strike lands every ~CYCLE_MS / POOL_SIZE ms.
  const phaseOffset = (index * CYCLE_MS) / POOL_SIZE;

  const cycle = useDerivedValue(() => Math.floor((clock.value + phaseOffset) / CYCLE_MS));

  const path = useDerivedValue(() => {
    const pool = paths.value;
    if (pool.length === 0) return Skia.Path.Make();
    // Step through the variants per cycle (stride 7, coprime-ish with 30) so the
    // same slot shows a different bolt each time it fires.
    const i = (((index * 7 + cycle.value) % pool.length) + pool.length) % pool.length;
    return pool[i] ?? Skia.Path.Make();
  });

  const opacity = useDerivedValue(() => {
    // Position within this slot's current cycle, 0→1.
    const t = ((clock.value + phaseOffset) % CYCLE_MS) / CYCLE_MS;
    // Fast attack (0→peak over the first 10%) then a gentle afterglow so the
    // bolt stays visible across most of the cycle — keeps many strikes lit at
    // once for a dense, continuous field.
    const attack = Math.min(t / 0.1, 1);
    const decay = Math.exp(-2.2 * Math.max(t - 0.1, 0));
    // Per-(slot, cycle) brightness jitter so the field doesn't pulse in
    // lockstep. Deterministic hash → stable on the UI thread.
    const peak = 0.72 + 0.28 * Math.abs(Math.sin(index * 1.7 + cycle.value * 2.3));
    return peak * attack * decay;
  });

  const haloOpacity = useDerivedValue(() => opacity.value * 0.6);

  // Opacity is applied per-Path, not on the Group: a Group opacity would
  // multiply with each child's own opacity (halo would become opacity^2 * 0.6),
  // dimming the glow and distorting the strike/afterglow curve. Core rides the
  // raw curve; halo rides the 0.6-scaled curve. (#867)
  return (
    <Group>
      <Path
        path={path}
        style="stroke"
        strokeWidth={22}
        strokeCap="round"
        strokeJoin="round"
        color={haloColor}
        opacity={haloOpacity}
      >
        <BlurMask blur={18} style="solid" />
      </Path>
      <Path
        path={path}
        style="stroke"
        strokeWidth={5.5}
        strokeCap="round"
        strokeJoin="round"
        color={CORE}
        opacity={opacity}
      />
    </Group>
  );
}

// Procedural, continuously-firing lightning rendered on a Skia canvas. Drawn
// behind the overlay card; never intercepts touches (pointerEvents none on the
// canvas). All animation is UI-thread: the frame callback advances a clock and
// every slot derives its geometry + opacity from it, so nothing stalls when the
// JS thread is busy. Geometry is generated once into a variant pool.
export default function LightningOverlay({ progress, width, height }: Props) {
  const styles = useMemo(() => createLightningOverlayStyles(), []);

  // Monotonic clock in ms, advanced on the UI thread every frame.
  const clock = useSharedValue(0);
  // The pre-generated bolt geometries the slots cycle through.
  const paths = useSharedValue<SkPath[]>([]);

  // Colour the bolts the same way the bubbles colour-morph: red at -1,
  // purple in-flight at 0, green at success 1. Skia's interpolateColors is the
  // direct analogue of Reanimated's interpolateColor used by the bubbles, so a
  // success flips `progress` 0→1 and the whole field fades purple→green.
  const haloColor = useDerivedValue(() =>
    interpolateColors(progress.value, [-1, 0, 1], [RED, PURPLE, GREEN]),
  );

  // Ambient haze uniforms — tinted by the same progress so the wash morphs in
  // lockstep with the bolts.
  const ambientUniforms = useDerivedValue(() => {
    const c = Skia.Color(interpolateColors(progress.value, [-1, 0, 1], [RED, PURPLE, GREEN]));
    return {
      u_resolution: vec(width, height),
      u_time: clock.value / 1000,
      u_color: [c[0], c[1], c[2], 1],
      u_intensity: 0.9,
    };
  });

  useFrameCallback((frame) => {
    'worklet';
    clock.value = frame.timeSinceFirstFrame;
  });

  // Generate the variant pool once per size. Pure JS at mount — the playback
  // loop never touches the JS thread, so it can't be stalled mid-storm.
  useEffect(() => {
    const pool: SkPath[] = [];
    for (let i = 0; i < PATH_VARIANTS; i++) {
      pool.push(makeBoltPath(width, height));
    }
    paths.value = pool;
  }, [width, height, paths]);

  return (
    <Canvas style={styles.canvas} pointerEvents="none">
      {ambientEffect ? (
        <Fill>
          <Shader source={ambientEffect} uniforms={ambientUniforms} />
        </Fill>
      ) : null}
      {Array.from({ length: POOL_SIZE }).map((_, i) => (
        <BoltLayer key={i} index={i} paths={paths} clock={clock} haloColor={haloColor} />
      ))}
    </Canvas>
  );
}
