// The background / headless DM watch follows the account's Web of Trust tier
// for notifications, read from per-account storage (no React tree), while
// storage keeps the follow gate.
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  runBackgroundDmWatch,
  stopBackgroundDmWatch,
  __resetForTests,
} from './backgroundDmService';
import { __resetForTests as __resetDedupeForTests } from './dmWrapNotificationDedupe';
import { storeDecryptedWrap } from './backgroundDmIngest';
import { perAccountKey } from './perAccountStorage';
import { CONTACTS_CACHE_KEY_BASE } from '../contexts/nostrCacheKeys';
import { WOT_STORAGE_KEY_BASE, type WotTier } from './wotSettingsService';
import { FOF_SHARED_MAX, persistFofCache, __resetFofMemory } from './friendsOfFriendsService';
import { __resetNotificationAudiences, publishNotificationAudience } from './notificationAudience';

jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn().mockResolvedValue(null) }));
const mockSubscribe = jest.fn();
const mockLoadIdentities = jest.fn();
const mockFireMessageNotification = jest.fn().mockResolvedValue('id');
let mockSender = '';
let mockReplied = new Set<string>();
jest.mock('react-native', () => ({ Platform: { OS: 'android' } }));
jest.mock('nostr-tools/nip44', () => ({}));
jest.mock('./identitiesStore', () => ({ loadIdentities: () => mockLoadIdentities() }));
jest.mock('./safetySettingsMigration', () => ({
  ...jest.requireActual('./safetySettingsMigration'),
  ensureSafetySettingsMigrated: () => Promise.resolve(),
}));
jest.mock('./nostrRelayStorage', () => ({
  getUserRelays: () => Promise.resolve([{ url: 'wss://r.example', read: true, write: true }]),
  mergeRelays: jest.requireActual('./nostrRelayStorage').mergeRelays,
}));
jest.mock('./nostrService', () => ({
  decodeNsec: () => ({ pubkey: mockActive, secretKey: new Uint8Array(32) }),
  fetchProfile: jest.fn().mockResolvedValue(null),
  DEFAULT_RELAYS: ['wss://default.example'],
}));
jest.mock('./dmLiveSubscription', () => ({
  subscribeInboxDmsForViewer: (...a: unknown[]) => mockSubscribe(...a),
}));
jest.mock('./notificationService', () => ({
  fireMessageNotification: (...a: unknown[]) => mockFireMessageNotification(...a),
  hasNotificationPermission: () => Promise.resolve(true),
  showForegroundServiceNotification: jest.fn().mockResolvedValue('fg'),
  dismissForegroundServiceNotification: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./zapSenderProfileStorage', () => ({
  peekSync: () => ({ name: 'Bob' }),
  get: jest.fn().mockResolvedValue(null),
}));
jest.mock('../utils/nip17Unwrap', () => ({
  unwrapWrapNsec: () => ({
    kind: 14,
    pubkey: mockSender,
    created_at: Math.floor(Date.now() / 1000),
    content: 'hi',
    tags: mockSubject ? [['subject', mockSubject]] : [],
  }),
  partnerFromRumor: () => ({ partnerPubkey: mockSender, fromMe: false }),
  subjectFromRumor: jest.requireActual('../utils/nip17Unwrap').subjectFromRumor,
  textForRumor: () => 'hi',
}));
let mockSubject: string | null = null;
jest.mock('./backgroundDmIngest', () => ({
  ...jest.requireActual('./backgroundDmIngest'),
  storeDecryptedWrap: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./dmRepliedPartners', () => ({
  loadRepliedPartners: () => Promise.resolve(),
  hasRepliedTo: (_owner: string, partner: string) => mockReplied.has(partner),
}));
jest.mock('./backgroundPaymentService', () => ({
  canWatchBackgroundPayments: () => Promise.resolve(false),
  isBackgroundPaymentWatchRunning: () => false,
  startBackgroundPaymentWatch: jest.fn(),
  stopBackgroundPaymentWatch: jest.fn(),
}));
jest.mock('./backgroundDmPreference', () => ({ loadBackgroundDmEnabled: jest.fn() }));

