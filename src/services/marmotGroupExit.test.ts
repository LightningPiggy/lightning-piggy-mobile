// #1754: only the ways out where marmot-ts wiped the group's storage (left /
// destroyed) may undo a save retry's write-back; removed / disbanded keep it.
import { GROUP_EXIT_EVENTS, type GroupExitEvent, handleGroupExits } from './marmotGroupExit';

jest.mock('./marmotDeletionStore', () => ({
  forgetMarmotDeletionsForGroup: jest.fn(async () => undefined),
}));

function setup() {
  const listeners = new Map<GroupExitEvent, (id: Uint8Array) => void>();
  const deps = {
    pubkey: 'a'.repeat(64),
    pushRegistration: { forgetGroup: jest.fn() },
    stateSaves: { forget: jest.fn(async () => undefined) },
    welcomePayloads: { drop: jest.fn(async () => undefined) },
    changed: jest.fn(),
  };
  handleGroupExits({ on: (evt, l) => listeners.set(evt, l) }, deps);
  return { deps, emit: (evt: GroupExitEvent) => listeners.get(evt)!(new Uint8Array([0xab, 0xcd])) };
}

describe('handleGroupExits', () => {
  it('listens for every way out of a group', () => {
    const { deps, emit } = setup();
    for (const evt of GROUP_EXIT_EVENTS) emit(evt);
    expect(deps.changed).toHaveBeenCalledTimes(4);
    expect(deps.pushRegistration.forgetGroup).toHaveBeenCalledWith('abcd');
    expect(deps.welcomePayloads.drop).toHaveBeenCalledWith('abcd', { outbox: true });
  });

  it.each([
    ['left', true],
    ['destroyed', true],
    ['removed', false],
    ['disbanded', false],
  ] as const)('%s → forget with wiped=%s', (evt, wiped) => {
    const { deps, emit } = setup();
    emit(evt);
    expect(deps.stateSaves.forget).toHaveBeenCalledWith('abcd', { wiped });
  });
});
