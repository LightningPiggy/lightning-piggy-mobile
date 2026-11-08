/**
 * The live DM subscription re-arms only when the read-relay SET changes.
 * Every arm re-runs the wrap-id seed queries and re-downloads the gift-wrap
 * backlog per relay, so a re-parsed but identical relay list (cold start sets
 * it several times) must not tear the sub down.
 */
import { renderHook } from '@testing-library/react-native';
import { fetchInboxDmEvents } from '../services/nostrService';
import { loadInboxEntries } from '../services/dmInbox';
import { startLiveDmSubscription } from './nostrLiveDmSub';
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
const PARTNER = 'c'.repeat(64);
const followPubkeys = new Set([PARTNER]);

const optionsWith = (relays: string[]): UseDmInboxOptions => ({
  pubkey: VIEWER,
  isLoggedIn: true,
  signerType: 'nsec',
  followPubkeys,
  // A new getter per call, as a re-parsed relay list produces.
  getReadRelays: () => [...relays],
});

beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(loadInboxEntries).mockResolvedValue([]);
  jest
    .mocked(fetchInboxDmEvents)
    .mockResolvedValue({ kind4: [], kind1059: [], complete: true } as unknown as Awaited<
      ReturnType<typeof fetchInboxDmEvents>
    >);
});

describe('useDmInbox live sub relay keying', () => {
  it('does not re-arm when the read relays are re-parsed with the same content', () => {
    const stop = jest.fn();
    const start = jest.mocked(startLiveDmSubscription);
    start.mockReturnValue(stop);
    const { rerender, unmount } = renderHook((props: UseDmInboxOptions) => useDmInbox(props), {
      initialProps: optionsWith(['wss://a.example', 'wss://b.example']),
    });
    expect(start).toHaveBeenCalledTimes(1);

    rerender(optionsWith(['wss://b.example/', 'wss://A.example']));
    rerender(optionsWith(['wss://a.example', 'wss://b.example', 'wss://a.example']));
    expect(start).toHaveBeenCalledTimes(1);
    expect(stop).not.toHaveBeenCalled();
    unmount();
  });

  it('re-arms on the new relays when the set changes', () => {
    const stop = jest.fn();
    const start = jest.mocked(startLiveDmSubscription);
    start.mockReturnValue(stop);
    const { rerender, unmount } = renderHook((props: UseDmInboxOptions) => useDmInbox(props), {
      initialProps: optionsWith(['wss://a.example']),
    });
    expect(start).toHaveBeenCalledTimes(1);

    rerender(optionsWith(['wss://a.example', 'wss://dm-inbox.example']));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledTimes(2);
    expect(start).toHaveBeenLastCalledWith(
      expect.objectContaining({ readRelays: ['wss://a.example', 'wss://dm-inbox.example'] }),
    );
    unmount();
  });
});
