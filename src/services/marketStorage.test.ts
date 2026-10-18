import * as pacing from '../contexts/nostrDecryptPacing';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  clearMarketSnapshotMemory,
  subscribeMarketSnapshots,
  getMarketSnapshot,
  loadedMarketSnapshots,
  readLoadedMarketSnapshots,
  readMarketPreferences,
  writeMarketPreferences,
  wipeMarketAccount,
  readMarketSnapshot,
  writeMarketSnapshot,
  MARKET_CACHE_KEY,
  MARKET_CACHE_MAX_AGE_MS,
  MARKET_CACHE_MAX_CHARS,
} from './marketStorage';
beforeEach(() => {
  clearMarketSnapshotMemory();
  jest.clearAllMocks();
  (AsyncStorage.getItem as jest.Mock).mockResolvedValue(null);
});
it('rejects corrupt preferences and unknown scopes', async () => {
  (AsyncStorage.getItem as jest.Mock).mockResolvedValue('{broken');
  expect((await readMarketPreferences('alice')).mode).toBe('preferred');
  (AsyncStorage.getItem as jest.Mock).mockResolvedValue(
    JSON.stringify({ mode: 'wotEverything', merchant: 42 }),
  );
  expect(await readMarketPreferences('bob')).toEqual({
    mode: 'preferred',
    merchant: null,
    shipsTo: null,
    includeUnknownShipping: true,
    currency: null,
  });
});
it('keeps saved experimental scopes (the screen clamps them while experimental is off)', async () => {
  for (const mode of ['wotFof', 'wotAll']) {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(JSON.stringify({ mode }));
    expect((await readMarketPreferences(`exp-${mode}`)).mode).toBe(mode);
  }
});
it('migrates the retired Country filter value to Anywhere and keeps a saved Ships-to', async () => {
  (AsyncStorage.getItem as jest.Mock).mockResolvedValue(
    JSON.stringify({
      mode: 'preferred',
      merchant: null,
      country: 'United Kingdom',
      currency: null,
    }),
  );
  expect(await readMarketPreferences('legacy')).toEqual({
    mode: 'preferred',
    merchant: null,
    shipsTo: null,
    includeUnknownShipping: true,
    currency: null,
  });
  (AsyncStorage.getItem as jest.Mock).mockResolvedValue(
    JSON.stringify({ shipsTo: 'deu', includeUnknownShipping: false, country: 'GB' }),
  );
  const restored = await readMarketPreferences('current');
  expect(restored.shipsTo).toBe('DE');
  expect(restored.includeUnknownShipping).toBe(false);
  (AsyncStorage.getItem as jest.Mock).mockResolvedValue(JSON.stringify({ shipsTo: 'Narnia' }));
  expect((await readMarketPreferences('bogus')).shipsTo).toBeNull();
});
it('bounds disk and session scopes and isolates accounts', async () => {
  for (let i = 0; i < 12; i++)
    await writeMarketSnapshot(`alice|${i}`, { products: [], incomplete: false });
  expect(getMarketSnapshot('alice|0')).toBeUndefined();
  expect(getMarketSnapshot('bob|11')).toBeUndefined();
  expect(getMarketSnapshot('alice|11')).toBeDefined();
  const writes = (AsyncStorage.setItem as jest.Mock).mock.calls.filter(
    ([key]) => key === MARKET_CACHE_KEY,
  );
  expect(JSON.parse(writes[writes.length - 1][1]).length).toBeLessThanOrEqual(8);
  expect(writes.every(([, raw]) => raw.length <= MARKET_CACHE_MAX_CHARS)).toBe(true);
});
it('rejects expired, oversized and malformed disk envelopes', async () => {
  for (const raw of [
    JSON.stringify([
      {
        key: 'alice',
        at: Date.now() - MARKET_CACHE_MAX_AGE_MS,
        result: { products: [], incomplete: false },
      },
    ]),
    'x'.repeat(MARKET_CACHE_MAX_CHARS + 1),
    '{broken',
    JSON.stringify([null]),
  ]) {
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(raw);
    expect(await readMarketSnapshot('alice')).toBeUndefined();
  }
});

