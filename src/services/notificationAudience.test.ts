import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  audienceAdmits,
  liveNotificationAudience,
  loadNotificationAudience,
  publishNotificationAudience,
  unpublishNotificationAudience,
  __resetNotificationAudiences,
} from './notificationAudience';
import { FOF_SHARED_MAX, persistFofCache, __resetFofMemory } from './friendsOfFriendsService';
import { perAccountKey } from './perAccountStorage';
import { WOT_STORAGE_KEY_BASE, type WotTier } from './wotSettingsService';

jest.mock('./safetySettingsMigration', () => ({
  ...jest.requireActual('./safetySettingsMigration'),
  ensureSafetySettingsMigrated: () => Promise.resolve(),
}));

const ME = 'a'.repeat(64);
const OTHER = 'e'.repeat(64);
const FRIEND = 'b'.repeat(64);
const FOF = 'c'.repeat(64);
const STRANGER = 'd'.repeat(64);

const setTier = (owner: string, tier: WotTier, explicit = true) =>
  AsyncStorage.setItem(
    perAccountKey(WOT_STORAGE_KEY_BASE, owner),
    JSON.stringify(explicit ? { wotTier: tier, explicit } : { wotTier: tier }),
  );
const cacheFof = (owner: string, set: string[], computedAt = Date.now()) =>
  persistFofCache(
    owner,
    [FRIEND],
    { set: new Set(set), excludedFriends: 0, computedAt },
    FOF_SHARED_MAX,
  );

beforeEach(async () => {
  __resetNotificationAudiences();
  __resetFofMemory();
  await AsyncStorage.clear();
});

describe('audienceAdmits', () => {
  it('admits nobody extra without an audience or under Friends', () => {
    expect(audienceAdmits(null, STRANGER)).toBe(false);
    expect(audienceAdmits({ tier: 'friends', fof: new Set([FOF]) }, FOF)).toBe(false);
  });

  it('admits the cached set under friends of friends, never everyone', () => {
    const fof = { tier: 'fof' as const, fof: new Set([FOF]) };
    expect(audienceAdmits(fof, FOF)).toBe(true);
    expect(audienceAdmits(fof, FOF.toUpperCase())).toBe(true);
    expect(audienceAdmits(fof, STRANGER)).toBe(false);
    expect(audienceAdmits({ tier: 'fof', fof: null }, FOF)).toBe(false);
  });

  it('admits any sender under All', () => {
    expect(audienceAdmits({ tier: 'all', fof: null }, STRANGER)).toBe(true);
  });
});

describe('live audience', () => {
  it('is per account and cleared on unpublish', () => {
    publishNotificationAudience(ME.toUpperCase(), { tier: 'all', fof: null });
    expect(liveNotificationAudience(ME)?.tier).toBe('all');
    expect(liveNotificationAudience(OTHER)).toBeNull();
    expect(liveNotificationAudience(null)).toBeNull();
    unpublishNotificationAudience(ME);
    expect(liveNotificationAudience(ME)).toBeNull();
  });
});

describe('loadNotificationAudience (no React tree)', () => {
  it("reads the account's own tier and friends-of-friends cache", async () => {
    await setTier(ME, 'fof');
    await setTier(OTHER, 'all');
    await cacheFof(ME, [FOF]);
    await cacheFof(OTHER, [STRANGER]);
    __resetFofMemory();
    const mine = await loadNotificationAudience(ME, new Set([FRIEND]));
    expect(mine?.tier).toBe('fof');
    expect([...(mine?.fof ?? [])]).toEqual([FOF]);
    expect((await loadNotificationAudience(OTHER, new Set([FRIEND])))?.tier).toBe('all');
  });

  it('keeps a stale cached set (as the Messages list does) and needs friends', async () => {
    await setTier(ME, 'fof');
    await cacheFof(ME, [FOF], Date.now() - 3 * 24 * 60 * 60 * 1000);
    __resetFofMemory();
    expect([...((await loadNotificationAudience(ME, new Set([FRIEND])))?.fof ?? [])]).toEqual([
      FOF,
    ]);
    expect((await loadNotificationAudience(ME, new Set()))?.fof).toBeNull();
  });

  it('friends of friends with nothing cached admits no one extra', async () => {
    await setTier(ME, 'fof');
    const audience = await loadNotificationAudience(ME, new Set([FRIEND]));
    expect(audience).toEqual({ tier: 'fof', fof: null });
    expect(audienceAdmits(audience, FOF)).toBe(false);
  });

  it('an unchosen tier notifies like Friends; only an explicit pick widens it', async () => {
    expect((await loadNotificationAudience(ME, new Set([FRIEND])))?.tier).toBe('friends');
    await setTier(ME, 'all', false);
    expect((await loadNotificationAudience(ME, new Set([FRIEND])))?.tier).toBe('friends');
    await setTier(ME, 'fof', false);
    await cacheFof(ME, [FOF]);
    expect(await loadNotificationAudience(ME, new Set([FRIEND]))).toEqual({
      tier: 'friends',
      fof: null,
    });
    await setTier(ME, 'all');
    expect((await loadNotificationAudience(ME, new Set([FRIEND])))?.tier).toBe('all');
    await setTier(ME, 'fof');
    expect([...((await loadNotificationAudience(ME, new Set([FRIEND])))?.fof ?? [])]).toEqual([
      FOF,
    ]);
  });
});
