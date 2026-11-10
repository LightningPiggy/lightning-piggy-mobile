// The home-screen widget's snapshot writer (#1849), as plain testable logic:
// debounce, skip unchanged snapshots, wipe on account change and drop any write
// that was being prepared when the wipe happened. `useWidgetSnapshotSync` just
// feeds it React state; the storage and redraw functions are injected.
import type { WalletState } from '../types/wallet';
import { buildWidgetSnapshot, snapshotFingerprint, type WidgetSnapshot } from './widgetSnapshot';

/** Trailing debounce: a burst of balance / price / connection updates becomes
 *  one write. Never per relay event, never on the tap path. */
export const WRITE_DEBOUNCE_MS = 1500;
/** A fetch that only moves "Updated 14:32" rewrites at most this often. */
export const REFETCH_REWRITE_MS = 5 * 60_000;

export interface WriterInput {
  wallets: readonly WalletState[];
  hydrated: boolean;
  locale: string;
  btcPrice: number | null;
  currency: string;
}

export interface WriterDeps {
  read: () => Promise<WidgetSnapshot | null>;
  write: (snapshot: WidgetSnapshot) => Promise<void>;
  wipe: () => Promise<void>;
  /** Redraw placed widgets (null = nothing to show). */
  refresh: (snapshot: WidgetSnapshot | null) => Promise<void>;
  fetchedAt: (walletId: string) => number | null;
  debounceMs?: number;
}

interface Written {
  snapshot: WidgetSnapshot | null;
  fingerprint: string;
}
const EMPTY = 'empty';

/**
 * Write when anything the widget shows changed, or when a wallet's balance was
 * re-fetched at least `REFETCH_REWRITE_MS` after the written fetch time (so
 * "Updated 14:32" keeps up without a write per 30-second poll).
 */
export function shouldWriteSnapshot(last: Written | null, next: WidgetSnapshot): boolean {
  if (!last || last.fingerprint !== snapshotFingerprint(next)) return true;
  return next.wallets.some((w) => {
    if (w.updatedAt === null) return false;
    const before = last.snapshot?.wallets.find((p) => p.id === w.id)?.updatedAt ?? null;
    return before === null || w.updatedAt - before >= REFETCH_REWRITE_MS;
  });
}

export function createWidgetSnapshotWriter(deps: WriterDeps) {
  const debounceMs = deps.debounceMs ?? WRITE_DEBOUNCE_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let input: WriterInput | null = null;
  // undefined until seeded from storage on the first run.
  let last: Written | undefined;
  // Bumped by a wipe, so a write already being prepared is dropped.
  let generation = 0;

  const cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  async function run(): Promise<void> {
    const current = input;
    if (!current?.hydrated) return;
    const gen = generation;
    if (last === undefined) {
      const stored = await deps.read();
      if (gen !== generation) return;
      if (last === undefined) {
        last = { snapshot: stored, fingerprint: stored ? snapshotFingerprint(stored) : EMPTY };
      }
    }
    if (current.wallets.length === 0) {
      if (last.fingerprint === EMPTY) return;
      last = { snapshot: null, fingerprint: EMPTY };
      await deps.wipe();
      if (gen === generation) await deps.refresh(null);
      return;
    }
    const snapshot = buildWidgetSnapshot(current.wallets, current.locale, {
      btcPrice: current.btcPrice,
      currency: current.currency,
      previous: last.snapshot,
      fetchedAt: deps.fetchedAt,
    });
    if (!shouldWriteSnapshot(last, snapshot)) return;
    last = { snapshot, fingerprint: snapshotFingerprint(snapshot) };
    // Same tick as the generation check above: a wipe can't slip in between,
    // and a wipe issued after this is queued behind the write (widgetSnapshot).
    await deps.write(snapshot);
    if (gen === generation) await deps.refresh(snapshot);
  }

  function schedule(): void {
    cancel();
    timer = setTimeout(() => {
      timer = null;
      run().catch((e: unknown) => {
        if (__DEV__) console.warn('[widget] snapshot write failed:', e);
      });
    }, debounceMs);
  }

  return {
    /** New wallet / price / currency / language state. */
    update(next: WriterInput): void {
      input = next;
      schedule();
    },
    /** A balance was fetched: maybe "Updated …" moved. */
    nudge(): void {
      if (input) schedule();
    },
    /** Sign-out / account switch: wipe now, drop pending and in-flight writes. */
    accountChanged(wiped: Promise<void>): Promise<void> {
      generation += 1;
      cancel();
      last = { snapshot: null, fingerprint: EMPTY };
      return wiped.then(() => deps.refresh(null));
    },
    dispose: cancel,
    /** Test hook: run a pending write now. */
    flush: run,
  };
}

export type WidgetSnapshotWriter = ReturnType<typeof createWidgetSnapshotWriter>;
