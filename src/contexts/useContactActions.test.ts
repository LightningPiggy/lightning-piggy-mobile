import { act, renderHook } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as nostrService from '../services/nostrService';
import { Toast } from '../components/BrandedToast';
import type { ContactListFetchResult } from '../services/contactListSync';
import type { NostrContact, RelayConfig } from '../types/nostr';
import { useContactActions } from './useContactActions';
import { clearFollowGateStores } from '../services/followSetEvents';
import { relayAllowsKind } from '../services/relayKindPolicy';
import * as amberService from '../services/amberService';
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import * as contactFollowFreshness from '../services/contactFollowFreshness';
import {
  __resetForTests,
  isAccountCreatedHere,
  markAccountCreatedHere,
} from '../services/newAccountContactList';

const ME = 'a'.repeat(64);
const BIG = 'b'.repeat(64);
const LITTLE = 'c'.repeat(64);
const NEW = 'd'.repeat(64);

jest.mock('../services/nostrService', () => ({
  DEFAULT_RELAYS: ['wss://default'],
  decodeNsec: jest.fn(() => ({ pubkey: 'a'.repeat(64), secretKey: new Uint8Array(32) })),
  signAndPublishEvent: jest.fn(async () => undefined),
  publishSignedEvent: jest.fn(async () => undefined),
  fetchProfile: jest.fn(async () => null),
}));
jest.mock('../components/BrandedToast', () => ({ Toast: { show: jest.fn() } }));
jest.mock('../services/relayKindPolicy', () => ({ relayAllowsKind: jest.fn(async () => true) }));

const mockFetch = jest.fn<Promise<ContactListFetchResult>, [string, string[]]>();
const mockPrepareArgs = jest.fn();
jest.mock('../services/contactListSync', () => {
  const actual = jest.requireActual('../services/contactListSync');
  return {
    ...actual,
    prepareContactListUpdate: (args: object) => {
      mockPrepareArgs(args);
      return actual.prepareContactListUpdate({ ...args, fetchLatest: mockFetch });
    },
  };
});

const relays: RelayConfig[] = [{ url: 'wss://mine', read: true, write: true }];

function setup(contacts: NostrContact[]) {
  const setContacts = jest.fn();
  const { result, rerender } = renderHook(
    (owner: string) =>
      useContactActions({
        pubkey: owner,
        isLoggedIn: true,
        signerType: 'nsec',
        relays,
        contacts,
        setContacts,
        getReadRelays: () => ['wss://mine'],
        loadContacts: jest.fn(async () => {}),
      }),
    { initialProps: ME },
  );
  return { result, setContacts, rerender };
}

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  __resetForTests();
  jest.spyOn(SecureStore, 'getItemAsync').mockResolvedValue('nsec1test');
});

