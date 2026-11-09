// A confirmed Marmot commit whose group state didn't save (#1754).
//
// Once a commit is published and acknowledged, marmot-ts saves the group's
// new MLS state and reports how that went in `GroupPublishResult.persistence`.
// If the save failed, the group in memory is at the new epoch but storage
// still holds the old one: after a restart this device would load the old
// epoch, unable to read anything sent since (and, for an invite, missing the
// invitees' leaves). The commit itself is final — it must never be resent.
//
// So every publish result the session gets is checked here. A failed save is
// retried in the background while the session is live, a few times with
// backoff, via the group's own `save(true)` (the exact write marmot-ts made:
// the fork-history tree, then the serialized state). The durable "unsaved"
// mark is written as soon as the failure is seen, so a kill or account switch
// mid-retry still leaves it for the next start; the UI is only told once the
// retries are exhausted (or on that next start, if storage never caught up),
// and offers Repair. Any later successful save of the group at that epoch or
// newer (a retry, our next commit, an inbound one) clears the mark. Only
// persistence is handled here; no MLS logic changes.

import type { GroupPublishResult } from '@internet-privacy/marmot-ts';

import type { MarmotKvBackend } from './marmotStore';
import { clearMarmotUnsavedState, publishMarmotUnsavedState } from './marmotUnsavedStateStore';

/** Backoff between save retries (ms). Bounded: three tries, ~20 s in all. */
export const STATE_SAVE_RETRY_MS: readonly number[] = [1_000, 4_000, 15_000];
const NAMESPACE = 'unsavedState';
/** The KV namespace marmot-ts keeps each group's serialized state in. */
export const GROUP_STATE_NAMESPACE = 'groups';

/** The bit of a MarmotGroup this needs. */
export interface SavableGroup {
  readonly idStr: string;
  readonly state: { groupContext: { epoch: bigint } };
  save(force?: boolean): Promise<void>;
  on(event: 'stateSaved', listener: () => void): unknown;
}

export interface MarmotStateSavesDeps {
  owner: string;
  backend: Pick<MarmotKvBackend, 'get' | 'set' | 'remove' | 'keys'>;
  stopped: () => boolean;
  /** Test seam: retry backoff (default STATE_SAVE_RETRY_MS). */
  retryMs?: readonly number[];
}

