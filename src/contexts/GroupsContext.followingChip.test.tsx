// The Groups "following" chip maps onto the Web of Trust tier, but it says
// nothing about alerts: it must not record an explicit pick, which would widen
// message notifications to everyone (#1764).
import React from 'react';
import { act, renderHook } from '@testing-library/react-native';
import { GroupsProvider, useGroups } from './GroupsContext';

const mockSetWotTier = jest.fn();
jest.mock('./NostrContext', () => ({
  useNostr: () => ({
    publishGroupState: jest.fn(),
    pubkey: null,
    relays: [],
    isLoggedIn: false,
    sendDirectMessage: jest.fn(),
    signerType: null,
  }),
  useNostrContacts: () => ({ contacts: [] }),
  subscribeGroupMessages: () => () => {},
}));
jest.mock('./TrustGraphContext', () => ({
  useTrustGraph: () => ({
    wotTier: 'friends',
    setWotTier: mockSetWotTier,
    isTrustedAtTier: () => true,
  }),
}));
jest.mock('./useMarmotGroups', () => ({ useMarmotGroups: () => ({ groups: [] }) }));
jest.mock('./useNip171Groups', () => ({ useNip171Groups: () => ({ groups: [] }) }));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <GroupsProvider>{children}</GroupsProvider>
);

it.each([
  [false, 'all'],
  [true, 'friends'],
] as const)('setFollowingOnly(%s) sets %s without marking it chosen', (next, tier) => {
  const { result } = renderHook(() => useGroups(), { wrapper });
  act(() => result.current.setFollowingOnly(next));
  expect(mockSetWotTier).toHaveBeenLastCalledWith(tier, { explicit: false });
});
