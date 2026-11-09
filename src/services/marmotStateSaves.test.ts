// #1754: a confirmed commit whose group-state save failed is retried, and
// marked for Repair (in storage and in the UI snapshot) if it keeps failing.
import { GROUP_STATE_NAMESPACE, MarmotStateSaves, type SavableGroup } from './marmotStateSaves';
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
    await saves.forget(ID); // left: marmot-ts just deleted its state
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

  it('removes the state a retry wrote back for a group left during that save', async () => {
    const { saves, backend } = makeSaves();
    const group = fakeGroup(0);
    group.save.mockImplementationOnce(async () => {
      // marmot-ts deletes the state row and emits `left` while this save
      // awaits the history flush; then the save writes the state row.
      await saves.forget(ID);
      await backend.set(GROUP_STATE_NAMESPACE, ID, 'state');
    });
    saves.check(group, [FAILED]);
    await saves.settled(ID);
    expect(await backend.keys(GROUP_STATE_NAMESPACE)).toEqual([]);
    expect(await backend.keys('unsavedState')).toEqual([]);
    expect(group.save).toHaveBeenCalledTimes(1);
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
    await saves.forget(ID);
    expect(uiFlag()).toBe(false);
    expect(await backend.keys('unsavedState')).toEqual([]);
  });
});
