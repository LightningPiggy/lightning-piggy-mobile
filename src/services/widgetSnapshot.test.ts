import AsyncStorage from '@react-native-async-storage/async-storage';
import type { WalletState } from '../types/wallet';
import {
  WIDGET_SNAPSHOT_KEY,
  WIDGET_WALLET_KEYS,
  buildWidgetSnapshot,
  parseWidgetSnapshot,
  readWidgetSnapshot,
  shapeWidgetWallet,
  snapshotFingerprint,
  sortWalletsForCarousel,
  wipeWidgetSnapshot,
  wipeWidgetSnapshotOnAccountChange,
  writeWidgetSnapshot,
  type WidgetSnapshot,
} from './widgetSnapshot';
import {
  __resetWalletOwnerGateForTests,
  setActivePubkeyForWalletStorage,
} from './walletStorageService';

const NOW = 1_800_000_000_000;

function wallet(overrides: Partial<WalletState> = {}): WalletState {
  return {
    id: 'w1',
    alias: 'Big Hot',
    theme: 'lightning-piggy',
    order: 0,
    walletType: 'nwc',
    lightningAddress: 'piggy@example.com',
    isConnected: true,
    connectionHealth: 'responsive',
    balance: 92_369,
    walletAlias: 'node alias',
    transactions: [],
    ...overrides,
  };
}

const fetchedNow = (id: string) => (id === 'w1' ? NOW : null);
const opts = { btcPrice: 74_500, currency: 'USD', fetchedAt: fetchedNow };

// Values that must never reach the widget, whatever field they hide in.
const SECRETS = [
  'nostr+walletconnect://abc?relay=wss://r&secret=deadbeef',
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about',
  'xpub6CUGRUonZSQ4TWtTMmzXdrXDtypWKiKrhko4egpiMZbpiaQL2jkwSB1icqYh2cfDfVxdx4df189oLKnC5fSwqPfgyP3hooxujYzAu3fDVmz',
  'nsec1vl029mgpspedva04g90vltkh6fvh240zqtv9k0t9af8935ke9laqsnlfe5',
  'lnurl1dp68gurn8ghj7um9wfmxjcm99e3k7mf0v9cxj0m385ekvcenxc6r2c35xvukxefcv5mkvv34x5ekzd3ev56nyd3hxqurzepexejxxepnxscrvwfnv9nxzcn9xq6xyefhvgcxxcmyxymnserxfq5fns',
  'piggy@example.com',
  'node alias',
];

/** Tiny deterministic PRNG so the property test is reproducible. */
function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1_103_515_245 + 12_345) % 2_147_483_648;
    return s / 2_147_483_648;
  };
}

