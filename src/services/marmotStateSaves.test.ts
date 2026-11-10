// #1754: a confirmed commit whose group-state save failed is retried, and
// marked for Repair (in storage and in the UI snapshot) if it keeps failing.
import {
  GROUP_HISTORY_TREE_NAMESPACE as TREE,
  GROUP_STATE_NAMESPACE,
  MarmotStateSaves,
  type SavableGroup,
} from './marmotStateSaves';
import { createMemoryMarmotBackend } from './marmotStore';
import { clearMarmotUnsavedState, getMarmotUnsavedStateSnapshot } from './marmotUnsavedStateStore';

const OWNER = 'a'.repeat(64);
const ID = 'b'.repeat(64);
const RETRY_MS = [1, 1, 1];
const FAILED = { persistence: { kind: 'failed' as const, error: 'disk full' } };
const SUCCEEDED = { persistence: { kind: 'succeeded' as const } };
const NOT_REQUIRED = { persistence: { kind: 'notRequired' as const } };

/** A group whose save fails `failures` times, then succeeds (and emits
 * `stateSaved`, as marmot-ts does after a successful write). */
function fakeGroup(failures: number, epoch = 2n, id = ID) {
  const listeners: (() => void)[] = [];
  const group = {
    idStr: id,
    state: { groupContext: { epoch } },
    save: jest.fn(async (_force?: boolean) => {
      if (failures-- > 0) throw new Error('disk full');
      listeners.forEach((l) => l());
    }),
    on: (_evt: 'stateSaved', l: () => void) => listeners.push(l),
    emitSaved: () => listeners.forEach((l) => l()),
  };
  return group satisfies SavableGroup;
}

function makeSaves(backend = createMemoryMarmotBackend(), stopped = () => false) {
  return {
    backend,
    saves: new MarmotStateSaves({ owner: OWNER, backend, stopped, retryMs: RETRY_MS }),
  };
}

/** A save that stays in flight until released; then writes the group's
 * state row and fork-history tree rows, as marmot-ts's save(true) does. */
function slowSave(backend: ReturnType<typeof createMemoryMarmotBackend>, id = ID) {
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const run = async () => {
    await gate;
    await backend.set(TREE, `${id}/meta`, 'root');
    await backend.set(TREE, `${id}/edge/t1`, 'edge');
    await backend.set(GROUP_STATE_NAMESPACE, id, 'state');
  };
  return { run, release };
}

/** marmot-ts's group.destroy(): wipes the state row and the history tree. */
async function wipeGroup(backend: ReturnType<typeof createMemoryMarmotBackend>, id = ID) {
  await backend.remove(GROUP_STATE_NAMESPACE, id);
  for (const k of await backend.keys(TREE))
    if (k.startsWith(`${id}/`)) await backend.remove(TREE, k);
}

const tick = () => new Promise((r) => setTimeout(r, 5));

const uiFlag = (id = ID) =>
  getMarmotUnsavedStateSnapshot().owner === OWNER &&
  getMarmotUnsavedStateSnapshot().chatIds.has(id);