it('does not retain an oversized snapshot in either cache', async () => {
  const product = {
    id: 'large',
    sellerName: 'Seller',
    description: 'x'.repeat(MARKET_CACHE_MAX_CHARS),
  } as unknown as import('../data/marketProducts').MarketProduct;
  await writeMarketSnapshot('alice|large', { products: [product], incomplete: false });
  expect(getMarketSnapshot('alice|large')).toBeUndefined();
  expect(AsyncStorage.setItem).toHaveBeenLastCalledWith(MARKET_CACHE_KEY, '[]');
});

it('filters signed expiration from memory and disk without expiring the snapshot', async () => {
  const product = {
    id: 'expires',
    sellerName: 'Seller',
    listing: {
      event: {
        pubkey: 'seller',
        tags: [['expiration', String(Math.floor(Date.now() / 1000) + 60)]],
      },
      vendor: {},
    },
  } as unknown as import('../data/marketProducts').MarketProduct;
  await writeMarketSnapshot('expiry|scope', { products: [product], incomplete: false });
  const raw = (AsyncStorage.setItem as jest.Mock).mock.calls
    .filter(([key]) => key === MARKET_CACHE_KEY)
    .pop()[1];
  const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 60001);
  try {
    expect(getMarketSnapshot('expiry|scope')?.result.products).toEqual([]);
    clearMarketSnapshotMemory();
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(raw);
    expect((await readMarketSnapshot('expiry|scope'))?.result.products).toEqual([]);
  } finally {
    clock.mockRestore();
  }
});

it('invalidates pending snapshot and preference reads during account cleanup', async () => {
  let release!: (value: string) => void;
  (AsyncStorage.getItem as jest.Mock).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const snapshotRead = readMarketSnapshot('read-race|scope');
  await Promise.resolve();
  await Promise.resolve();
  const wipe = wipeMarketAccount('read-race');
  release(
    JSON.stringify([
      { key: 'read-race|scope', at: Date.now(), result: { products: [], incomplete: false } },
    ]),
  );
  await wipe;
  expect(await snapshotRead).toBeUndefined();
  expect(getMarketSnapshot('read-race|scope')).toBeUndefined();

  (AsyncStorage.getItem as jest.Mock).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const preferencesRead = readMarketPreferences('read-race');
  await Promise.resolve();
  await Promise.resolve();
  const secondWipe = wipeMarketAccount('read-race');
  release(JSON.stringify({ mode: 'wotFriends', merchant: 'Private seller' }));
  await secondWipe;
  expect((await preferencesRead).merchant).toBeNull();
});

it('cancels queued writes before removing account data', async () => {
  const prefs = writeMarketPreferences('write-race', {
    mode: 'wotFriends',
    merchant: 'Seller',
    shipsTo: null,
    includeUnknownShipping: true,
    currency: null,
  });
  const snapshot = writeMarketSnapshot('write-race|scope', { products: [], incomplete: false });
  await wipeMarketAccount('write-race');
  await Promise.all([prefs, snapshot]);
  expect(getMarketSnapshot('write-race|scope')).toBeUndefined();
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  expect(AsyncStorage.removeItem).toHaveBeenCalledWith('market_filters_v1_write-race');
  expect(AsyncStorage.removeItem).toHaveBeenCalledWith(MARKET_CACHE_KEY);
});

it('rejects oversized event payloads before any synchronous serialization', async () => {
  const product = {
    id: 'huge',
    sellerName: 'Seller',
    listing: {
      event: { pubkey: 'seller', content: 'x'.repeat(MARKET_CACHE_MAX_CHARS), tags: [] },
      vendor: {},
    },
  } as unknown as import('../data/marketProducts').MarketProduct;
  const stringify = jest.spyOn(JSON, 'stringify');
  try {
    const write = writeMarketSnapshot('payload|scope', { products: [product], incomplete: false });
    expect(stringify).not.toHaveBeenCalled();
    await write;
    expect(stringify.mock.calls.some(([value]) => value === product)).toBe(false);
    expect(getMarketSnapshot('payload|scope')).toBeUndefined();
  } finally {
    stringify.mockRestore();
  }
});

