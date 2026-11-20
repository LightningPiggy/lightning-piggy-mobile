/**
 * A refresh's follow list and its "follows loaded" flag are read at the same
 * moment, when it starts (#1830). A refresh that started before kind 3 landed
 * checks wraps against the empty list it started with, so it must also tell
 * the ingest that follows weren't loaded — otherwise a friend's new room would
 * be judged a stranger's and skip-set until a forced refresh.
 */
import { act, renderHook } from '@testing-library/react-native';
import { fetchInboxDmEvents } from '../services/nostrService';
import { loadInboxEntries } from '../services/dmInbox';
import { ingestInboxNip17ForSigner } from './inboxNip17Ingest';
import { useDmInbox, type UseDmInboxOptions } from './useDmInbox';

jest.mock('../services/nostrService', () => ({ fetchInboxDmEvents: jest.fn() }));
jest.mock('../services/amberService', () => ({}));
jest.mock('./nip46DmDecrypt', () => ({ nip46DecryptNip04: jest.fn() }));
jest.mock('./nostrSecretKeyCache', () => ({
  nip04PlaintextCache: { get: jest.fn(), set: jest.fn() },
  getMemoisedSecretKey: jest.fn(),
}));
jest.mock('./inboxNip17Ingest', () => ({ ingestInboxNip17ForSigner: jest.fn(async () => null) }));
jest.mock('../services/dmInbox', () => ({ loadInboxEntries: jest.fn() }));
jest.mock('../services/dmDb', () => ({
  ...jest.requireActual('../services/dmDb'),
  selectKnownEventIds: jest.fn(async () => new Set()),
  upsertDmMessages: jest.fn(async () => undefined),
  updateDmDeliveryStatuses: jest.fn(async () => undefined),
  hasStoredWraps: jest.fn(async () => true),
  getConversationMessages: jest.fn(async () => []),
}));
jest.mock('./dmStoreMigrationRunner', () => ({ ensureDmStoreMigrated: jest.fn(async () => {}) }));
jest.mock('./nostrLiveDmSub', () => ({ startLiveDmSubscription: jest.fn(() => () => {}) }));
jest.mock('./nostrFetchConversation', () => ({ fetchConversationFor: jest.fn() }));
jest.mock('./conversationReadThrough', () => ({ loadInitialConversation: jest.fn() }));
jest.mock('./dmColdStartBackfill', () => ({ scheduleColdStartBackfill: jest.fn() }));
jest.mock('./dmDeliveryStorePersistence', () => ({
  bindDmDeliveryStorePersistence: jest.fn(async () => () => {}),
}));
jest.mock('./useMarmotDmInbound', () => ({ useMarmotDmInbound: jest.fn() }));

const VIEWER = 'a'.repeat(64);
const FRIEND = 'c'.repeat(64);

type FetchResult = Awaited<ReturnType<typeof fetchInboxDmEvents>>;
const wrap = {
  id: 'w'.repeat(64),
  kind: 1059,
  pubkey: 'e'.repeat(64),
  created_at: 1,
  tags: [],
  content: '',
  sig: '',
};

const options = (hydrated: boolean): UseDmInboxOptions => ({
  pubkey: VIEWER,
  isLoggedIn: true,
  signerType: 'nsec',
  followPubkeys: new Set(hydrated ? [FRIEND] : []),
  followHydrated: hydrated,
  getReadRelays: () => ['wss://a.example'],
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(loadInboxEntries).mockResolvedValue([]);
});

it.each([false, true])(
  'passes the loaded flag captured with the follow list (started hydrated=%s)',
  async (startedHydrated) => {
    let finishFetch!: (r: FetchResult) => void;
    jest
      .mocked(fetchInboxDmEvents)
      .mockReturnValue(new Promise<FetchResult>((resolve) => (finishFetch = resolve)));
    const { result, rerender, unmount } = renderHook(
      (props: UseDmInboxOptions) => useDmInbox(props),
      { initialProps: options(startedHydrated) },
    );
    let refresh!: Promise<void>;
    act(() => {
      refresh = result.current.refreshDmInbox({ force: true });
    });
    // Kind 3 lands while the relay fetch is in flight.
    rerender(options(true));
    await act(async () => {
      finishFetch({ kind4: [], kind1059: [wrap], complete: true } as unknown as FetchResult);
      await refresh;
    });
    const args = jest.mocked(ingestInboxNip17ForSigner).mock.calls[0]?.[0];
    expect(args).toBeDefined();
    expect(args.followsHydrated).toBe(startedHydrated);
    expect(args.isFollowed?.(FRIEND)).toBe(startedHydrated);
    unmount();
  },
);