const ME = 'a'.repeat(64);
const OTHER = 'e'.repeat(64);
const FRIEND = 'b'.repeat(64);
const FOF = 'c'.repeat(64);
const STRANGER = 'd'.repeat(64);
let mockActive = ME;

/** `tier` is an explicit pick unless `explicit: false` (the #627 default / a migrated tier). */
async function seedAccount(
  owner: string,
  tier: WotTier | null,
  fof: string[] | null,
  explicit = true,
  contactsCache = true,
) {
  if (contactsCache)
    await AsyncStorage.setItem(
      perAccountKey(CONTACTS_CACHE_KEY_BASE, owner),
      JSON.stringify([{ pubkey: FRIEND }]),
    );
  if (tier)
    await AsyncStorage.setItem(
      perAccountKey(WOT_STORAGE_KEY_BASE, owner),
      JSON.stringify(explicit ? { wotTier: tier, explicit } : { wotTier: tier }),
    );
  if (fof)
    await persistFofCache(
      owner,
      [FRIEND],
      { set: new Set(fof), excludedFriends: 0, computedAt: Date.now() },
      FOF_SHARED_MAX,
    );
  // The headless watch reads storage, not the app's in-memory set.
  __resetFofMemory();
}

async function arm(owner: string) {
  mockActive = owner;
  mockLoadIdentities.mockResolvedValue({
    identities: [{ pubkey: owner, signerType: 'nsec', nsec: 'nsec1xxx', lastUsedAt: 1 }],
    activePubkey: owner,
  });
  expect(await runBackgroundDmWatch()).toBe(true);
}

let wrapSeq = 0;
/** Deliver a fresh wrap from `sender`; true when it raised a notification. */
async function notifies(sender: string): Promise<boolean> {
  mockSender = sender;
  const before = mockFireMessageNotification.mock.calls.length;
  const call = mockSubscribe.mock.calls.at(-1)?.[0] as { onEvent: (ev: unknown) => void };
  call.onEvent({ id: `w${++wrapSeq}`, kind: 1059, pubkey: 'f'.repeat(64), tags: [], content: '' });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
  return mockFireMessageNotification.mock.calls.length > before;
}

beforeEach(async () => {
  jest.clearAllMocks();
  __resetForTests();
  __resetDedupeForTests();
  __resetNotificationAudiences();
  __resetFofMemory();
  mockReplied = new Set();
  mockSubject = null;
  await AsyncStorage.clear();
  mockSubscribe.mockReturnValue(() => {});
});

afterEach(async () => {
  await stopBackgroundDmWatch();
});

describe.each<[WotTier, boolean, boolean]>([
  // tier, friend-of-a-friend notifies, stranger notifies
  ['friends', false, false],
  ['fof', true, false],
  ['all', true, true],
])('stored tier %s', (tier, fofNotifies, strangerNotifies) => {
  it('notifies per the tier; stores only the friend', async () => {
    await seedAccount(ME, tier, [FOF]);
    await arm(ME);
    expect(await notifies(FRIEND)).toBe(true);
    expect(await notifies(FOF)).toBe(fofNotifies);
    expect(await notifies(STRANGER)).toBe(strangerNotifies);
    expect(jest.mocked(storeDecryptedWrap).mock.calls.map((c) => c[2].pubkey)).toEqual([FRIEND]);
  });
});

it('the tier never widens room messages: a subject from an unfollowed sender stays silent', async () => {
  await seedAccount(ME, 'all', null);
  await arm(ME);
  mockSubject = 'Book club';
  expect(await notifies(STRANGER)).toBe(false);
  expect(await notifies(FRIEND)).toBe(true); // as before, for a followed sender
  mockSubject = null;
  expect(await notifies(STRANGER)).toBe(true);
});