describe('useContactActions follow path (#1271)', () => {
  it.each(['fetch', 'secure-store'] as const)(
    'refuses an old follow write after A→B while awaiting %s',
    async (blockedAt) => {
      let release!: () => void;
      let started!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const reachedBoundary = new Promise<void>((resolve) => {
        started = resolve;
      });
      const relayList: ContactListFetchResult = {
        status: 'found',
        base: { tags: [['p', BIG]], content: '', createdAt: 10 },
      };
      mockFetch.mockImplementation(async () => {
        if (blockedAt === 'fetch') {
          started();
          await blocked;
        }
        return relayList;
      });
      jest.spyOn(SecureStore, 'getItemAsync').mockImplementation(async () => {
        if (blockedAt === 'secure-store') {
          started();
          await blocked;
        }
        return 'nsec1-account-b';
      });
      const { result, setContacts, rerender } = setup([]);
      let pending!: Promise<boolean>;
      await act(async () => {
        pending = result.current.followContact(NEW);
        await reachedBoundary;
      });
      clearFollowGateStores(); // same session invalidation used by account switching
      rerender(BIG);
      let ok = true;
      await act(async () => {
        release();
        ok = await pending;
      });
      expect(ok).toBe(false);
      expect(nostrService.decodeNsec).not.toHaveBeenCalled();
      expect(nostrService.signAndPublishEvent).not.toHaveBeenCalled();
      expect(nostrService.publishSignedEvent).not.toHaveBeenCalled();
      expect(setContacts).not.toHaveBeenCalled();
      expect(nostrService.fetchProfile).not.toHaveBeenCalled();
      if (blockedAt === 'fetch') expect(SecureStore.getItemAsync).not.toHaveBeenCalled();
    },
  );

  it('follows on top of the relay list when the local list never loaded', async () => {
    mockFetch.mockResolvedValue({
      status: 'found',
      base: {
        tags: [
          ['p', BIG],
          ['p', LITTLE],
        ],
        content: '{"wss://x":{}}',
        createdAt: 10,
      },
    });
    const { result } = setup([]);
    let ok = false;
    await act(async () => {
      ok = await result.current.followContact(NEW);
    });
    expect(ok).toBe(true);
    const published = (nostrService.signAndPublishEvent as jest.Mock).mock.calls[0][0];
    expect(published.tags.filter((t: string[]) => t[0] === 'p').map((t: string[]) => t[1])).toEqual(
      [BIG, LITTLE, NEW],
    );
    expect(published.content).toBe('{"wss://x":{}}');
  });

  it('does not publish (and shows a branded error) when the fetch fails and the local list is empty', async () => {
    mockFetch.mockResolvedValue({ status: 'failed' });
    const { result, setContacts } = setup([]);
    let ok = true;
    await act(async () => {
      ok = await result.current.followContact(NEW);
    });
    expect(ok).toBe(false);
    expect(nostrService.signAndPublishEvent).not.toHaveBeenCalled();
    expect(setContacts).not.toHaveBeenCalled();
    expect(Toast.show).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('does not publish when relays only report EOSE (no kind-3) and the local list is empty', async () => {
    mockFetch.mockResolvedValue({ status: 'empty', confirmedBy: 2 });
    const { result } = setup([]);
    let ok = true;
    await act(async () => {
      ok = await result.current.followContact(NEW);
    });
    expect(ok).toBe(false);
    expect(nostrService.signAndPublishEvent).not.toHaveBeenCalled();
  });

  it('does not publish when the fetch fails, even with a non-empty local list', async () => {
    mockFetch.mockResolvedValue({ status: 'failed' });
    const local: NostrContact = { pubkey: BIG, relay: null, petname: null, profile: null };
    const { result } = setup([local]);
    let ok = true;
    await act(async () => {
      ok = await result.current.followContact(NEW);
    });
    expect(ok).toBe(false);
    expect(nostrService.signAndPublishEvent).not.toHaveBeenCalled();
  });

  it('serialises overlapping follows so the second keeps the first', async () => {
    const OTHER = 'e'.repeat(64);
    // Relays keep serving the pre-follow list (lag after our first publish).
    mockFetch.mockResolvedValue({
      status: 'found',
      base: { tags: [['p', BIG]], content: '', createdAt: 10 },
    });
    const { result } = setup([]);
    await act(async () => {
      await Promise.all([result.current.followContact(NEW), result.current.followContact(OTHER)]);
    });
    const calls = (nostrService.signAndPublishEvent as jest.Mock).mock.calls;
    expect(calls).toHaveLength(2);
    const last = calls[1][0].tags.filter((t: string[]) => t[0] === 'p').map((t: string[]) => t[1]);
    expect(last).toEqual([BIG, NEW, OTHER]);
  });

  it('account created here: relays confirm no list → first follow publishes [new] and clears the flag', async () => {
    await markAccountCreatedHere(ME);
    mockFetch.mockResolvedValue({ status: 'empty', confirmedBy: 2 });
    const { result } = setup([]);
    let ok = false;
    await act(async () => {
      ok = await result.current.followContact(NEW);
    });
    expect(ok).toBe(true);
    const published = (nostrService.signAndPublishEvent as jest.Mock).mock.calls[0][0];
    expect(published.tags.filter((t: string[]) => t[0] === 'p').map((t: string[]) => t[1])).toEqual(
      [NEW],
    );
    expect(await isAccountCreatedHere(ME)).toBe(false);
  });

  it('imported account: relays answering empty → refuse, nothing published', async () => {
    mockFetch.mockResolvedValue({ status: 'empty', confirmedBy: 3 });
    const { result } = setup([]);
    let ok = true;
    await act(async () => {
      ok = await result.current.followContact(NEW);
    });
    expect(ok).toBe(false);
    expect(nostrService.signAndPublishEvent).not.toHaveBeenCalled();
    expect(Toast.show).toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }));
  });

  it('clears the created-here flag once a relay list has been seen', async () => {
    await markAccountCreatedHere(ME);
    mockFetch.mockResolvedValue({
      status: 'found',
      base: { tags: [['p', BIG]], content: '', createdAt: 10 },
    });
    const { result } = setup([]);
    await act(async () => {
      await result.current.followContact(BIG); // already in the list: no publish
    });
    expect(nostrService.signAndPublishEvent).not.toHaveBeenCalled();
    expect(await isAccountCreatedHere(ME)).toBe(false);
  });

  it('an unverifiable list revokes the created-here flag, so a later empty answer refuses', async () => {
    await markAccountCreatedHere(ME);
    mockFetch.mockResolvedValueOnce({ status: 'failed', sawList: true });
    mockFetch.mockResolvedValueOnce({ status: 'empty', confirmedBy: 3 });
    const { result } = setup([]);
    let first = true;
    let second = true;
    await act(async () => {
      first = await result.current.followContact(NEW);
    });
    await act(async () => {
      second = await result.current.followContact(NEW);
    });
    expect([first, second]).toEqual([false, false]);
    expect(nostrService.signAndPublishEvent).not.toHaveBeenCalled();
    expect(await isAccountCreatedHere(ME)).toBe(false);
  });

  it('a loaded non-empty follow list revokes the created-here flag', async () => {
    await markAccountCreatedHere(ME);
    setup([{ pubkey: BIG, relay: null, petname: null, profile: null }]);
    await act(async () => {});
    expect(await isAccountCreatedHere(ME)).toBe(false);
  });

  it('unfollow removes only that person from the relay list', async () => {
    mockFetch.mockResolvedValue({
      status: 'found',
      base: {
        tags: [
          ['p', BIG],
          ['p', LITTLE],
        ],
        content: '',
        createdAt: 10,
      },
    });
    const { result } = setup([]);
    await act(async () => {
      await result.current.unfollowContact(BIG);
    });
    const published = (nostrService.signAndPublishEvent as jest.Mock).mock.calls[0][0];
    expect(published.tags.filter((t: string[]) => t[0] === 'p').map((t: string[]) => t[1])).toEqual(
      [LITTLE],
    );
  });
});

