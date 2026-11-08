import AsyncStorage from '@react-native-async-storage/async-storage';
import { getPublicKey } from 'nostr-tools/pure';
import {
  checkDefaultDmInbox,
  chooseDefaultDmInboxRelays,
  MAX_DEFAULT_INBOX_RELAYS,
  publishDefaultDmInbox,
  publishNewAccountDmInbox,
  readDefaultDmInboxState,
  type DmInboxCheckParams,
  type PublishDefaultParams,
} from './defaultDmInbox';
import { lookupOwnList } from '../services/relayListAuthority';
import { publishToRelays } from '../services/nostrRelayLists';
import { readAdoptedCreatedAt } from './useNip65Relays';
import { setCurrentUserPubkey } from '../services/nostrActiveAccount';
import { perAccountKey } from '../services/perAccountStorage';
import { loadAppRelayPrefs } from '../services/appRelayPrefs';
import { TEST_ACCOUNT_PUBKEYS, TEST_RELAY_URL } from '../config/testRelayLockdown';
import { DEFAULT_RELAYS } from '../services/nostrRelayDefaults';
import { RELAY_LIST_INDEXERS } from '../utils/relayListEvents';
import {
  CONTACTS_CACHE_KEY_BASE,
  DM_INBOX_DEFAULT_BACKOFF_KEY_BASE,
  DM_INBOX_DEFAULT_STATE_KEY_BASE,
  DM_INBOX_RELAYS_CACHE_KEY_BASE,
  OWN_PROFILE_CACHE_KEY_BASE,
} from './nostrCacheKeys';
import type { SignedEvent } from './nostrContextTypes';

jest.mock('../services/relayListAuthority', () => ({ lookupOwnList: jest.fn() }));
jest.mock('../services/nostrRelayLists', () => ({ publishToRelays: jest.fn() }));
jest.mock('./useNip65Relays', () => ({ readAdoptedCreatedAt: jest.fn(async () => 0) }));
jest.mock('../services/relayHealth', () => ({ isRelayParked: jest.fn(() => false) }));
jest.mock('../services/nostrService', () => ({
  signEvent: (e: object, sk: Uint8Array) =>
    jest.requireActual('nostr-tools/pure').finalizeEvent(e, sk),
}));

const PK = 'a'.repeat(64);
const NOW = 1_700_000_000_000;
const WRITE = 'wss://my-write.example';
const DAY = 24 * 3600_000;
const lookup = lookupOwnList as jest.Mock;
const publish = publishToRelays as jest.Mock;
const baseline = readAdoptedCreatedAt as jest.Mock;
type Unsigned = { kind: number; created_at: number; tags: string[][]; content: string };
const sign = jest.fn(
  async (e: Unsigned) => ({ ...e, id: 'id', sig: 'sig', pubkey: PK }) as SignedEvent,
);
const adopt = jest.fn(async () => ({ adopted: true, baseline: 0 }));
const adoptRelayList = jest.fn(async () => ({ adopted: true, baseline: 0 }));
const acceptAll = async (_e: unknown, targets: string[]) =>
  targets.map((url) => ({ url, ok: true }));
/** Only these relays accept the publish. */
const acceptOnly =
  (...ok: string[]) =>
  async (_e: unknown, targets: string[]) =>
    targets.map((url) => ({ url, ok: ok.includes(url) }));
const byKind = (statuses: Record<number, unknown>) =>
  lookup.mockImplementation(async (_pk, kind: number) => statuses[kind] ?? { status: 'absent' });
const lookupsOf = (kind: number) => lookup.mock.calls.filter((c) => c[1] === kind);
const stateOf = (pk = PK) => readDefaultDmInboxState(pk);
const backoffRaw = () => AsyncStorage.getItem(perAccountKey(DM_INBOX_DEFAULT_BACKOFF_KEY_BASE, PK));