const epochOf = (g: SavableGroup) => g.state.groupContext.epoch;
const short = (id: string) => id.slice(0, 8);
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export class MarmotStateSaves {
  /** MLS group id → the epoch this device holds in memory but not on disk. */
  private readonly unsaved = new Map<string, bigint>();
  private readonly retries = new Map<string, Promise<void>>();
  /** Groups with a failure newer than their running retry's latest save. */
  private readonly rerun = new Set<string>();
  /** Each retry loop's pending backoff, woken early by stop() / forget(). */
  private readonly sleeps = new Map<string, () => void>();
  /** Groups left / destroyed mid-retry: never write their state back. */
  private readonly gone = new Set<string>();
  private halted = false;

  constructor(private readonly deps: MarmotStateSavesDeps) {}

  private stopped(mlsId?: string): boolean {
    return this.halted || this.deps.stopped() || (!!mlsId && this.gone.has(mlsId));
  }

  /** Inspect one publish's results; a failed save is retried in the background. */
  check(group: SavableGroup, results: readonly Pick<GroupPublishResult, 'persistence'>[]): void {
    const failed = results.find((r) => r.persistence.kind === 'failed')?.persistence;
    if (failed?.kind !== 'failed' || this.stopped()) return;
    if (__DEV__)
      console.warn(`[PerfBlock] marmot state save failed ${short(group.idStr)}: ${failed.error}`);
    // Durable mark now, not after the retries: if the app dies (or the account
    // switches) before one lands, the next start still knows this epoch never
    // reached storage. A successful retry, or load() finding storage caught
    // up, removes it. Best effort — the same storage just failed.
    void this.persistMark(group);
    // One retry loop per group: every try writes the group's CURRENT state.
    // A failure landing while that loop's save is already in flight may be
    // for a newer state than the one being written — the loop goes again.
    if (this.retries.has(group.idStr)) return void this.rerun.add(group.idStr);
    this.gone.delete(group.idStr); // it's live again (e.g. re-joined)
    const run = this.retry(group).finally(() => {
      this.retries.delete(group.idStr);
      this.rerun.delete(group.idStr);
      this.gone.delete(group.idStr);
    });
    this.retries.set(group.idStr, run);
  }

  /** Resolves once `mlsId` has no retry in flight. */
  settled(mlsId: string): Promise<void> {
    return this.retries.get(mlsId) ?? Promise.resolve();
  }

  isUnsaved(mlsId: string): boolean {
    return this.unsaved.has(mlsId);
  }

  /** Clear the mark once the group saves at (or past) the unsaved epoch. */
  watch(group: SavableGroup): void {
    group.on('stateSaved', () => {
      const epoch = this.unsaved.get(group.idStr);
      if (epoch !== undefined && epochOf(group) >= epoch) void this.clear(group.idStr);
    });
  }

  /** On start: keep the marks whose epoch never reached storage, drop the rest. */
  async load(groups: readonly SavableGroup[]): Promise<void> {
    const byId = new Map(groups.map((g) => [g.idStr, g]));
    for (const id of await this.deps.backend.keys(NAMESPACE)) {
      const raw = await this.deps.backend.get(NAMESPACE, id);
      const group = byId.get(id);
      let epoch: bigint | null = null;
      try {
        epoch = raw === null ? null : BigInt(raw);
      } catch {
        epoch = null;
      }
      if (group && epoch !== null && epochOf(group) < epoch) this.unsaved.set(id, epoch);
      else await this.deps.backend.remove(NAMESPACE, id);
    }
    this.publish();
  }

  /** A Repair replaced this 1:1: no more sends go there, so drop its mark.
   * Any retry carries on — the old group still receives. */
  async dismiss(mlsId: string): Promise<void> {
    await this.clear(mlsId);
  }

  /** The group is gone from this device (left / removed / destroyed): drop
   * its mark and end any retry — writing its state back would resurrect a
   * group that was just deleted. */
  async forget(mlsId: string): Promise<void> {
    if (this.retries.has(mlsId)) this.gone.add(mlsId);
    this.sleeps.get(mlsId)?.();
    await this.clear(mlsId);
  }

  /** Session stopped: no more retries (pending backoffs end now) or UI marks. */
  stop(): void {
    this.halted = true;
    for (const wake of [...this.sleeps.values()]) wake();
    clearMarmotUnsavedState(this.deps.owner);
  }

  private async retry(group: SavableGroup): Promise<void> {
    for (;;) {
      const saved = await this.retryOnce(group);
      // Go again only if a failure arrived during the successful save (rare).
      if (!saved || !this.rerun.has(group.idStr) || this.stopped(group.idStr)) return;
    }
  }

  private sleep(mlsId: string, ms: number): Promise<void> {
    return new Promise((resolve) => {
      const wake = () => {
        clearTimeout(timer);
        this.sleeps.delete(mlsId);
        resolve();
      };
      const timer = setTimeout(wake, ms);
      this.sleeps.set(mlsId, wake);
    });
  }

  /** Bounded retries; true once a save landed, false if they all failed. */
  private async retryOnce(group: SavableGroup): Promise<boolean> {
    const delays = this.deps.retryMs ?? STATE_SAVE_RETRY_MS;
    for (const [i, ms] of delays.entries()) {
      await this.sleep(group.idStr, ms);
      if (this.stopped(group.idStr)) return false;
      const started = Date.now();
      // Failures reported from here on may postdate the state this writes.
      this.rerun.delete(group.idStr);
      try {
        await group.save(true);
        // Left / destroyed while this save was writing: undo the write-back.
        if (this.gone.has(group.idStr)) {
          await this.dropState(group.idStr);
          return false;
        }
        if (__DEV__)
          console.log(
            `[PerfBlock] marmot state save retry ${i + 1}/${delays.length} ok ` +
              `${short(group.idStr)} ms=${Date.now() - started}`,
          );
        // A newer failure during this save means it may have written the older
        // state: keep the durable mark until the next pass lands.
        if (!this.rerun.has(group.idStr)) await this.clear(group.idStr);
        return true;
      } catch (e) {
        if (this.gone.has(group.idStr)) {
          await this.dropState(group.idStr); // a partial write may have landed
          return false;
        }
        if (__DEV__)
          console.warn(
            `[PerfBlock] marmot state save retry ${i + 1}/${delays.length} failed ` +
              `${short(group.idStr)} ms=${Date.now() - started}: ${message(e)}`,
          );
      }
    }
    // The mark records the CURRENT epoch, so it covers any later failure too.
    if (!this.stopped(group.idStr)) await this.mark(group);
    return false;
  }

  private async mark(group: SavableGroup): Promise<void> {
    const epoch = epochOf(group);
    this.unsaved.set(group.idStr, epoch);
    this.publish();
    if (__DEV__)
      console.warn(`[PerfBlock] marmot state unsaved ${short(group.idStr)} epoch=${epoch}`);
    // Best effort: the same storage just failed, but the mark is what lets
    // the chat offer Repair after a restart (when the old epoch loads).
    await this.persistMark(group);
  }

  private persistMark(group: SavableGroup): Promise<void> {
    const epoch = epochOf(group).toString();
    return this.deps.backend.set(NAMESPACE, group.idStr, epoch).catch(() => undefined);
  }

  /** Remove a forgotten group's state row (and any mark) a save just wrote back. */
  private async dropState(mlsId: string): Promise<void> {
    if (__DEV__) console.warn(`[PerfBlock] marmot state save after leave ${short(mlsId)}: dropped`);
    await this.deps.backend.remove(GROUP_STATE_NAMESPACE, mlsId).catch(() => undefined);
    await this.clear(mlsId);
  }

  private async clear(mlsId: string): Promise<void> {
    const had = this.unsaved.delete(mlsId);
    if (had) this.publish();
    await this.deps.backend.remove(NAMESPACE, mlsId).catch(() => undefined);
  }

  private publish(): void {
    if (this.stopped()) return;
    publishMarmotUnsavedState(this.deps.owner, this.unsaved.keys());
  }
}
