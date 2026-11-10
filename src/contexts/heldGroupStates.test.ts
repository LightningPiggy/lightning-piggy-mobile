import { renderHook, waitFor } from '@testing-library/react-native';
import {
  createHeldGroupStates,
  useGroupCreatorGate,
  type GroupStateInput,
} from './heldGroupStates';

let mockReplied = new Set<string>();
let finishRepliedLoad: () => void = () => {};
jest.mock('../services/dmRepliedPartners', () => ({
  hasRepliedTo: (_owner: string, pk: string) => mockReplied.has(pk),
  loadRepliedPartners: () => new Promise<void>((resolve) => (finishRepliedLoad = resolve)),
}));

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const FRIEND = 'c'.repeat(64);
const STRANGER = 'd'.repeat(64);

const state = (senderPubkey: string, groupId: string, createdAt = 1): GroupStateInput => ({
  senderPubkey,
  groupId,
  name: groupId,
  memberPubkeys: [senderPubkey],
  createdAt,
});
const everyone = () => true;

describe('createHeldGroupStates', () => {
  it('keeps the newest event per creator and group', () => {
    const held = createHeldGroupStates();
    held.hold(state(FRIEND, 'room', 2));
    held.hold(state(FRIEND, 'room', 1)); // older: ignored
    held.hold(state(FRIEND, 'room', 3));
    expect(held.release(everyone)).toEqual([state(FRIEND, 'room', 3)]);
  });

  it("a stranger reusing a friend's d-tag cannot replace the friend's event", () => {
    const held = createHeldGroupStates();
    held.hold(state(FRIEND, 'room', 1));
    held.hold(state(STRANGER, 'room', 9));
    expect(held.release((pk) => pk === FRIEND)).toEqual([state(FRIEND, 'room', 1)]);
  });

  it('caps one creator, so a flood of d-tags cannot evict anyone else', () => {
    const held = createHeldGroupStates(50, 5);
    held.hold(state(FRIEND, 'friend-room'));
    for (let i = 0; i < 40; i++) held.hold(state(STRANGER, `spam-${i}`));
    expect(held.size).toBe(6);
    expect(held.release((pk) => pk === FRIEND)).toEqual([state(FRIEND, 'friend-room')]);
  });

  it('caps the total, evicting the oldest', () => {
    const held = createHeldGroupStates(3, 5);
    for (const id of ['1', '2', '3', '4']) held.hold(state(`${id}`.repeat(64), id));
    expect(held.size).toBe(3);
    expect(held.release(everyone).map((s) => s.groupId)).toEqual(['2', '3', '4']);
  });

  it('release removes only what is admitted', () => {
    const held = createHeldGroupStates();
    held.hold(state(FRIEND, 'x'));
    held.hold(state(STRANGER, 'y'));
    held.release((pk) => pk === FRIEND);
    expect(held.size).toBe(1);
  });
});

describe('useGroupCreatorGate', () => {
  beforeEach(() => {
    mockReplied = new Set();
  });

  it('clears held events on account switch', () => {
    const { result, rerender } = renderHook(
      ({ viewer }: { viewer: string }) => useGroupCreatorGate(viewer, [], 'friends'),
      { initialProps: { viewer: A } },
    );
    result.current.held.hold(state(FRIEND, 'room'));
    expect(result.current.held.size).toBe(1);
    rerender({ viewer: B });
    expect(result.current.held.size).toBe(0);
  });

  it('admits the viewer, follows and tier all, not strangers', () => {
    const contacts = [{ pubkey: FRIEND }];
    const friends = renderHook(() => useGroupCreatorGate(A, contacts, 'friends')).result.current;
    expect([A, FRIEND, STRANGER].map(friends.admits)).toEqual([true, true, false]);
    expect(
      renderHook(() => useGroupCreatorGate(A, [], 'fof')).result.current.admits(STRANGER),
    ).toBe(false);
    expect(
      renderHook(() => useGroupCreatorGate(A, [], 'all')).result.current.admits(STRANGER),
    ).toBe(true);
  });

  it('re-evaluates once the replied-to list loads', async () => {
    const { result } = renderHook(() => useGroupCreatorGate(A, [], 'friends'));
    const before = result.current.admits;
    expect(before(STRANGER)).toBe(false);
    mockReplied.add(STRANGER);
    finishRepliedLoad();
    await waitFor(() => expect(result.current.admits).not.toBe(before));
    expect(result.current.admits(STRANGER)).toBe(true);
  });
});
