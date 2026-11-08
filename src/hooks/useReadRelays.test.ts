import { act, renderHook } from '@testing-library/react-native';
import {
  areCurrentUserOwnRelaysHydrated,
  getCurrentUserOwnRelays,
  setCurrentUserOwnRelays,
  setCurrentUserPubkey,
} from '../services/nostrActiveAccount';
import { useReadRelays } from './useReadRelays';

jest.mock('./useAppRelayPrefs', () => ({ useAppRelayPrefs: () => 0 }));

afterEach(() => {
  setCurrentUserOwnRelays([], false);
  setCurrentUserPubkey(null);
});

const relays = [
  { url: 'wss://read.example/', read: true, write: true },
  { url: 'wss://write-only.example/', read: false, write: true },
];

it("publishes the viewer's read, DM inbox AND write relays as their own (#1390)", () => {
  const { result, rerender } = renderHook(
    ({ dm }: { dm: string[] }) => useReadRelays(relays, dm, true),
    { initialProps: { dm: ['wss://dm-inbox.example/'] } },
  );
  // getReadRelays() itself is unchanged: read + DM inbox only.
  expect(result.current()).toEqual(['wss://read.example/', 'wss://dm-inbox.example/']);
  // The own set also protects a write-only relay (it carries their publishes).
  expect(getCurrentUserOwnRelays()).toEqual([
    'wss://read.example/',
    'wss://dm-inbox.example/',
    'wss://write-only.example/',
  ]);
  rerender({ dm: ['wss://other-inbox.example/'] });
  expect(getCurrentUserOwnRelays()).toEqual([
    'wss://read.example/',
    'wss://other-inbox.example/',
    'wss://write-only.example/',
  ]);
});

it('publishes the hydrated flag with the set: defaults before the lists load are not hydrated', () => {
  const { rerender } = renderHook(
    ({ list, hydrated }: { list: typeof relays; hydrated: boolean }) =>
      useReadRelays(list, [], hydrated),
    { initialProps: { list: [] as typeof relays, hydrated: false } },
  );
  // Cold start: the app defaults stand in, and nothing may be leased yet.
  expect(getCurrentUserOwnRelays().length).toBeGreaterThan(0);
  expect(areCurrentUserOwnRelaysHydrated()).toBe(false);
  rerender({ list: relays, hydrated: true });
  expect(getCurrentUserOwnRelays()).toEqual(['wss://read.example/', 'wss://write-only.example/']);
  expect(areCurrentUserOwnRelaysHydrated()).toBe(true);
});

it('republishes after an account change, so a switch to an identical set is not left unhydrated', () => {
  renderHook(() => useReadRelays(relays, [], true));
  expect(areCurrentUserOwnRelaysHydrated()).toBe(true);
  // The active-account module clears hydration on a pubkey change...
  act(() => setCurrentUserPubkey('b'.repeat(64)));
  // ...and the hook republishes the (unchanged, still hydrated) set.
  expect(areCurrentUserOwnRelaysHydrated()).toBe(true);
});