it('paces bounded serialization per product and disposes the preparation scheduler', async () => {
  const maybeYield = jest.fn(async () => {});
  const dispose = jest.fn();
  const scheduler = jest
    .spyOn(pacing, 'createYieldScheduler')
    .mockReturnValue({ maybeYield, dispose, yieldCount: 0 });
  try {
    const products = Array.from({ length: 250 }, (_, i) => ({
      id: String(i),
      sellerName: 'Seller',
      description: 'x'.repeat(2000),
    })) as unknown as import('../data/marketProducts').MarketProduct[];
    await writeMarketSnapshot('paced|scope', { products, incomplete: false });
    expect(scheduler).toHaveBeenCalledWith({ safetyEvery: 32, coldStart: true });
    expect(maybeYield).toHaveBeenCalledTimes(250);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(getMarketSnapshot('paced|scope')?.result.products).toHaveLength(250);
  } finally {
    scheduler.mockRestore();
  }
});

it('drains a write already in disk storage before removing it', async () => {
  let release!: () => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  (AsyncStorage.setItem as jest.Mock).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
        started();
      }),
  );
  const pending = writeMarketPreferences('inflight', {
    mode: 'wotFriends',
    merchant: 'Seller',
    shipsTo: null,
    includeUnknownShipping: true,
    currency: null,
  });
  await entered;
  const wipe = wipeMarketAccount('inflight');
  expect(AsyncStorage.removeItem).not.toHaveBeenCalled();
  release();
  await Promise.all([pending, wipe]);
  expect(AsyncStorage.removeItem).toHaveBeenCalledWith('market_filters_v1_inflight');
});

it('blocks a late relay write after cleanup until a new account hydration', async () => {
  await wipeMarketAccount('late-relay');
  jest.clearAllMocks();
  await writeMarketSnapshot('late-relay|scope', { products: [], incomplete: false });
  await writeMarketPreferences('late-relay', {
    mode: 'wotFriends',
    merchant: 'Seller',
    shipsTo: null,
    includeUnknownShipping: true,
    currency: null,
  });
  expect(AsyncStorage.setItem).not.toHaveBeenCalled();
  expect(getMarketSnapshot('late-relay|scope')).toBeUndefined();
  await readMarketPreferences('late-relay');
  await writeMarketSnapshot('late-relay|scope', { products: [], incomplete: false });
  expect(getMarketSnapshot('late-relay|scope')).toBeDefined();
});
it('lists in-memory snapshots for the requested accounts only', async () => {
  const product = { id: 'p1', sellerName: 'shop' } as never;
  await writeMarketSnapshot('alice|x|r', { products: [product], incomplete: false });
  await writeMarketSnapshot('team|y|r', { products: [], incomplete: false });
  await writeMarketSnapshot('bob|z|r', { products: [product], incomplete: false });
  const loaded = loadedMarketSnapshots(['alice', 'team']);
  expect(loaded.map((s) => s.account).sort()).toEqual(['alice', 'team']);
  expect(loaded.find((s) => s.account === 'alice')?.products).toEqual([product]);
  await wipeMarketAccount('alice');
  expect(loadedMarketSnapshots(['alice'])).toEqual([]);
});

