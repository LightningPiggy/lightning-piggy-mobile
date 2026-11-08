import { renderHook } from '@testing-library/react-native';
import {
  areCurrentUserOwnRelaysHydrated,
  getCurrentUserOwnRelays,
  setCurrentUserOwnRelays,
} from '../services/nostrActiveAccount';
import { useReadRelays } from './useReadRelays';

jest.mock('./useAppRelayPrefs', () => ({ useAppRelayPrefs: () => 0 }));

afterEach(() => setCurrentUserOwnRelays([], false));

const relays = [
  { url: 'wss://read.example/', read: true, write: true },
  { url: 'wss://write-only.example/', read: false, write: true },
];

it("publishes the viewer's read AND DM inbox relays, so no outbox lease can take them (#1390)", () => {
  const { result, rerender } = renderHook(
    ({ dm }: { dm: string[] }) => useReadRelays(relays, dm, true),
    { initialProps: { dm: ['wss://dm-inbox.example/'] } },
  );
  expect(result.current()).toEqual(['wss://read.example/', 'wss://dm-inbox.example/']);
  expect(getCurrentUserOwnRelays()).toEqual(['wss://read.example/', 'wss://dm-inbox.example/']);
  rerender({ dm: ['wss://other-inbox.example/'] });
  expect(getCurrentUserOwnRelays()).toEqual(['wss://read.example/', 'wss://other-inbox.example/']);
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
  expect(getCurrentUserOwnRelays()).toEqual(['wss://read.example/']);
  expect(areCurrentUserOwnRelaysHydrated()).toBe(true);
});
