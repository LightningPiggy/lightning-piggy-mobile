import { act, renderHook } from '@testing-library/react-native';
import { useMentionProfile } from './useMentionProfile';
import { __resetMentionProfilesForTests } from '../services/nostrMentionProfiles';
import { querySyncAbortable } from '../services/relayQuery';
import * as appRelayPrefs from '../services/appRelayPrefs';

let mockFocused = true;
let mockNostr: Record<string, unknown>;

const mockVerifiedFetch = jest.fn();
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (callback: () => (() => void) | undefined) => {
    const React = jest.requireActual<typeof import('react')>('react');
    const focused = mockFocused;
    React.useEffect(() => (focused ? callback() : undefined), [callback, focused]);
  },
}));
jest.mock('../contexts/NostrContext', () => ({
  useNostr: () => mockNostr,
  useNostrContacts: () => mockNostr,
}));
jest.mock('../services/nostrService', () => ({
  fetchProfile: (...args: unknown[]) => mockVerifiedFetch(...args),
}));
jest.mock('../services/nostrPool', () => ({ pool: {}, trackRelays: jest.fn() }));
jest.mock('../services/relayQuery', () => ({ querySyncAbortable: jest.fn() }));
jest.mock('../services/zapSenderProfileStorage', () => ({
  peekSync: () => null,
  get: async () => null,
  getMany: async () => new Map(),
  setMany: jest.fn(),
  subscribeProfilesChanged: jest.fn(() => () => {}),
}));
const query = jest.mocked(querySyncAbortable);
beforeEach(() => {
  jest.useFakeTimers();
  mockFocused = true;
  mockNostr = { relays: [{ url: 'wss://read', read: true, write: false }], contacts: [] };
  jest.clearAllMocks();
  __resetMentionProfilesForTests();
  query.mockResolvedValue([]);
  mockVerifiedFetch.mockResolvedValue(null);
});
afterEach(() => {
  __resetMentionProfilesForTests();
  jest.restoreAllMocks();
  jest.useRealTimers();
});

it('shares one cosmetic batch across mention hooks without verified payment lookups', async () => {
  const a = renderHook(() => useMentionProfile('a'));
  const b = renderHook(() => useMentionProfile('b'));
  await act(async () => {
    await jest.advanceTimersByTimeAsync(60);
  });
  expect(query).toHaveBeenCalledTimes(2);
  expect(query.mock.calls[0][2].authors).toEqual(['a', 'b']);
  expect(mockVerifiedFetch).not.toHaveBeenCalled();
  a.unmount();
  b.unmount();
});

it('does not query while blurred, and cancels the subscription on blur before unmount', async () => {
  mockFocused = false;
  const hook = renderHook(() => useMentionProfile('a'));
  await act(async () => {
    await jest.advanceTimersByTimeAsync(60);
  });
  expect(query).not.toHaveBeenCalled();
  expect(mockVerifiedFetch).not.toHaveBeenCalled();
  query.mockImplementation(
    (_pool, _relays, _filter, opts) =>
      new Promise((resolve) => {
        opts.signal?.addEventListener('abort', () => resolve([]), { once: true });
      }),
  );
  mockFocused = true;
  mockNostr = { relays: [{ url: 'wss://read', read: true, write: false }], contacts: [] };
  hook.rerender({});
  await act(async () => {
    await jest.advanceTimersByTimeAsync(60);
  });
  const signal = query.mock.calls[0][3].signal!;
  expect(signal.aborted).toBe(false);
  mockFocused = false;
  hook.rerender({});
  expect(signal.aborted).toBe(true);
  hook.unmount();
});

it('resolves the signed-in profile before contacts without a relay lookup', async () => {
  mockNostr = {
    ...mockNostr,
    pubkey: 'a',
    profile: { displayName: 'Me', name: 'old' },
    contacts: [{ pubkey: 'a', profile: { displayName: 'Stale contact' } }],
  };
  const hook = renderHook(() => useMentionProfile('a'));
  expect(hook.result.current.name).toBe('Me');
  await act(async () => {
    await jest.advanceTimersByTimeAsync(120);
  });
  expect(query).not.toHaveBeenCalled();
  mockNostr = { ...mockNostr, profile: { displayName: 'Updated me' } };
  hook.rerender({});
  expect(hook.result.current.name).toBe('Updated me');
  hook.unmount();
});

it('uses the shared Friends/Messages contacts and reacts to later hydration', async () => {
  mockNostr = { ...mockNostr, contacts: [{ pubkey: 'a', profile: { displayName: 'Alice' } }] };
  const hook = renderHook(() => useMentionProfile('a'));
  expect(hook.result.current.name).toBe('Alice');
  await act(async () => {
    await jest.advanceTimersByTimeAsync(120);
  });
  expect(query).not.toHaveBeenCalled();
  mockNostr = { ...mockNostr, contacts: [{ pubkey: 'a', profile: { displayName: 'New Alice' } }] };
  hook.rerender({});
  expect(hook.result.current.name).toBe('New Alice');
  hook.unmount();
});

it('updates an already-mounted miss when a contact arrives', async () => {
  const hook = renderHook(() => useMentionProfile('a'));
  await act(async () => {
    await jest.advanceTimersByTimeAsync(120);
  });
  expect(query).toHaveBeenCalled();
  expect(hook.result.current.name).toBeNull();
  mockNostr = { ...mockNostr, contacts: [{ pubkey: 'a', profile: { name: 'Arrived' } }] };
  hook.rerender({});
  expect(hook.result.current.name).toBe('Arrived');
  hook.unmount();
});

it('uses a supplied Marmot member profile before lower caches and relay work', async () => {
  const hook = renderHook(() => useMentionProfile('a', { name: 'Member', picture: null }));
  expect(hook.result.current.name).toBe('Member');
  await act(async () => {
    await jest.advanceTimersByTimeAsync(120);
  });
  expect(query).not.toHaveBeenCalled();
  mockNostr = { ...mockNostr, contacts: [{ pubkey: 'a', profile: { name: 'Friend' } }] };
  hook.rerender({});
  expect(hook.result.current.name).toBe('Friend');
  hook.unmount();
});

it('retries a cache miss once using the account write relays and both indexers', async () => {
  mockNostr = {
    ...mockNostr,
    relays: [
      { url: 'wss://read', read: true, write: false },
      { url: 'wss://write', read: false, write: true },
    ],
  };
  const hook = renderHook(() => useMentionProfile('a'));
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1000);
  });
  expect(query).toHaveBeenCalledTimes(2);
  expect(query.mock.calls[1][1]).toEqual(
    expect.arrayContaining(['wss://write', 'wss://purplepag.es', 'wss://user.kindpag.es']),
  );
  hook.unmount();
});

it('skips the retry when no write relays or enabled indexers are available', async () => {
  jest
    .spyOn(appRelayPrefs, 'enabledAppRelays')
    .mockImplementation((group, list) => (group === 'indexers' ? [] : list));
  const hook = renderHook(() => useMentionProfile('a'));
  await act(async () => {
    await jest.advanceTimersByTimeAsync(1000);
  });
  expect(query).toHaveBeenCalledTimes(1);
  expect(query.mock.calls[0][1]).toEqual(['wss://read']);
  hook.unmount();
});

it('lets the screen own member relay work while the row observes the shared cache', async () => {
  const hook = renderHook(() => useMentionProfile('a', null, false));
  await act(async () => {
    await jest.advanceTimersByTimeAsync(120);
  });
  expect(query).not.toHaveBeenCalled();
  expect(hook.result.current.name).toBeNull();
  hook.unmount();
});