it.each(['sold', 'hidden', 'deleted', 'expired'])(
  'does not resurrect %s listings omitted from a newer reduced snapshot',
  async () => {
    const seller = 'a'.repeat(64);
    const other = 'b'.repeat(64);
    const product = (pubkey: string) =>
      ({
        id: pubkey,
        sellerName: 'shop',
        listing: { event: { pubkey, tags: [] }, vendor: {} },
      }) as unknown as import('../data/marketProducts').MarketProduct;
    const clock = jest.spyOn(Date, 'now');
    const now = Date.now();
    clock.mockReturnValue(now - 1000);
    const old = product(seller);
    const unrelated = product(other);
    await writeMarketSnapshot(`reco-viewer|${seller},${other}|old-relay`, {
      products: [old, unrelated],
      incomplete: false,
    });
    clock.mockReturnValue(now);
    await writeMarketSnapshot(`reco-team|${seller}|new-relay`, {
      products: [],
      incomplete: false,
    });
    expect(loadedMarketSnapshots(['reco-viewer', 'reco-team']).flatMap((s) => s.products)).toEqual([
      unrelated,
    ]);
    clock.mockRestore();
    // The same suppression must survive a cold disk hydration in either order.
    const writes = (AsyncStorage.setItem as jest.Mock).mock.calls.filter(
      ([key]) => key === MARKET_CACHE_KEY,
    );
    const disk = JSON.parse(writes[writes.length - 1][1]);
    // The storage mock does not persist earlier writes; include the old envelope.
    const olderDisk = JSON.parse(writes[writes.length - 2][1]);
    (AsyncStorage.getItem as jest.Mock).mockResolvedValue(JSON.stringify([...disk, ...olderDisk]));
    clearMarketSnapshotMemory();
    await readMarketSnapshot(`reco-team|${seller}|new-relay`);
    await readMarketSnapshot(`reco-viewer|${seller},${other}|old-relay`);
    expect(loadedMarketSnapshots(['reco-viewer', 'reco-team']).flatMap((s) => s.products)).toEqual([
      unrelated,
    ]);
  },
);

it('fails closed for overlapping snapshots with equal timestamps, regardless of insertion order', async () => {
  const seller = 'e'.repeat(64);
  const product = {
    id: 'old',
    sellerName: 'shop',
    listing: { event: { pubkey: seller, tags: [] }, vendor: {} },
  } as never;
  const at = Date.now();
  const raw = JSON.stringify([
    { key: `tie-new|${seller}|r`, at, result: { products: [], incomplete: false } },
    { key: `tie-old|${seller}|r`, at, result: { products: [product], incomplete: false } },
  ]);
  (AsyncStorage.getItem as jest.Mock).mockResolvedValue(raw);
  await readMarketSnapshot(`tie-new|${seller}|r`);
  await readMarketSnapshot(`tie-old|${seller}|r`);
  expect(loadedMarketSnapshots(['tie-new', 'tie-old']).flatMap((s) => s.products)).toEqual([]);
});

it('hydrates only the requested account and shares concurrent catalogue disk reads', async () => {
  const entries = ['catalogue-alice', 'catalogue-bob'].map((account) => ({
    key: `${account}|scope`,
    at: Date.now(),
    result: { products: [{ id: account, sellerName: 'shop' }], incomplete: false },
  }));
  jest.mocked(AsyncStorage.getItem).mockResolvedValue(JSON.stringify(entries));
  const first = readLoadedMarketSnapshots('catalogue-alice');
  const second = readLoadedMarketSnapshots('catalogue-alice');
  expect(second).toBe(first);
  expect((await first).flatMap((snapshot) => snapshot.products).map((p) => p.id)).toEqual([
    'catalogue-alice',
  ]);
  expect(loadedMarketSnapshots(['catalogue-bob'])).toEqual([]);
  expect(AsyncStorage.getItem).toHaveBeenCalledTimes(1);
});

it('notifies local consumers after catalogue writes, hydration and account wipes', async () => {
  const listener = jest.fn();
  const unsubscribe = subscribeMarketSnapshots(listener);
  try {
    await writeMarketSnapshot('shortcut-account|scope', { products: [], incomplete: false });
    expect(listener).toHaveBeenCalledTimes(1);
    clearMarketSnapshotMemory();
    expect(listener).toHaveBeenCalledTimes(2);
    await readLoadedMarketSnapshots('shortcut-account');
    expect(listener).toHaveBeenCalledTimes(3);
    await wipeMarketAccount('shortcut-account');
    expect(listener).toHaveBeenCalledTimes(4);
    unsubscribe();
    clearMarketSnapshotMemory();
    expect(listener).toHaveBeenCalledTimes(4);
  } finally {
    unsubscribe();
  }
});
