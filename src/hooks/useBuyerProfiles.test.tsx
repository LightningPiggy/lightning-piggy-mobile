import { renderHook, waitFor } from '@testing-library/react-native';
import { useBuyerProfiles } from './useBuyerProfiles';
import * as cache from '../services/zapSenderProfileStorage';
import { readOrderCounterpartyProfiles } from '../services/orderCounterpartyProfiles';
import type { NostrContact } from '../types/nostr';

const BUYER = 'b'.repeat(64);
const OTHER = 'c'.repeat(64);
let mockOwner = 'a'.repeat(64);
let mockContacts: NostrContact[] = [];
const mockFetch = jest.fn();
jest.mock('../contexts/NostrContext', () => ({
  useNostr: () => ({ pubkey: mockOwner, fetchProfilesForPubkeys: mockFetch }),
  useNostrContacts: () => ({ contacts: mockContacts }),
}));
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => void | (() => void)) =>
    jest.requireActual('react').useEffect(effect, [effect]),
}));
jest.mock('../services/orderCounterpartyProfiles', () => ({
  readOrderCounterpartyProfiles: jest.fn(),
}));
jest.mock('../services/zapSenderProfileStorage', () => ({
  getMany: jest.fn(),
  setMany: jest.fn(),
}));

beforeEach(() => {
  mockOwner = 'a'.repeat(64);
  mockContacts = [];
  jest.clearAllMocks();
  jest.mocked(readOrderCounterpartyProfiles).mockResolvedValue(new Map());
  jest.mocked(cache.setMany).mockResolvedValue(undefined);
  mockFetch.mockResolvedValue(new Map());
});

it('uses Friends names and pictures without a relay request', async () => {
  mockContacts = [
    {
      pubkey: BUYER,
      petname: null,
      relay: null,
      profile: {
        npub: 'npub',
        name: 'Piggy',
        displayName: 'Little Piggy',
        picture: 'https://example.com/pig.png',
      } as NostrContact['profile'],
    },
  ];
  const { result } = renderHook(() => useBuyerProfiles(BUYER));
  expect(result.current.get(BUYER)?.displayName).toBe('Little Piggy');
  expect(result.current.get(BUYER)?.picture).toBe('https://example.com/pig.png');
  await waitFor(() => expect(readOrderCounterpartyProfiles).toHaveBeenCalled());
  expect(mockFetch).not.toHaveBeenCalled();
});

it('reuses cached avatars and batches missing counterparties through the existing fetch', async () => {
  jest
    .mocked(readOrderCounterpartyProfiles)
    .mockResolvedValue(
      new Map([
        [BUYER, { npub: 'npub', name: 'Cached', displayName: null, picture: null, nip05: null }],
      ]),
    );
  mockFetch.mockResolvedValue(
    new Map([
      [
        OTHER,
        {
          npub: 'other',
          displayName: 'Fetched',
          picture: 'https://example.com/pig.png',
          lud16: 'unverified',
        },
      ],
    ]),
  );
  const { result } = renderHook(() => useBuyerProfiles(`${BUYER},${OTHER}`));
  await waitFor(() => expect(result.current.get(OTHER)?.displayName).toBe('Fetched'));
  expect(result.current.get(BUYER)?.name).toBe('Cached');
  expect(mockFetch).toHaveBeenCalledTimes(1);
  expect(mockFetch).toHaveBeenCalledWith([OTHER]);
  expect(cache.setMany).toHaveBeenCalledWith(
    new Map([
      [
        OTHER,
        {
          npub: 'other',
          name: undefined,
          displayName: 'Fetched',
          picture: 'https://example.com/pig.png',
          nip05: null,
        },
      ],
    ]),
  );
});

it('discards a late result after the account or counterparty set changes', async () => {
  let resolve!: (value: Map<string, never>) => void;
  mockFetch.mockReturnValue(
    new Promise((done) => {
      resolve = done;
    }),
  );
  const { result, rerender } = renderHook(({ key }: { key: string }) => useBuyerProfiles(key), {
    initialProps: { key: BUYER },
  });
  await waitFor(() => expect(mockFetch).toHaveBeenCalled());
  mockOwner = 'd'.repeat(64);
  rerender({ key: '' });
  resolve(new Map([[BUYER, { npub: 'npub', name: 'Stale' } as never]]));
  await waitFor(() => expect(result.current.size).toBe(0));
  expect(cache.setMany).not.toHaveBeenCalled();
});

it('fetches a name when an older avatar cache entry has no display metadata', async () => {
  jest.mocked(readOrderCounterpartyProfiles).mockResolvedValue(
    new Map([
      [
        BUYER,
        {
          npub: 'npub',
          name: null,
          displayName: null,
          picture: null,
          nip05: null,
        },
      ],
    ]),
  );
  mockFetch.mockResolvedValue(new Map([[BUYER, { npub: 'npub', name: 'Little Piggy' }]]));
  const { result } = renderHook(() => useBuyerProfiles(BUYER));
  await waitFor(() => expect(result.current.get(BUYER)?.name).toBe('Little Piggy'));
  expect(mockFetch).toHaveBeenCalledWith([BUYER]);
});
