import { act, renderHook } from '@testing-library/react-native';
import { useDmInboxSuggestion } from './useDmInboxSuggestion';
import { publishDefaultDmInbox } from '../contexts/defaultDmInbox';

const PK = 'a'.repeat(64);
const mockPk = PK;
const createdAt = jest.fn((_pk: string) => 42);
// One stable context value, as the real provider memoises it.
const mockNostr = {
  pubkey: PK,
  signerType: 'nsec',
  relays: [{ url: 'wss://read.example', read: true, write: true }],
  nip65Relays: [],
  dmInboxRelays: [],
  signEvent: jest.fn(),
  applyPublishedDmInbox: jest.fn(),
  applyPublishedRelayList: jest.fn(),
  dmInboxLive: { relays: () => [], createdAt, session: () => 1 },
};

jest.mock('@react-navigation/native', () => ({
  // Run the focus effect once, like a screen gaining focus.
  useFocusEffect: (effect: () => void | (() => void)) =>
    jest.requireActual('react').useEffect(effect, [effect]),
}));
jest.mock('../contexts/NostrContext', () => ({ useNostr: () => mockNostr }));
jest.mock('../services/nostrActiveAccount', () => ({ getCurrentUserPubkey: () => mockPk }));
jest.mock('../contexts/defaultDmInbox', () => ({
  publishDefaultDmInbox: jest.fn(),
  suggestedDmInboxRelays: () => ['wss://read.example'],
  readDefaultDmInboxState: jest.fn(async () => 'suggest'),
  writeDefaultDmInboxState: jest.fn(),
}));

const publishMock = publishDefaultDmInbox as jest.Mock;
const confirm = jest.fn(async () => true);

beforeEach(() => jest.clearAllMocks());

it('a double tap signs and publishes only once', async () => {
  let finish!: (outcome: string) => void;
  publishMock.mockReturnValue(new Promise((resolve) => (finish = resolve)));
  const { result } = renderHook(() => useDmInboxSuggestion());
  let first!: Promise<unknown>;
  let second: unknown;
  await act(async () => {
    first = result.current.publish(confirm);
    second = await result.current.publish(confirm); // same render: busy not re-rendered yet
  });
  expect(second).toBeNull();
  expect(publishMock).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish('published');
    await first;
  });
  // Once finished, a later tap works again.
  publishMock.mockResolvedValue('exists');
  await act(async () => {
    await result.current.publish(confirm);
  });
  expect(publishMock).toHaveBeenCalledTimes(2);
});

it('checks the in-memory created_at too, and passes the shown relays and confirm', async () => {
  publishMock.mockResolvedValue('published');
  const { result } = renderHook(() => useDmInboxSuggestion());
  await act(async () => {
    await result.current.publish(confirm);
  });
  const params = publishMock.mock.calls[0][0];
  expect(params.knownInboxCreatedAt()).toBe(42);
  expect(createdAt).toHaveBeenCalledWith(PK);
  expect(params.shownRelays).toEqual(result.current.relays);
  expect(params.confirm).toBe(confirm);
});