describe('shapeWidgetWallet', () => {
  it('copies only the allow-listed fields', () => {
    const shaped = shapeWidgetWallet(wallet(), 0, opts);
    expect(Object.keys(shaped).sort()).toEqual([...WIDGET_WALLET_KEYS].sort());
    expect(shaped).toEqual({
      id: 'w1',
      name: 'Big Hot',
      walletType: 'nwc',
      balanceSats: 92_369,
      fiatValue: (92_369 / 100_000_000) * 74_500,
      currency: 'USD',
      updatedAt: NOW,
      order: 0,
      connected: true,
    });
  });

  it('property: no extra field or secret value ever leaks, whatever the wallet carries', () => {
    const random = rng(1849);
    for (let i = 0; i < 300; i++) {
      const extra: Record<string, unknown> = {};
      // Secrets under arbitrary keys, plus known-sensitive names.
      for (const key of ['nwcUrl', 'mnemonic', 'xpub', 'nsec', 'lnurl', 'password', `k${i}`]) {
        if (random() < 0.6) extra[key] = SECRETS[Math.floor(random() * SECRETS.length)];
      }
      if (random() < 0.3) extra.nested = { secret: SECRETS[0] };
      const w = wallet({
        id: `id-${i}`,
        alias: `Piggy ${i}`,
        walletType: random() < 0.5 ? 'nwc' : 'onchain',
        balance: random() < 0.2 ? null : Math.floor(random() * 1e9),
        hideBalance: random() < 0.2,
        isConnected: random() < 0.7,
        lightningAddress: SECRETS[5],
        walletAlias: SECRETS[6],
        transactions: [{ type: 'incoming', amount: 1, invoice: SECRETS[4], preimage: 'ff' }],
        ...(extra as Partial<WalletState>),
      });
      const shaped = shapeWidgetWallet(w, i, { ...opts, btcPrice: random() < 0.3 ? null : 50_000 });
      expect(Object.keys(shaped).sort()).toEqual([...WIDGET_WALLET_KEYS].sort());
      const json = JSON.stringify(shaped);
      for (const secret of SECRETS) expect(json).not.toContain(secret);
      expect(json).not.toContain('"invoice"');
    }
  });

  it('never stores a balance the user hid in the app', () => {
    const shaped = shapeWidgetWallet(wallet({ hideBalance: true }), 0, opts);
    expect(shaped.balanceSats).toBeNull();
    expect(shaped.fiatValue).toBeNull();
  });

  it('has no fiat value without a BTC price', () => {
    expect(shapeWidgetWallet(wallet(), 0, { ...opts, btcPrice: null }).fiatValue).toBeNull();
  });

  describe('updatedAt is the real balance fetch time, never the write time', () => {
    const base = { btcPrice: 74_500, currency: 'USD' };
    const prev = (updatedAt: number | null, balance = 92_369): WidgetSnapshot => ({
      version: 1,
      locale: 'en',
      wallets: [{ ...shapeWidgetWallet(wallet({ balance }), 0, base), updatedAt }],
    });

    it('uses the fetch time the balance readers recorded', () => {
      expect(shapeWidgetWallet(wallet(), 0, { ...base, fetchedAt: () => NOW }).updatedAt).toBe(NOW);
    });

    it('is unknown for a cached balance nothing has fetched yet (cold start)', () => {
      // An on-chain wallet last synced days ago, hydrated from cache: not "just now".
      const onchain = wallet({ walletType: 'onchain', isConnected: false });
      expect(shapeWidgetWallet(onchain, 0, { ...base, fetchedAt: () => null }).updatedAt).toBe(
        null,
      );
      expect(shapeWidgetWallet(wallet(), 0, base).updatedAt).toBeNull();
    });

    it('a price change alone never moves it', () => {
      const previous = prev(NOW - 40 * 60_000);
      const a = shapeWidgetWallet(wallet(), 0, { ...base, previous, fetchedAt: () => null });
      const b = shapeWidgetWallet(wallet(), 0, {
        ...base,
        btcPrice: 80_000,
        previous,
        fetchedAt: () => null,
      });
      expect(a.updatedAt).toBe(NOW - 40 * 60_000);
      expect(b.updatedAt).toBe(NOW - 40 * 60_000);
      expect(b.fiatValue).not.toBe(a.fiatValue);
    });

    it('carries the previous fetch time only while the amount is unchanged', () => {
      const previous = prev(NOW - 60_000, 1_000);
      expect(
        shapeWidgetWallet(wallet({ balance: 1_000 }), 0, { ...base, previous }).updatedAt,
      ).toBe(NOW - 60_000);
      // A different amount from somewhere we can't date: say nothing.
      expect(
        shapeWidgetWallet(wallet({ balance: 2_000 }), 0, { ...base, previous }).updatedAt,
      ).toBe(null);
    });

    it('reports connection separately: NWC down or degraded, on-chain always up', () => {
      expect(shapeWidgetWallet(wallet({ isConnected: false }), 0, base).connected).toBe(false);
      expect(shapeWidgetWallet(wallet({ connectionHealth: 'degraded' }), 0, base).connected).toBe(
        false,
      );
      expect(
        shapeWidgetWallet(wallet({ walletType: 'onchain', isConnected: false }), 0, base).connected,
      ).toBe(true);
    });
  });
});