describe('MarmotStateSaves (#1754)', () => {
  beforeEach(() => {
    clearMarmotUnsavedState(OWNER);
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => jest.restoreAllMocks());

  it('does nothing when the save succeeded or was not required', async () => {
    const { saves, backend } = makeSaves();
    const group = fakeGroup(0);
    saves.watch(group);
    saves.check(group, [SUCCEEDED, NOT_REQUIRED]);
    await saves.settled(ID);
    expect(group.save).not.toHaveBeenCalled();
    expect(saves.isUnsaved(ID)).toBe(false);
    expect(uiFlag()).toBe(false);
    expect(await backend.keys('unsavedState')).toEqual([]);
  });

  it('retries a failed save and stops once it succeeds, marking nothing', async () => {
    const { saves, backend } = makeSaves();
    const group = fakeGroup(1); // the first retry fails too, the second lands
    saves.watch(group);
    saves.check(group, [FAILED]);
    await saves.settled(ID);
    expect(group.save).toHaveBeenCalledTimes(2);
    expect(group.save).toHaveBeenLastCalledWith(true); // forced: the current state
    expect(saves.isUnsaved(ID)).toBe(false);
    expect(uiFlag()).toBe(false);
    expect(await backend.keys('unsavedState')).toEqual([]);
  });

  it('marks the group for Repair (storage + UI) when every retry fails', async () => {
    const { saves, backend } = makeSaves();
    const group = fakeGroup(Infinity, 7n);
    saves.watch(group);
    saves.check(group, [FAILED]);
    await saves.settled(ID);
    expect(group.save).toHaveBeenCalledTimes(RETRY_MS.length); // bounded
    expect(saves.isUnsaved(ID)).toBe(true);
    expect(uiFlag()).toBe(true);
    expect(await backend.get('unsavedState', ID)).toBe('7');
  });

  it('runs one retry loop per group, however many failures arrive meanwhile', async () => {
    const { saves } = makeSaves();
    const group = fakeGroup(0);
    saves.check(group, [FAILED]);
    saves.check(group, [FAILED]);
    await saves.settled(ID);
    expect(group.save).toHaveBeenCalledTimes(1);
  });

  it('clears the mark when the group later saves at that epoch or newer', async () => {
    const { saves, backend } = makeSaves();
    const group = fakeGroup(Infinity, 3n);
    saves.watch(group);
    saves.check(group, [FAILED]);
    await saves.settled(ID);
    expect(uiFlag()).toBe(true);

    group.emitSaved(); // e.g. our next commit, or an inbound one, saved fine
    await new Promise((r) => setTimeout(r, 0));
    expect(saves.isUnsaved(ID)).toBe(false);
    expect(uiFlag()).toBe(false);
    expect(await backend.keys('unsavedState')).toEqual([]);
  });

  it('keeps the mark when only an older epoch saves', async () => {
    const { saves } = makeSaves();
    const group = fakeGroup(Infinity, 5n);
    saves.watch(group);
    saves.check(group, [FAILED]);
    await saves.settled(ID);
    group.state.groupContext.epoch = 4n;
    group.emitSaved();
    expect(saves.isUnsaved(ID)).toBe(true);
  });

  it('after a restart, keeps a mark whose epoch never reached storage and drops one that did', async () => {
    const backend = createMemoryMarmotBackend();
    const other = 'c'.repeat(64);
    await backend.set('unsavedState', ID, '5');
    await backend.set('unsavedState', other, '5');
    await backend.set('unsavedState', 'd'.repeat(64), '5'); // group no longer here
    const { saves } = makeSaves(backend);
    await saves.load([fakeGroup(0, 4n, ID), fakeGroup(0, 5n, other)]);
    expect(saves.isUnsaved(ID)).toBe(true);
    expect(saves.isUnsaved(other)).toBe(false);
    expect(uiFlag(ID)).toBe(true);
    expect(await backend.keys('unsavedState')).toEqual([ID]);
  });

  it('keeps loading marks when dropping an obsolete one fails', async () => {
    const backend = createMemoryMarmotBackend();
    const stale = 'c'.repeat(64);
    await backend.set('unsavedState', stale, '5'); // group no longer here
    await backend.set('unsavedState', ID, '5');
    const failing = { ...backend, remove: jest.fn(async () => Promise.reject(new Error('io'))) };
    const saves = new MarmotStateSaves({ owner: OWNER, backend: failing, stopped: () => false });
    await saves.load([fakeGroup(0, 4n, ID)]);
    expect(saves.isUnsaved(ID)).toBe(true);
    expect(uiFlag(ID)).toBe(true);
  });

  it('stops retrying once the session stops, and clears its UI snapshot', async () => {
    let stopped = false;
    const { saves } = makeSaves(undefined, () => stopped);
    const group = fakeGroup(Infinity);
    saves.check(group, [FAILED]);
    stopped = true;
    await saves.settled(ID);
    expect(group.save).not.toHaveBeenCalled();
    expect(saves.isUnsaved(ID)).toBe(false);
    saves.stop();
    expect(getMarmotUnsavedStateSnapshot().owner).toBeNull();
  });

  it('goes again when a newer failure arrives while its successful save is in flight', async () => {
    const { saves } = makeSaves();
    const group = fakeGroup(0, 2n);
    saves.watch(group);
    // The retry's save writes epoch 2; meanwhile a commit to epoch 3 lands
    // and its own save fails — this loop's success must not swallow that.
    group.save.mockImplementationOnce(async () => {
      group.state.groupContext.epoch = 3n;
      saves.check(group, [FAILED]);
    });
    saves.check(group, [FAILED]);
    await saves.settled(ID);
    expect(group.save).toHaveBeenCalledTimes(2);
    expect(saves.isUnsaved(ID)).toBe(false);
  });

  it('marks the newest epoch when a failure arrives during a failing retry', async () => {
    const { saves, backend } = makeSaves();
    const group = fakeGroup(Infinity, 2n);
    group.save.mockImplementationOnce(async () => {
      group.state.groupContext.epoch = 3n;
      saves.check(group, [FAILED]);
      throw new Error('disk full');
    });
    saves.check(group, [FAILED]);
    await saves.settled(ID);
    expect(group.save).toHaveBeenCalledTimes(RETRY_MS.length);
    expect(await backend.get('unsavedState', ID)).toBe('3');
  });

  it('stop() ends a pending backoff at once, without saving', async () => {
    const backend = createMemoryMarmotBackend();
    const saves = new MarmotStateSaves({
      owner: OWNER,
      backend,
      stopped: () => false,
      retryMs: [60_000],
    });
    const group = fakeGroup(0);
    saves.check(group, [FAILED]);
    saves.stop();
    await saves.settled(ID); // would hang for a minute if the sleep weren't cancelled
    expect(group.save).not.toHaveBeenCalled();
    saves.check(group, [FAILED]); // and a stopped guard starts nothing new
    await saves.settled(ID);
    expect(group.save).not.toHaveBeenCalled();
  });

  it('never writes back the state of a group left while its retry waits', async () => {
    const backend = createMemoryMarmotBackend();
    const saves = new MarmotStateSaves({
      owner: OWNER,
      backend,
      stopped: () => false,
      retryMs: [60_000, 60_000],
    });
    const group = fakeGroup(Infinity);
    saves.check(group, [FAILED]);
    await saves.forget(ID, { wiped: true }); // left: marmot-ts just deleted its state
    await saves.settled(ID); // the backoff ended at once
    expect(group.save).not.toHaveBeenCalled();
    expect(saves.isUnsaved(ID)).toBe(false);
    expect(await backend.keys('unsavedState')).toEqual([]);
  });

  it('keeps the mark for the next start when the app stops before a retry lands', async () => {
    const backend = createMemoryMarmotBackend();
    const saves = new MarmotStateSaves({
      owner: OWNER,
      backend,
      stopped: () => false,
      retryMs: [60_000, 60_000],
    });
    const group = fakeGroup(Infinity, 6n);
    saves.watch(group);
    saves.check(group, [FAILED]);
    expect(uiFlag()).toBe(false); // the UI waits for the retries
    saves.stop(); // killed / account switched mid-backoff
    await saves.settled(ID);
    expect(group.save).not.toHaveBeenCalled();

    // Next start: storage still holds the old epoch.
    const next = makeSaves(backend).saves;
    await next.load([fakeGroup(0, 5n, ID)]);
    expect(next.isUnsaved(ID)).toBe(true);
    expect(uiFlag()).toBe(true);
  });

  it('leaves no mark once a retry lands', async () => {
    const { saves, backend } = makeSaves();
    const group = fakeGroup(0, 6n);
    saves.check(group, [FAILED]);
    expect(await backend.get('unsavedState', ID)).toBe('6'); // written up front
    await saves.settled(ID);
    expect(await backend.keys('unsavedState')).toEqual([]);
  });

  it('keeps the mark when it stops after a save that may predate a newer failure', async () => {
    let stopped = false;
    const { saves, backend } = makeSaves(undefined, () => stopped);
    const group = fakeGroup(0, 2n);
    group.save.mockImplementationOnce(async () => {
      group.state.groupContext.epoch = 3n;
      saves.check(group, [FAILED]); // epoch 3's own save failed mid-retry
      stopped = true; // ...and the app dies before the next pass
    });
    saves.check(group, [FAILED]);
    await saves.settled(ID);
    expect(await backend.get('unsavedState', ID)).toBe('3');
  });

  it('a save during a retry does not clear the mark of a newer failure', async () => {
    const backend = createMemoryMarmotBackend();
    await backend.set('unsavedState', ID, '2'); // restored from the last run
    let stopped = false;
    const { saves } = makeSaves(backend, () => stopped);
    const group = fakeGroup(0, 1n);
    saves.watch(group);
    await saves.load([group]);
    expect(saves.isUnsaved(ID)).toBe(true);
    group.state.groupContext.epoch = 2n;
    group.save.mockImplementationOnce(async () => {
      // While the retry writes epoch 2, a commit to epoch 3 fails to save...
      group.state.groupContext.epoch = 3n;
      saves.check(group, [FAILED]);
      group.emitSaved(); // ...then the epoch-2 write completes
      stopped = true; // and the app dies before the next pass
    });
    saves.check(group, [FAILED]);
    await saves.settled(ID);
    expect(await backend.get('unsavedState', ID)).toBe('3');
  });

  it('marks a failure reported after the session stopped, without retrying', async () => {
    const { saves, backend } = makeSaves();
    const group = fakeGroup(0, 4n);
    saves.stop(); // account switched while this commit was publishing
    saves.check(group, [FAILED]);
    await saves.settled(ID);
    expect(await backend.get('unsavedState', ID)).toBe('4');
    expect(group.save).not.toHaveBeenCalled();
    expect(getMarmotUnsavedStateSnapshot().owner).toBeNull();
  });

  it('a retry save landing after leave wiped the group does not bring it back', async () => {
    const { saves, backend } = makeSaves();
    const group = fakeGroup(0);
    const save = slowSave(backend);
    group.save.mockImplementationOnce(save.run);
    saves.check(group, [FAILED]);
    await tick(); // the retry's save is in flight
    const leaving = saves.whileRemoving(ID, async () => {
      await wipeGroup(backend); // group.destroy()
      await saves.settled(ID); // any late retry write lands here
      await saves.forget(ID, { wiped: true }); // then marmot-ts emits `left`
    });
    save.release();
    await leaving;
    expect(await backend.keys(GROUP_STATE_NAMESPACE)).toEqual([]);
    expect(await backend.keys(TREE)).toEqual([]);
    expect(await backend.keys('unsavedState')).toEqual([]);
  });

  it.each(['removed', 'disbanded'])(
    'keeps the state and history rows when the group is %s mid-save',
    async () => {
      const { saves, backend } = makeSaves();
      const group = fakeGroup(0);
      const save = slowSave(backend);
      group.save.mockImplementationOnce(save.run);
      saves.check(group, [FAILED]);
      await tick(); // the retry's save is in flight
      // marmot-ts keeps the group stored (removed marker / tombstone only)
      await saves.forget(ID, { wiped: false });
      save.release();
      await saves.settled(ID);
      expect(await backend.keys(GROUP_STATE_NAMESPACE)).toEqual([ID]);
      expect((await backend.keys(TREE)).sort()).toEqual([`${ID}/edge/t1`, `${ID}/meta`]);
      expect(await backend.keys('unsavedState')).toEqual([]);
      expect(group.save).toHaveBeenCalledTimes(1); // and the retry ended
    },
  );

  it.each(['left', 'destroyed'])(
    'removes the state and history rows a retry wrote back after the group was %s',
    async () => {
      const { saves, backend } = makeSaves();
      await backend.set(TREE, 'c'.repeat(64) + '/meta', 'other'); // another group's tree
      const group = fakeGroup(0);
      const save = slowSave(backend);
      group.save.mockImplementationOnce(save.run);
      saves.check(group, [FAILED]);
      await tick(); // the retry's save is in flight
      await wipeGroup(backend); // group.destroy()...
      await saves.forget(ID, { wiped: true }); // ...then `left` / `destroyed`
      save.release(); // the save's writes land afterwards
      await saves.settled(ID);
      expect(await backend.keys(GROUP_STATE_NAMESPACE)).toEqual([]);
      expect(await backend.keys(TREE)).toEqual(['c'.repeat(64) + '/meta']);
      expect(await backend.keys('unsavedState')).toEqual([]);
    },
  );

  it('a leave during a failing in-flight save returns without waiting out a backoff', async () => {
    const backend = createMemoryMarmotBackend();
    const saves = new MarmotStateSaves({
      owner: OWNER,
      backend,
      stopped: () => false,
      retryMs: [1, 60_000, 60_000],
    });
    const group = fakeGroup(Infinity);
    let fail!: () => void;
    group.save.mockImplementationOnce(
      () => new Promise<void>((_, reject) => (fail = () => reject(new Error('disk full')))),
    );
    saves.check(group, [FAILED]);
    await tick(); // the retry's save is in flight
    const leaving = saves.whileRemoving(ID, async () => 'left');
    fail(); // the save fails: the loop must not start a 60 s backoff first
    const t0 = Date.now();
    await expect(leaving).resolves.toBe('left');
    expect(Date.now() - t0).toBeLessThan(1_000);
  });

  it('keeps the retry held until the last of two overlapping removals ends', async () => {
    const { saves } = makeSaves();
    const group = fakeGroup(0);
    saves.check(group, [FAILED]);
    let finishSecond!: () => void;
    const second = saves.whileRemoving(
      ID,
      () => new Promise<void>((resolve) => (finishSecond = resolve)),
    );
    const first = saves.whileRemoving(ID, async () => {
      throw new Error('no relay acknowledged');
    });
    await expect(first).rejects.toThrow();
    await tick();
    expect(group.save).not.toHaveBeenCalled(); // still held by the second
    finishSecond(); // the second removal succeeded: the group is gone
    await second;
    await saves.settled(ID);
    expect(group.save).not.toHaveBeenCalled(); // never re-armed
  });

  it('re-arms the retry when the leave fails', async () => {
    const { saves } = makeSaves();
    const group = fakeGroup(0);
    saves.check(group, [FAILED]);
    await expect(
      saves.whileRemoving(ID, async () => {
        await tick();
        expect(group.save).not.toHaveBeenCalled(); // held while leaving
        throw new Error('no relay acknowledged');
      }),
    ).rejects.toThrow('no relay acknowledged');
    await saves.settled(ID);
    expect(group.save).toHaveBeenCalledTimes(1); // the retry ran after all
  });

  it('a Repair only drops the mark (the replaced 1:1 still receives)', async () => {
    const { saves } = makeSaves();
    const group = fakeGroup(Infinity);
    saves.check(group, [FAILED]);
    await saves.settled(ID);
    expect(uiFlag()).toBe(true);
    await saves.dismiss(ID);
    expect(uiFlag()).toBe(false);
  });

  it('forgets a group that left the device', async () => {
    const { saves, backend } = makeSaves();
    const group = fakeGroup(Infinity);
    saves.check(group, [FAILED]);
    await saves.settled(ID);
    await saves.forget(ID, { wiped: true });
    expect(uiFlag()).toBe(false);
    expect(await backend.keys('unsavedState')).toEqual([]);
  });
});