it('an unchosen tier notifies like Friends: nothing stored, or an unchosen All', async () => {
  await seedAccount(ME, null, [FOF]);
  await arm(ME);
  expect(await notifies(FRIEND)).toBe(true);
  expect(await notifies(FOF)).toBe(false);
  expect(await notifies(STRANGER)).toBe(false);
  // The #627 default / a migrated 'all', saved without the explicit marker.
  await seedAccount(ME, 'all', [FOF], false);
  await arm(ME);
  expect(await notifies(STRANGER)).toBe(false);
  // Chosen in the sheet: everyone.
  await seedAccount(ME, 'all', [FOF]);
  await arm(ME);
  expect(await notifies(STRANGER)).toBe(true);
});

it('friends of friends with no cached set falls back to follows only', async () => {
  await seedAccount(ME, 'fof', null);
  await arm(ME);
  expect(await notifies(FRIEND)).toBe(true);
  expect(await notifies(FOF)).toBe(false);
  expect(await notifies(STRANGER)).toBe(false);
});

it('a failed tier read fails closed to follows only', async () => {
  await seedAccount(ME, 'all', null);
  // The storage mock's getItem is itself a jest.fn: swap its implementation
  // and put the original back (mockRestore would leave it blank).
  const getItem = jest.mocked(AsyncStorage.getItem);
  const original = getItem.getMockImplementation()!;
  getItem.mockImplementation(async (key: string, ...rest) => {
    if (key.startsWith(WOT_STORAGE_KEY_BASE)) throw new Error('disk');
    return original(key, ...rest);
  });
  try {
    await arm(ME);
    expect(await notifies(FRIEND)).toBe(true);
    expect(await notifies(STRANGER)).toBe(false);
  } finally {
    getItem.mockImplementation(original);
  }
});

it("reads the active account's tier and set, never another account's", async () => {
  await seedAccount(ME, 'fof', null);
  await seedAccount(OTHER, 'all', [FOF]);
  await arm(ME);
  expect(await notifies(FOF)).toBe(false);
  expect(await notifies(STRANGER)).toBe(false);
  await arm(OTHER);
  expect(await notifies(STRANGER)).toBe(true);
});

it("the app's live tier wins in the same context, so a change applies without re-arming", async () => {
  await seedAccount(ME, 'friends', [FOF]);
  await arm(ME);
  expect(await notifies(STRANGER)).toBe(false);
  publishNotificationAudience(ME, { tier: 'all', fof: null });
  expect(await notifies(STRANGER)).toBe(true);
  publishNotificationAudience(ME, { tier: 'fof', fof: new Set([FOF]) });
  expect(await notifies(STRANGER)).toBe(false);
  expect(await notifies(FOF)).toBe(true);
});

describe('no contacts cache (fresh install / unreadable): fails closed (#1764)', () => {
  const REPLIED = 'f'.repeat(64);
  it('unchosen tier: a stranger stays silent, a replied partner alerts, nothing is stored', async () => {
    mockReplied = new Set([REPLIED]);
    await seedAccount(ME, null, null, true, false);
    await arm(ME);
    expect(await notifies(STRANGER)).toBe(false);
    expect(await notifies(FRIEND)).toBe(false); // not known as followed without the cache
    expect(await notifies(REPLIED)).toBe(true);
    expect(storeDecryptedWrap).not.toHaveBeenCalled();
  });

  it('an unmarked All stays closed too', async () => {
    await seedAccount(ME, 'all', null, false, false);
    await arm(ME);
    expect(await notifies(STRANGER)).toBe(false);
  });

  it('an explicitly chosen All lets anyone alert', async () => {
    await seedAccount(ME, 'all', null, true, false);
    await arm(ME);
    expect(await notifies(STRANGER)).toBe(true);
    expect(storeDecryptedWrap).not.toHaveBeenCalled();
  });
});