it('publishes the follow list to the write relays and the indexers that store kind 3', async () => {
  mockFetch.mockResolvedValue({
    status: 'found',
    base: { tags: [['p', BIG]], content: '', createdAt: 10 },
  });
  const { result } = setup([]);
  await act(async () => {
    await result.current.followContact(NEW);
  });
  const targets = (nostrService.signAndPublishEvent as jest.Mock).mock.calls[0][2];
  expect(targets).toEqual(['wss://mine', 'wss://purplepag.es', 'wss://user.kindpag.es']);
});

it('an account switch during the publish-target lookup never asks the signer', async () => {
  mockFetch.mockResolvedValue({
    status: 'found',
    base: { tags: [['p', BIG]], content: '', createdAt: 10 },
  });
  const sign = jest.spyOn(amberService, 'requestEventSignature');
  // The indexer kind check is the await before signing: switch accounts there.
  (relayAllowsKind as jest.Mock).mockImplementationOnce(async () => {
    clearFollowGateStores();
    return true;
  });
  const { result } = renderHook(() =>
    useContactActions({
      pubkey: ME,
      isLoggedIn: true,
      signerType: 'amber',
      relays,
      contacts: [],
      setContacts: jest.fn(),
      getReadRelays: () => ['wss://mine'],
      loadContacts: jest.fn(async () => {}),
    }),
  );
  let ok = true;
  await act(async () => {
    ok = await result.current.followContact(NEW);
  });
  expect(ok).toBe(false);
  expect(sign).not.toHaveBeenCalled();
  expect(nostrService.publishSignedEvent).not.toHaveBeenCalled();
});

describe('remote-signed follow list (#1779)', () => {
  const accountKey = generateSecretKey();
  const account = getPublicKey(accountKey);

  async function followWithAmberSigningAs(signingKey: Uint8Array, restampBy = 0) {
    mockFetch.mockResolvedValue({
      status: 'found',
      base: { tags: [['p', BIG]], content: '', createdAt: 10 },
    });
    jest.spyOn(amberService, 'requestEventSignature').mockImplementation(async (eventJson) => {
      const template = JSON.parse(eventJson);
      const stamped = { ...template, created_at: template.created_at + restampBy };
      return { event: JSON.stringify(finalizeEvent(stamped, signingKey)), signature: '' };
    });
    const setContacts = jest.fn();
    const { result } = renderHook(() =>
      useContactActions({
        pubkey: account,
        isLoggedIn: true,
        signerType: 'amber',
        relays,
        contacts: [],
        setContacts,
        getReadRelays: () => ['wss://mine'],
        loadContacts: jest.fn(async () => {}),
      }),
    );
    let ok = false;
    await act(async () => {
      ok = await result.current.followContact(NEW);
    });
    return { ok, setContacts, result };
  }

  it('never publishes or adopts a follow list Amber signed with another account', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { ok, setContacts } = await followWithAmberSigningAs(generateSecretKey());
    expect(ok).toBe(false);
    expect(nostrService.publishSignedEvent).not.toHaveBeenCalled();
    expect(setContacts).not.toHaveBeenCalled();
  });

  it('publishes the follow list Amber signed with the active account', async () => {
    const { ok } = await followWithAmberSigningAs(accountKey);
    expect(ok).toBe(true);
    const published = jest.mocked(nostrService.publishSignedEvent).mock.calls[0][0];
    expect(published.pubkey).toBe(account);
    expect(published.tags.some((tag) => tag[0] === 'p' && tag[1] === NEW)).toBe(true);
  });

  it('adopts the id and created_at the signer actually published when it restamps', async () => {
    const adopt = jest.spyOn(contactFollowFreshness, 'adoptFollowSnapshot');
    const { ok, result } = await followWithAmberSigningAs(accountKey, 7);
    expect(ok).toBe(true);
    const published = jest.mocked(nostrService.publishSignedEvent).mock.calls[0][0];
    const template = JSON.parse(jest.mocked(amberService.requestEventSignature).mock.calls[0][0]);
    expect(published.created_at).toBe(template.created_at + 7);
    expect(adopt.mock.calls[0][1]).toMatchObject({
      createdAt: published.created_at,
      id: published.id,
    });
    // The next write builds on the published timestamp, not the template's.
    await act(async () => {
      await result.current.followContact(LITTLE);
    });
    const next = mockPrepareArgs.mock.calls.at(-1)?.[0] as {
      lastPublished?: { createdAt: number };
    };
    expect(next.lastPublished?.createdAt).toBe(published.created_at);
  });
});
