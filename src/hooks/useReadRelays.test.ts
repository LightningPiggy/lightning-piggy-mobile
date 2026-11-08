import { renderHook } from '@testing-library/react-native';
import { getCurrentUserOwnRelays, setCurrentUserOwnRelays } from '../services/nostrActiveAccount';
import { useReadRelays } from './useReadRelays';

jest.mock('./useAppRelayPrefs', () => ({ useAppRelayPrefs: () => 0 }));

afterEach(() => setCurrentUserOwnRelays([]));

it("publishes the viewer's read AND DM inbox relays, so no outbox lease can take them (#1390)", () => {
  const relays = [
    { url: 'wss://read.example/', read: true, write: true },
    { url: 'wss://write-only.example/', read: false, write: true },
  ];
  const { result, rerender } = renderHook(({ dm }: { dm: string[] }) => useReadRelays(relays, dm), {
    initialProps: { dm: ['wss://dm-inbox.example/'] },
  });
  expect(result.current()).toEqual(['wss://read.example/', 'wss://dm-inbox.example/']);
  expect(getCurrentUserOwnRelays()).toEqual(['wss://read.example/', 'wss://dm-inbox.example/']);
  rerender({ dm: ['wss://other-inbox.example/'] });
  expect(getCurrentUserOwnRelays()).toEqual(['wss://read.example/', 'wss://other-inbox.example/']);
});