describe('buildWidgetSnapshot', () => {
  it('orders wallets as the carousel does and records the language', () => {
    const snapshot = buildWidgetSnapshot(
      [wallet({ id: 'c', order: 2 }), wallet({ id: 'a', order: 0 }), wallet({ id: 'b', order: 1 })],
      'de',
      opts,
    );
    expect(snapshot.locale).toBe('de');
    expect(snapshot.wallets.map((w) => [w.id, w.order])).toEqual([
      ['a', 0],
      ['b', 1],
      ['c', 2],
    ]);
  });

  it('keeps list position for equal orders', () => {
    const list = [
      { id: 'x', order: 1 },
      { id: 'y', order: 1 },
      { id: 'z', order: 0 },
    ];
    expect(sortWalletsForCarousel(list).map((w) => w.id)).toEqual(['z', 'x', 'y']);
  });

  it('fingerprint ignores the fetch time only', () => {
    const a = buildWidgetSnapshot([wallet()], 'en', opts);
    const b = buildWidgetSnapshot([wallet()], 'en', { ...opts, fetchedAt: () => NOW + 5000 });
    const c = buildWidgetSnapshot([wallet({ balance: 1 })], 'en', opts);
    expect(snapshotFingerprint(a)).toBe(snapshotFingerprint(b));
    expect(snapshotFingerprint(a)).not.toBe(snapshotFingerprint(c));
  });
});

describe('parseWidgetSnapshot', () => {
  it('round-trips a snapshot', () => {
    const snapshot = buildWidgetSnapshot([wallet()], 'es', opts);
    expect(parseWidgetSnapshot(JSON.stringify(snapshot))).toEqual(snapshot);
  });

  it('drops stray keys and malformed wallets', () => {
    const json = JSON.stringify({
      version: 1,
      locale: 'en',
      wallets: [
        { ...shapeWidgetWallet(wallet(), 0, opts), nwcUrl: SECRETS[0] },
        { id: 'bad', name: 3 },
      ],
    });
    const parsed = parseWidgetSnapshot(json);
    expect(parsed?.wallets).toHaveLength(1);
    expect(JSON.stringify(parsed)).not.toContain(SECRETS[0]);
  });

  it.each([null, '', 'not json', '{"version":2,"wallets":[]}', '{"version":1}'])(
    'reads %p as no snapshot',
    (json) => {
      expect(parseWidgetSnapshot(json)).toBeNull();
    },
  );
});

describe('snapshot storage', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
  });

  it('writes, reads and wipes', async () => {
    const snapshot = buildWidgetSnapshot([wallet()], 'en', opts);
    await writeWidgetSnapshot(snapshot);
    expect(await readWidgetSnapshot()).toEqual(snapshot);
    await wipeWidgetSnapshot();
    expect(await AsyncStorage.getItem(WIDGET_SNAPSHOT_KEY)).toBeNull();
    expect(await readWidgetSnapshot()).toBeNull();
  });

  it('a wipe issued after a write always wins', async () => {
    const write = writeWidgetSnapshot(buildWidgetSnapshot([wallet()], 'en', opts));
    const wipe = wipeWidgetSnapshot();
    await Promise.all([write, wipe]);
    expect(await readWidgetSnapshot()).toBeNull();
  });
});

describe('wipeWidgetSnapshotOnAccountChange', () => {
  beforeEach(async () => {
    await AsyncStorage.clear();
    setActivePubkeyForWalletStorage(null);
    __resetWalletOwnerGateForTests();
  });

  it('keeps the snapshot on the cold-start publish, wipes it on switch and sign-out', async () => {
    const onWipe = jest.fn();
    const stop = wipeWidgetSnapshotOnAccountChange(onWipe);
    const snapshot = buildWidgetSnapshot([wallet()], 'en', opts);

    await writeWidgetSnapshot(snapshot);
    setActivePubkeyForWalletStorage('alice'); // cold start: the same account
    expect(onWipe).not.toHaveBeenCalled();
    expect(await readWidgetSnapshot()).toEqual(snapshot);

    setActivePubkeyForWalletStorage('bob'); // account switch
    expect(onWipe).toHaveBeenCalledTimes(1);
    await onWipe.mock.calls[0][0];
    expect(await readWidgetSnapshot()).toBeNull();

    await writeWidgetSnapshot(snapshot);
    setActivePubkeyForWalletStorage(null); // sign-out
    expect(onWipe).toHaveBeenCalledTimes(2);
    await onWipe.mock.calls[1][0];
    expect(await readWidgetSnapshot()).toBeNull();

    stop();
  });
});