const nip65 = [
  { url: 'wss://my-read.example', read: true, write: false },
  { url: WRITE, read: false, write: true },
];
const checkParams = (over: Partial<DmInboxCheckParams> = {}): DmInboxCheckParams => ({
  pubkey: PK,
  nip65Relays: nip65,
  readRelays: ['wss://my-read.example', ...DEFAULT_RELAYS],
  knownInbox: () => [],
  adopt,
  adoptRelayList,
  session: 7,
  isActive: () => true,
  now: () => NOW,
  ...over,
});
const publishParams = (over: Partial<PublishDefaultParams> = {}): PublishDefaultParams => ({
  ...checkParams(),
  sign,
  retryDelaysMs: [1000, 2000],
  ...over,
});
/** A 10002 found fresh on the relays, with this write relay. */
const freshList = (write = WRITE) => ({
  10002: {
    status: 'found',
    event: {
      created_at: 50,
      tags: [
        ['r', 'wss://my-read.example', 'read'],
        ['r', write, 'write'],
      ],
    },
  },
});

beforeEach(async () => {
  jest.clearAllMocks();
  jest.useRealTimers();
  await AsyncStorage.clear();
  byKind(freshList());
  publish.mockImplementation(acceptAll);
  baseline.mockResolvedValue(0);
  setCurrentUserPubkey(null);
});

describe('onboarding: an account created in the app', () => {
  const secretKey = new Uint8Array(32).fill(9);
  const newPk = getPublicKey(secretKey);
  beforeEach(async () => {
    setCurrentUserPubkey(newPk);
    // As onboarding does before publishing (defaults stay closed until then).
    await loadAppRelayPrefs(newPk);
  });

  it('publishes once, with no lookup (the key is brand new)', async () => {
    expect(
      await publishNewAccountDmInbox({ pubkey: newPk, secretKey, adopt, now: () => NOW }),
    ).toBe('published');
    expect(lookup).not.toHaveBeenCalled();
    expect(publish).toHaveBeenCalledTimes(1);
    const [event, targets] = publish.mock.calls[0];
    expect(event).toMatchObject({ kind: 10050, pubkey: newPk, created_at: NOW / 1000 });
    expect(event.tags).toEqual(DEFAULT_RELAYS.slice(0, 3).map((u) => ['relay', u]));
    expect(targets).toEqual(expect.arrayContaining([...DEFAULT_RELAYS, ...RELAY_LIST_INDEXERS]));
    expect(adopt).toHaveBeenCalledWith(newPk, DEFAULT_RELAYS.slice(0, 3), NOW / 1000);
    expect(await stateOf(newPk)).toBe('published');
  });

  it('retries the SAME event within the session until an indexer or two relays have it', async () => {
    jest.useFakeTimers();
    publish.mockImplementation(acceptOnly()); // nothing at first
    const outcome = publishNewAccountDmInbox({
      pubkey: newPk,
      secretKey,
      adopt,
      retryDelaysMs: [1000, 2000, 4000],
    });
    expect(await outcome).toBe('none-accepted');
    expect(adopt).not.toHaveBeenCalled();
    publish.mockImplementation(acceptOnly(DEFAULT_RELAYS[0])); // one relay: not yet
    await jest.advanceTimersByTimeAsync(1000);
    expect(adopt).toHaveBeenCalledTimes(1); // live now: the app reads it
    publish.mockImplementation(acceptOnly('wss://purplepag.es')); // the indexer: done
    await jest.advanceTimersByTimeAsync(2000);
    await jest.advanceTimersByTimeAsync(10_000);
    expect(publish).toHaveBeenCalledTimes(3);
    const events = publish.mock.calls.map((c) => c[0]);
    expect(new Set(events.map((e) => e.id)).size).toBe(1); // never re-signed
    // Each retry only goes to the relays that haven't accepted it.
    expect(publish.mock.calls[2][1]).not.toContain(DEFAULT_RELAYS[0]);
    expect(await stateOf(newPk)).toBe('published');
  });

  it('gives up quietly after the in-session retries, keeping nothing', async () => {
    jest.useFakeTimers();
    publish.mockImplementation(acceptOnly());
    await publishNewAccountDmInbox({ pubkey: newPk, secretKey, adopt, retryDelaysMs: [10, 20] });
    await jest.advanceTimersByTimeAsync(1000);
    expect(publish).toHaveBeenCalledTimes(3);
    expect(await stateOf(newPk)).toBeNull();
    expect(jest.getTimerCount()).toBe(0);
  });

  it('stops retrying after an account switch', async () => {
    jest.useFakeTimers();
    publish.mockImplementation(acceptOnly(DEFAULT_RELAYS[0]));
    await publishNewAccountDmInbox({ pubkey: newPk, secretKey, adopt, retryDelaysMs: [1000] });
    setCurrentUserPubkey(PK);
    await jest.advanceTimersByTimeAsync(5000);
    expect(publish).toHaveBeenCalledTimes(1);
  });
});

