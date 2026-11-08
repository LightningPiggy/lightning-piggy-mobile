// Contract guards around the WoT-settings persistence + migration paths.
// Two things matter strongly here and warrant being locked in by tests:
//   1. The first-run default (no stored payload) returns 'all' — this is
//      what makes new users see Geo-caches + Events on Explore / Hunt /
//      Events surfaces (issue #627).
//   2. The legacy boolean payload migrates correctly so users on pre-#535
//      installs don't have their explicit choice ignored.

import {
  loadWotSettings,
  parseChosenWotTier,
  peekWotSettings,
  saveWotSettings,
} from './wotSettingsService';
import { __resetAccountSettingsCacheForTests } from './accountSettingsCache';

jest.mock('@react-native-async-storage/async-storage', () => {
  let store: Record<string, string> = {};
  return {
    getItem: jest.fn((k: string) => Promise.resolve(store[k] ?? null)),
    setItem: jest.fn((k: string, v: string) => {
      store[k] = v;
      return Promise.resolve();
    }),
    removeItem: jest.fn((k: string) => {
      delete store[k];
      return Promise.resolve();
    }),
    // Test-only escape hatch — not part of AsyncStorage's API. Used to
    // reset the mock between tests without re-importing the module.
    __reset: () => {
      store = {};
    },
  };
});

const PK = 'a'.repeat(64);
const OTHER = 'b'.repeat(64);
const STORAGE_KEY = `@lp:wot-settings:v1_${PK}`;

jest.mock('./identitiesStore', () => ({
  loadIdentities: jest.fn(async () => ({ identities: [], activePubkey: null })),
}));
// eslint-disable-next-line @typescript-eslint/no-require-imports
const AsyncStorage = require('@react-native-async-storage/async-storage');

beforeEach(() => {
  AsyncStorage.__reset();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('./safetySettingsMigration').__resetSafetyMigrationForTests();
  __resetAccountSettingsCacheForTests();
});

describe('peekWotSettings (sync mirror for account switches)', () => {
  it('is unknown (null) until the account has been loaded or saved', async () => {
    expect(peekWotSettings(PK)).toBeNull();
    expect(peekWotSettings(null)).toBeNull();
    await loadWotSettings(PK);
    expect(peekWotSettings(PK)).toEqual({ wotTier: 'all' });
    await saveWotSettings({ wotTier: 'friends' }, OTHER);
    expect(peekWotSettings(OTHER)).toEqual({ wotTier: 'friends' });
  });

  it('a load that resolves after a save never rolls the tier back', async () => {
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ wotTier: 'all' }));
    await loadWotSettings(OTHER); // finish the one-time migration first
    let release!: () => void;
    AsyncStorage.getItem.mockImplementationOnce(
      (k: string) =>
        new Promise((resolve) => {
          release = () => resolve(k === STORAGE_KEY ? JSON.stringify({ wotTier: 'all' }) : null);
        }),
    );
    const pending = loadWotSettings(PK);
    await new Promise((r) => setTimeout(r, 0));
    await saveWotSettings({ wotTier: 'friends' }, PK);
    release();
    expect((await pending).wotTier).toBe('friends');
    expect(peekWotSettings(PK)).toEqual({ wotTier: 'friends' });
  });
});

describe('wotSettingsService', () => {
  it('is per account: a tier saved for one account is not seen by another', async () => {
    await saveWotSettings({ wotTier: 'friends' }, PK);
    expect((await loadWotSettings(PK)).wotTier).toBe('friends');
    expect((await loadWotSettings(OTHER)).wotTier).toBe('all');
  });

  describe('loadWotSettings — first-run default', () => {
    it("returns wotTier='all' when no payload is stored (issue #627)", async () => {
      // The empty-rail symptom on a fresh emulator install was directly
      // caused by this default being 'friends' before #627. Locking it
      // in here so an accidental revert shows up as a test failure
      // rather than as 'no caches load' user reports.
      const settings = await loadWotSettings(PK);
      expect(settings.wotTier).toBe('all');
    });

    it('returns the same default on a corrupt JSON payload', async () => {
      await AsyncStorage.setItem(STORAGE_KEY, '<not json>');
      const settings = await loadWotSettings(PK);
      expect(settings.wotTier).toBe('all');
    });

    it('returns the same default on a payload missing wotTier', async () => {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ otherField: true }));
      const settings = await loadWotSettings(PK);
      expect(settings.wotTier).toBe('all');
    });
  });

  describe('loadWotSettings — explicit values', () => {
    it('round-trips a stored friends tier', async () => {
      await saveWotSettings({ wotTier: 'friends' }, PK);
      const settings = await loadWotSettings(PK);
      expect(settings.wotTier).toBe('friends');
    });

    it('round-trips a stored fof tier', async () => {
      await saveWotSettings({ wotTier: 'fof' }, PK);
      const settings = await loadWotSettings(PK);
      expect(settings.wotTier).toBe('fof');
    });

    it('round-trips a stored all tier', async () => {
      await saveWotSettings({ wotTier: 'all' }, PK);
      const settings = await loadWotSettings(PK);
      expect(settings.wotTier).toBe('all');
    });
  });

  describe('loadWotSettings — legacy migration', () => {
    it("maps legacy filterEnabled=true → wotTier='friends'", async () => {
      // Pre-#535 stored `{ filterEnabled: boolean }`. true = filter
      // explicitly engaged = the equivalent of the friends-only tier.
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ filterEnabled: true }));
      const settings = await loadWotSettings(PK);
      expect(settings.wotTier).toBe('friends');
    });

    it("maps legacy filterEnabled=false → wotTier='all'", async () => {
      // false = filter explicitly disengaged = the equivalent of 'all'.
      // This migration was correct pre-#627 and remains correct now.
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify({ filterEnabled: false }));
      const settings = await loadWotSettings(PK);
      expect(settings.wotTier).toBe('all');
    });
  });
});

describe('parseChosenWotTier (#1749)', () => {
  it('returns a tier only when it carries the explicit marker', () => {
    expect(parseChosenWotTier(JSON.stringify({ wotTier: 'all', explicit: true }))).toBe('all');
    expect(parseChosenWotTier(JSON.stringify({ wotTier: 'fof', explicit: true }))).toBe('fof');
    expect(parseChosenWotTier(JSON.stringify({ wotTier: 'friends', explicit: true }))).toBe(
      'friends',
    );
  });

  it('treats the Groups migration / chip payload (no marker) as never chosen', () => {
    // GroupsContext's migration and its chip save `{ wotTier }` with no user pick.
    expect(parseChosenWotTier(JSON.stringify({ wotTier: 'all' }))).toBeNull();
    expect(parseChosenWotTier(JSON.stringify({ wotTier: 'fof' }))).toBeNull();
    expect(parseChosenWotTier(JSON.stringify({ wotTier: 'all', explicit: false }))).toBeNull();
  });

  it('treats the legacy boolean as never chosen', () => {
    expect(parseChosenWotTier(JSON.stringify({ filterEnabled: false }))).toBeNull();
    expect(parseChosenWotTier(JSON.stringify({ filterEnabled: true }))).toBeNull();
  });

  it('returns null when nothing valid was stored', () => {
    expect(parseChosenWotTier(null)).toBeNull();
    expect(parseChosenWotTier('not json')).toBeNull();
    expect(parseChosenWotTier(JSON.stringify({ wotTier: 'everyone', explicit: true }))).toBeNull();
  });
});
