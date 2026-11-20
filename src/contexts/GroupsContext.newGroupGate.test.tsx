// A kind-30200 may create a group the viewer isn't in yet only when its
// creator passes the Messages follow gate (#1830). One from a follow that
// arrives before the follow list is held, then created once follows load.
import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { GroupsProvider, useGroups } from './GroupsContext';
import { saveGroups } from '../services/groupsStorageService';

const FRIEND = 'b'.repeat(64);
const STRANGER = 'c'.repeat(64);
const OTHER = 'd'.repeat(64);

let mockContacts: { pubkey: string }[] = [];
let mockTier: 'friends' | 'fof' | 'all' = 'friends';
jest.mock('./NostrContext', () => ({
  useNostr: () => ({
    publishGroupState: jest.fn(),
    pubkey: 'a'.repeat(64),
    relays: [],
    isLoggedIn: true,
    sendDirectMessage: jest.fn(),
    signerType: 'nsec',
  }),
  useNostrContacts: () => ({ contacts: mockContacts }),
  subscribeGroupMessages: () => () => {},
}));
jest.mock('./TrustGraphContext', () => ({
  useTrustGraph: () => ({ wotTier: mockTier, setWotTier: jest.fn(), isTrustedAtTier: () => true }),
}));
jest.mock('./useMarmotGroups', () => ({ useMarmotGroups: () => ({ groups: [] }) }));
jest.mock('./useNip171Groups', () => ({ useNip171Groups: () => ({ groups: [] }) }));
jest.mock('../services/nostrService', () => ({
  DEFAULT_RELAYS: [],
  GROUP_STATE_KIND: 30200,
  subscribeGroupStateForViewer: () => () => {},
}));
jest.mock('../services/groupsStorageService', () => ({
  createGroupId: () => 'new-id',
  loadGroups: jest.fn(async () => []),
  saveGroups: jest.fn(async () => undefined),
  loadGroupActivity: jest.fn(async () => ({})),
  saveGroupActivity: jest.fn(async () => undefined),
}));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <GroupsProvider>{children}</GroupsProvider>
);

const stateFrom = (sender: string, groupId = 'room') => ({
  senderPubkey: sender,
  groupId,
  name: 'Their room',
  memberPubkeys: [sender, OTHER],
  createdAt: 100,
});

async function renderGroups() {
  const hook = renderHook(() => useGroups(), { wrapper });
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  return hook;
}

const savedIds = () =>
  jest.mocked(saveGroups).mock.calls.flatMap(([, groups]) => groups.map((g) => g.id));

beforeEach(() => {
  jest.clearAllMocks();
  mockContacts = [{ pubkey: FRIEND }];
  mockTier = 'friends';
});

it('creates a new group from a followed creator', async () => {
  const { result } = await renderGroups();
  let applied = false;
  await act(async () => {
    applied = await result.current.reconcileFromGroupStateEvent(stateFrom(FRIEND));
  });
  expect(applied).toBe(true);
  expect(result.current.groups.map((g) => g.id)).toEqual(['room']);
  expect(savedIds()).toContain('room');
});

it.each(['friends', 'fof'] as const)(
  'never persists a new group from a stranger (tier %s), even naming a follow as a member',
  async (tier) => {
    mockTier = tier;
    const { result } = await renderGroups();
    let applied = true;
    await act(async () => {
      applied = await result.current.reconcileFromGroupStateEvent({
        ...stateFrom(STRANGER),
        memberPubkeys: [STRANGER, FRIEND],
      });
    });
    expect(applied).toBe(false);
    expect(result.current.groups).toEqual([]);
    expect(savedIds()).not.toContain('room');
  },
);

it('accepts a stranger-created group when the list shows everyone (tier all)', async () => {
  mockTier = 'all';
  const { result } = await renderGroups();
  await act(async () => {
    await result.current.reconcileFromGroupStateEvent(stateFrom(STRANGER));
  });
  expect(result.current.groups.map((g) => g.id)).toEqual(['room']);
});

it('holds a follow-created group that lands before the follow list, then creates it', async () => {
  mockContacts = [];
  const { result, rerender } = await renderGroups();
  await act(async () => {
    await result.current.reconcileFromGroupStateEvent(stateFrom(FRIEND));
  });
  expect(result.current.groups).toEqual([]);
  mockContacts = [{ pubkey: FRIEND }];
  rerender({});
  await waitFor(() => expect(result.current.groups.map((g) => g.id)).toEqual(['room']));
});

it('still applies a member update to a group the viewer already has', async () => {
  const { result } = await renderGroups();
  await act(async () => {
    await result.current.reconcileFromGroupStateEvent(stateFrom(FRIEND));
  });
  // OTHER is a member of the known group but not followed: their rename lands.
  await act(async () => {
    await result.current.reconcileFromGroupStateEvent({
      ...stateFrom(OTHER),
      memberPubkeys: [FRIEND, OTHER],
      name: 'Renamed',
      createdAt: 200,
    });
  });
  expect(result.current.groups[0]).toMatchObject({ id: 'room', name: 'Renamed' });
});