describe('background check: never publishes for an existing account', () => {
  it('an imported nsec (or any signer) only gets a suggestion recorded', async () => {
    expect(await checkDefaultDmInbox(checkParams())).toBe('suggested');
    expect(publish).not.toHaveBeenCalled();
    expect(await stateOf()).toBe('suggest');
  });

  it("always looks the 10002 up fresh, requiring the cached list's write relays", async () => {
    await checkDefaultDmInbox(checkParams());
    expect(lookupsOf(10002)).toHaveLength(1);
    expect(lookupsOf(10002)[0][2]).toEqual({
      required: [WRITE],
      indexers: RELAY_LIST_INDEXERS,
      bestEffort: DEFAULT_RELAYS,
    });
  });

  it('a fresh 10002 adds its write relays (with the cached ones) to the 10050 check', async () => {
    byKind(freshList('wss://moved-to.example'));
    await checkDefaultDmInbox(checkParams());
    expect(adoptRelayList).toHaveBeenCalledWith(PK, expect.any(Array), 50);
    expect(lookupsOf(10050)[0][2].required).toEqual(['wss://moved-to.example', WRITE]);
  });

  it('a fresh 10002 the app refuses (a newer list is held) makes the check unknown', async () => {
    byKind(freshList('wss://stale-write.example'));
    const refused = jest.fn(async () => ({ adopted: false, baseline: 999 }));
    expect(await checkDefaultDmInbox(checkParams({ adoptRelayList: refused }))).toBe('unknown');
    expect(lookupsOf(10050)).toHaveLength(0);
    expect(await stateOf()).toBeNull();
  });

  it('a 10050 found is adopted (session-bound) and recorded, with no suggestion', async () => {
    byKind({
      ...freshList(),
      10050: { status: 'found', event: { created_at: 500, tags: [['relay', 'wss://x.example']] } },
    });
    expect(await checkDefaultDmInbox(checkParams())).toBe('exists');
    expect(adopt).toHaveBeenCalledWith(PK, ['wss://x.example'], 500, 7);
    expect(await stateOf()).toBe('exists');
  });

  it.each([
    ['in memory', () => ({ knownInbox: () => ['wss://live.example'] })],
    ['adopted in memory', () => ({ knownInboxCreatedAt: () => 5 })],
  ])('a list already known %s settles it without asking relays', async (_l, over) => {
    expect(await checkDefaultDmInbox(checkParams(over()))).toBe('exists');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('a cached (even intentionally empty) inbox list is a list', async () => {
    await AsyncStorage.setItem(perAccountKey(DM_INBOX_RELAYS_CACHE_KEY_BASE, PK), '[]');
    expect(await checkDefaultDmInbox(checkParams())).toBe('exists');
    expect(lookup).not.toHaveBeenCalled();
  });

  it('once recorded, it does not check again', async () => {
    await checkDefaultDmInbox(checkParams());
    expect(await checkDefaultDmInbox(checkParams())).toBe('settled');
    expect(lookupsOf(10050)).toHaveLength(1);
  });
});

describe('no 10002 anywhere (most existing Lightning Piggy users)', () => {
  const noList = { 10002: { status: 'absent' } };
  const withProfile = async () => {
    await AsyncStorage.setItem(
      perAccountKey(OWN_PROFILE_CACHE_KEY_BASE, PK),
      JSON.stringify({ name: 'Little Piggy' }),
    );
    await AsyncStorage.setItem(
      perAccountKey(CONTACTS_CACHE_KEY_BASE, PK),
      JSON.stringify([{ pubkey: 'c'.repeat(64) }]),
    );
  };

  it('a profile and follows with no 10002 still get the card when the 10050 is provably absent', async () => {
    await withProfile();
    byKind({ ...noList, 0: { status: 'found', event: {} }, 3: { status: 'found', event: {} } });
    expect(await checkDefaultDmInbox(checkParams({ nip65Relays: [] }))).toBe('suggested');
    // No kind 0 / 3 rule any more; the strict 10050 check ran on the indexers + defaults.
    expect(lookupsOf(0)).toHaveLength(0);
    expect(lookupsOf(3)).toHaveLength(0);
    expect(lookupsOf(10050)[0][2]).toEqual({
      required: [],
      indexers: RELAY_LIST_INDEXERS,
      bestEffort: DEFAULT_RELAYS,
    });
    expect(publish).not.toHaveBeenCalled();
  });

  it('write relays the app knows (cached) are still required for the 10050 check', async () => {
    byKind(noList);
    expect(await checkDefaultDmInbox(checkParams())).toBe('suggested');
    expect(lookupsOf(10050)[0][2].required).toEqual([WRITE]);
  });

  it("a 10050 that can't be proven absent: no card", async () => {
    await withProfile();
    byKind({ ...noList, 10050: { status: 'unknown' } });
    expect(await checkDefaultDmInbox(checkParams({ nip65Relays: [] }))).toBe('unknown');
    expect(await stateOf()).toBeNull();
  });

  it('Publish re-runs the full check; a list it finds wins', async () => {
    await withProfile();
    byKind({
      ...noList,
      10050: { status: 'found', event: { created_at: 3, tags: [['relay', 'wss://z.example']] } },
    });
    expect(await publishDefaultDmInbox(publishParams({ nip65Relays: [] }))).toBe('exists');
    expect(lookupsOf(10002)).toHaveLength(1);
    expect(adopt).toHaveBeenCalledWith(PK, ['wss://z.example'], 3, 7);
    expect(sign).not.toHaveBeenCalled();
    // ...and with none found, it publishes.
    lookup.mockClear();
    byKind(noList);
    expect(await publishDefaultDmInbox(publishParams({ nip65Relays: [] }))).toBe('published');
    expect(lookupsOf(10002)).toHaveLength(1);
    expect(lookupsOf(10050)).toHaveLength(1);
    expect(sign).toHaveBeenCalledTimes(1);
  });
});

describe('unreadable storage fails closed and writes nothing', () => {
  const corrupt = (base: string) => AsyncStorage.setItem(perAccountKey(base, PK), '{not json');

  it.each([
    ['the inbox cache', () => corrupt(DM_INBOX_RELAYS_CACHE_KEY_BASE)],
    ['the backoff record', () => corrupt(DM_INBOX_DEFAULT_BACKOFF_KEY_BASE)],
    [
      'the state',
      () => AsyncStorage.setItem(perAccountKey(DM_INBOX_DEFAULT_STATE_KEY_BASE, PK), 'garbage'),
    ],
    [
      'the adopted created_at',
      async () => {
        baseline.mockRejectedValue(new Error('io error'));
      },
    ],
  ])('%s: no card, no state, no backoff', async (_l, setup) => {
    await setup();
    const stateBefore = await AsyncStorage.getItem(
      perAccountKey(DM_INBOX_DEFAULT_STATE_KEY_BASE, PK),
    );
    const backoffBefore = await backoffRaw();
    expect(await checkDefaultDmInbox(checkParams())).toBe('unreadable');
    expect(await AsyncStorage.getItem(perAccountKey(DM_INBOX_DEFAULT_STATE_KEY_BASE, PK))).toBe(
      stateBefore,
    );
    expect(await backoffRaw()).toBe(backoffBefore);
  });

  it('on Publish: nothing signed', async () => {
    baseline.mockRejectedValue(new Error('io error'));
    expect(await publishDefaultDmInbox(publishParams())).toBe('unreadable');
    expect(sign).not.toHaveBeenCalled();
  });
});

describe('backoff after inconclusive checks', () => {
  it('after 3 unknowns in a row it waits 7 days; a decisive result resets it', async () => {
    byKind({ 10002: { status: 'unknown' } });
    for (let i = 0; i < 3; i++) expect(await checkDefaultDmInbox(checkParams())).toBe('unknown');
    lookup.mockClear();
    expect(await checkDefaultDmInbox(checkParams({ now: () => NOW + 6 * DAY }))).toBe('backoff');
    expect(lookup).not.toHaveBeenCalled();
    byKind(freshList());
    expect(await checkDefaultDmInbox(checkParams({ now: () => NOW + 8 * DAY }))).toBe('suggested');
    expect(await backoffRaw()).toBeNull();
  });
});

describe('Publish (the user tapped it), for any signer', () => {
  it.each(['nsec', 'amber', 'nip46'])(
    '%s: re-runs the check with a FRESH 10002, then signs and publishes',
    async () => {
      expect(await publishDefaultDmInbox(publishParams())).toBe('published');
      expect(lookupsOf(10002)).toHaveLength(1);
      expect(lookupsOf(10050)).toHaveLength(1);
      expect(sign).toHaveBeenCalledTimes(1);
      const event = sign.mock.calls[0][0];
      const listed = ['wss://my-read.example', DEFAULT_RELAYS[0], DEFAULT_RELAYS[1]];
      expect(event).toMatchObject({ kind: 10050, created_at: NOW / 1000 });
      expect(event.tags).toEqual(listed.map((u) => ['relay', u]));
      expect(publish.mock.calls[0][1]).toEqual(
        expect.arrayContaining([WRITE, ...DEFAULT_RELAYS, ...RELAY_LIST_INDEXERS]),
      );
      expect(adopt).toHaveBeenCalledWith(PK, listed, NOW / 1000, 7);
      expect(await stateOf()).toBe('published');
    },
  );

  it('a list found on Publish is adopted and shown instead: nothing signed', async () => {
    byKind({
      ...freshList(),
      10050: { status: 'found', event: { created_at: 9, tags: [['relay', 'wss://y.example']] } },
    });
    expect(await publishDefaultDmInbox(publishParams())).toBe('exists');
    expect(adopt).toHaveBeenCalledWith(PK, ['wss://y.example'], 9, 7);
    expect(sign).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
  });

  it("can't prove absence: nothing signed", async () => {
    byKind({ 10002: { status: 'unknown' } });
    expect(await publishDefaultDmInbox(publishParams())).toBe('unknown');
    expect(sign).not.toHaveBeenCalled();
  });

  it('a list adopted during the lookup aborts before signing', async () => {
    let inbox: string[] = [];
    lookup.mockImplementation(async (_pk, kind: number) => {
      if (kind === 10050) inbox = ['wss://hydrated.example'];
      return kind === 10002 ? freshList()[10002] : { status: 'absent' };
    });
    expect(await publishDefaultDmInbox(publishParams({ knownInbox: () => inbox }))).toBe('exists');
    expect(sign).not.toHaveBeenCalled();
  });

  it('a list adopted while the signer was open: nothing published', async () => {
    let inbox: string[] = [];
    sign.mockImplementationOnce(async (e: Unsigned) => {
      inbox = ['wss://elsewhere.example'];
      return { ...e, id: 'id', sig: 'sig', pubkey: PK } as SignedEvent;
    });
    expect(await publishDefaultDmInbox(publishParams({ knownInbox: () => inbox }))).toBe('exists');
    expect(publish).not.toHaveBeenCalled();
  });

  it("an account switch mid-publish leaves the new account's state untouched", async () => {
    let active = true;
    publish.mockImplementationOnce(async (_e: unknown, targets: string[]) => {
      active = false;
      return targets.map((url) => ({ url, ok: true }));
    });
    expect(await publishDefaultDmInbox(publishParams({ isActive: () => active }))).toBe('inactive');
    expect(adopt).not.toHaveBeenCalled();
  });

  it('declined, wrong key, or nothing accepted: no adoption', async () => {
    sign.mockResolvedValueOnce(null as unknown as SignedEvent);
    expect(await publishDefaultDmInbox(publishParams())).toBe('not-signed');
    sign.mockResolvedValueOnce({ pubkey: 'b'.repeat(64), tags: [] } as unknown as SignedEvent);
    expect(await publishDefaultDmInbox(publishParams())).toBe('inactive');
    publish.mockImplementation(acceptOnly());
    expect(await publishDefaultDmInbox(publishParams())).toBe('none-accepted');
    expect(adopt).not.toHaveBeenCalled();
  });

  it('short of quorum: partial, then re-sent this session', async () => {
    jest.useFakeTimers();
    publish.mockImplementation(acceptOnly(DEFAULT_RELAYS[0]));
    expect(await publishDefaultDmInbox(publishParams())).toBe('partial');
    expect(adopt).toHaveBeenCalledTimes(1);
    publish.mockImplementation(acceptOnly('wss://purplepag.es'));
    await jest.advanceTimersByTimeAsync(1000);
    expect(publish).toHaveBeenCalledTimes(2);
    expect(publish.mock.calls[1][0]).toBe(publish.mock.calls[0][0]);
  });

  describe('relays changed since the card was shown', () => {
    const shown = ['wss://my-read.example', DEFAULT_RELAYS[0], DEFAULT_RELAYS[1]];
    const fresh = ['wss://moved-read.example', DEFAULT_RELAYS[0], DEFAULT_RELAYS[1]];
    // The fresh 10002 now has another read relay (which the app reads).
    beforeEach(() =>
      byKind({
        10002: {
          status: 'found',
          event: {
            created_at: 50,
            tags: [
              ['r', 'wss://moved-read.example', 'read'],
              ['r', WRITE, 'write'],
            ],
          },
        },
      }),
    );
    const withFresh = { readRelays: ['wss://moved-read.example', ...DEFAULT_RELAYS] };

    it('unchanged: no confirm needed', async () => {
      byKind(freshList());
      const confirm = jest.fn(async () => true);
      expect(
        await publishDefaultDmInbox(publishParams({ shownRelays: [...shown].reverse(), confirm })),
      ).toBe('published');
      expect(confirm).not.toHaveBeenCalled();
    });

    it('changed and not confirmed: cancelled, nothing signed', async () => {
      const confirm = jest.fn(async () => false);
      expect(
        await publishDefaultDmInbox(publishParams({ ...withFresh, shownRelays: shown, confirm })),
      ).toBe('cancelled');
      expect(confirm).toHaveBeenCalledWith(fresh);
      expect(sign).not.toHaveBeenCalled();
    });

    it('changed and confirmed: publishes exactly the confirmed list', async () => {
      const confirm = jest.fn(async () => true);
      expect(
        await publishDefaultDmInbox(publishParams({ ...withFresh, shownRelays: shown, confirm })),
      ).toBe('published');
      expect(sign.mock.calls[0][0].tags).toEqual(fresh.map((u) => ['relay', u]));
    });

    it('changed with no way to confirm: cancelled', async () => {
      expect(await publishDefaultDmInbox(publishParams({ ...withFresh, shownRelays: shown }))).toBe(
        'cancelled',
      );
      expect(sign).not.toHaveBeenCalled();
    });
  });

  it('a test account in lockdown lists and publishes the LAN test relay only', async () => {
    const testPk = [...TEST_ACCOUNT_PUBKEYS][0];
    setCurrentUserPubkey(testPk);
    const testSign = jest.fn(
      async (e: Unsigned) => ({ ...e, id: 'id', sig: 'sig', pubkey: testPk }) as SignedEvent,
    );
    expect(
      await publishDefaultDmInbox(
        publishParams({ pubkey: testPk, sign: testSign, readRelays: [TEST_RELAY_URL] }),
      ),
    ).toBe('published');
    expect(testSign.mock.calls[0][0].tags).toEqual([['relay', TEST_RELAY_URL]]);
    expect(publish.mock.calls[0][1]).toEqual([TEST_RELAY_URL]);
  });
});

describe('chooseDefaultDmInboxRelays', () => {
  const rows = [
    { url: 'wss://mine.example/', read: true, write: true },
    { url: 'wss://write-only.example', read: false, write: true },
  ];
  it('prefers own read relays, then defaults; public, read and healthy only; capped', () => {
    const chosen = chooseDefaultDmInboxRelays({
      nip65: rows,
      readRelays: ['wss://mine.example', 'ws://localhost:7777', ...DEFAULT_RELAYS],
      defaults: DEFAULT_RELAYS,
      isParked: (url) => url === DEFAULT_RELAYS[0],
    });
    expect(chosen).toEqual(['wss://mine.example', DEFAULT_RELAYS[1], DEFAULT_RELAYS[2]]);
    expect(chosen).toHaveLength(MAX_DEFAULT_INBOX_RELAYS);
  });

  it('never lists a relay the app does not read gift wraps from', () => {
    expect(
      chooseDefaultDmInboxRelays({
        nip65: rows,
        readRelays: ['wss://mine.example'],
        defaults: DEFAULT_RELAYS,
        isParked: () => false,
      }),
    ).toEqual(['wss://mine.example']);
  });
});
