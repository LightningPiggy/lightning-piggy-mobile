import type { WalletState } from '../types/wallet';
import { buildWidgetSnapshot, type WidgetSnapshot } from './widgetSnapshot';
import {
  REFETCH_REWRITE_MS,
  WRITE_DEBOUNCE_MS,
  createWidgetSnapshotWriter,
  shouldWriteSnapshot,
  type WriterInput,
} from './widgetSnapshotWriter';

const T0 = 1_800_000_000_000;

const wallet = (patch: Partial<WalletState> = {}): WalletState => ({
  id: 'w1',
  alias: 'Big Hot',
  theme: 'lightning-piggy',
  order: 0,
  walletType: 'nwc',
  lightningAddress: null,
  isConnected: true,
  balance: 1_000,
  walletAlias: null,
  transactions: [],
  ...patch,
});
const input = (patch: Partial<WriterInput> = {}): WriterInput => ({
  wallets: [wallet()],
  hydrated: true,
  locale: 'en',
  btcPrice: 50_000,
  currency: 'USD',
  ...patch,
});

function setup(stored: WidgetSnapshot | null = null) {
  const fetched = new Map<string, number>();
  let storage = stored;
  let releaseRead: (() => void) | null = null;
  let holdRead = false;
  const deps = {
    read: jest.fn(
      () =>
        new Promise<WidgetSnapshot | null>((resolve) => {
          if (holdRead) releaseRead = () => resolve(storage);
          else resolve(storage);
        }),
    ),
    write: jest.fn(async (s: WidgetSnapshot) => {
      storage = s;
    }),
    wipe: jest.fn(async () => {
      storage = null;
    }),
    refresh: jest.fn(async (_s: WidgetSnapshot | null) => undefined),
    fetchedAt: (id: string) => fetched.get(id) ?? null,
  };
  const writer = createWidgetSnapshotWriter(deps);
  return {
    deps,
    writer,
    fetched,
    stored: () => storage,
    holdNextRead: () => {
      holdRead = true;
    },
    releaseRead: () => releaseRead?.(),
  };
}

const settle = () => jest.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS);

beforeEach(() => {
  jest.useFakeTimers();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('createWidgetSnapshotWriter', () => {
  it('debounces a burst of updates into one write and redraw', async () => {
    const { writer, deps } = setup();
    writer.update(input({ btcPrice: 1 }));
    writer.update(input({ btcPrice: 2 }));
    writer.update(input({ btcPrice: 3 }));
    await settle();
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(deps.write.mock.calls[0][0].wallets[0].fiatValue).toBeCloseTo((1_000 / 1e8) * 3);
    expect(deps.refresh).toHaveBeenCalledTimes(1);
  });

  it('writes nothing until the wallets are hydrated', async () => {
    const { writer, deps } = setup();
    writer.update(input({ hydrated: false, wallets: [] }));
    await settle();
    expect(deps.read).not.toHaveBeenCalled();
    expect(deps.write).not.toHaveBeenCalled();
    expect(deps.wipe).not.toHaveBeenCalled();
  });

  it('does not rewrite an unchanged stored snapshot at cold start, and keeps its fetch time', async () => {
    const stored = buildWidgetSnapshot([wallet()], 'en', {
      btcPrice: 50_000,
      currency: 'USD',
      fetchedAt: () => T0 - 3 * 24 * 3_600_000,
    });
    const { writer, deps } = setup(stored);
    writer.update(input());
    await settle();
    expect(deps.write).not.toHaveBeenCalled();
    // A price change rewrites the fiat but never moves the fetch time.
    writer.update(input({ btcPrice: 60_000 }));
    await settle();
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(deps.write.mock.calls[0][0].wallets[0].updatedAt).toBe(T0 - 3 * 24 * 3_600_000);
  });

  it('never stamps a cached on-chain balance as fresh at cold start', async () => {
    const { writer, deps } = setup();
    writer.update(input({ wallets: [wallet({ walletType: 'onchain', isConnected: false })] }));
    await settle();
    expect(deps.write.mock.calls[0][0].wallets[0].updatedAt).toBeNull();
  });

  it('rewrites for a re-fetch only once the fetch time has moved by the threshold', async () => {
    const { writer, deps, fetched } = setup();
    fetched.set('w1', T0);
    writer.update(input());
    await settle();
    expect(deps.write).toHaveBeenCalledTimes(1);

    fetched.set('w1', T0 + 30_000); // a 30-second poll, same balance
    writer.nudge();
    await settle();
    expect(deps.write).toHaveBeenCalledTimes(1);

    fetched.set('w1', T0 + REFETCH_REWRITE_MS);
    writer.nudge();
    await settle();
    expect(deps.write).toHaveBeenCalledTimes(2);
    expect(deps.write.mock.calls[1][0].wallets[0].updatedAt).toBe(T0 + REFETCH_REWRITE_MS);
  });

  it('wipes (once) when the account has no wallets', async () => {
    const stored = buildWidgetSnapshot([wallet()], 'en', { btcPrice: 1, currency: 'USD' });
    const { writer, deps, stored: now } = setup(stored);
    writer.update(input({ wallets: [] }));
    await settle();
    writer.update(input({ wallets: [], btcPrice: 9 }));
    await settle();
    expect(deps.wipe).toHaveBeenCalledTimes(1);
    expect(deps.refresh).toHaveBeenCalledWith(null);
    expect(now()).toBeNull();
    expect(deps.write).not.toHaveBeenCalled();
  });

  it('drops a write that was being prepared when the account changed', async () => {
    const { writer, deps, holdNextRead, releaseRead } = setup();
    holdNextRead();
    writer.update(input());
    await jest.advanceTimersByTimeAsync(WRITE_DEBOUNCE_MS); // run started, waiting on read
    await writer.accountChanged(deps.wipe());
    releaseRead();
    await jest.advanceTimersByTimeAsync(0);
    expect(deps.write).not.toHaveBeenCalled();
    expect(deps.refresh).toHaveBeenCalledWith(null);
  });

  it('cancels a pending write on account change, and writes the new account’s wallets', async () => {
    const { writer, deps } = setup();
    writer.update(input());
    await writer.accountChanged(deps.wipe());
    await settle();
    expect(deps.write).not.toHaveBeenCalled();

    writer.update(input({ wallets: [wallet({ id: 'other', alias: 'Other' })] }));
    await settle();
    expect(deps.write).toHaveBeenCalledTimes(1);
    expect(deps.write.mock.calls[0][0].wallets.map((w) => w.id)).toEqual(['other']);
  });

  it('a nudge after an account change never writes the previous account’s wallets', async () => {
    const { writer, deps } = setup();
    writer.update(input());
    await writer.accountChanged(deps.wipe());
    writer.nudge(); // a fetch for the old account landing late
    await settle();
    expect(deps.write).not.toHaveBeenCalled();
  });

  it('retries a write that failed instead of treating it as stored', async () => {
    const { writer, deps } = setup();
    deps.write.mockRejectedValueOnce(new Error('disk full'));
    writer.update(input());
    await settle();
    writer.nudge(); // same data
    await settle();
    expect(deps.write).toHaveBeenCalledTimes(2);
    expect(deps.refresh).toHaveBeenCalledTimes(1);
  });

  it('retries a wipe that failed for an account with no wallets', async () => {
    const stored = buildWidgetSnapshot([wallet()], 'en', { btcPrice: 1, currency: 'USD' });
    const { writer, deps } = setup(stored);
    deps.wipe.mockRejectedValueOnce(new Error('io'));
    writer.update(input({ wallets: [] }));
    await settle();
    writer.update(input({ wallets: [], btcPrice: 2 }));
    await settle();
    expect(deps.wipe).toHaveBeenCalledTimes(2);
  });

  it('stops after dispose', async () => {
    const { writer, deps } = setup();
    writer.update(input());
    writer.dispose();
    await settle();
    expect(deps.write).not.toHaveBeenCalled();
  });
});

describe('shouldWriteSnapshot', () => {
  const snap = (updatedAt: number | null, balance = 1_000) => ({
    ...buildWidgetSnapshot([wallet({ balance })], 'en', { btcPrice: 1, currency: 'USD' }),
  });
  const withTime = (s: WidgetSnapshot, updatedAt: number | null): WidgetSnapshot => ({
    ...s,
    wallets: s.wallets.map((w) => ({ ...w, updatedAt })),
  });
  const written = (s: WidgetSnapshot) => ({
    snapshot: s,
    fingerprint: JSON.stringify({
      ...s,
      wallets: s.wallets.map((w) => ({ ...w, updatedAt: null })),
    }),
  });

  it('writes the first snapshot and any visible change', () => {
    expect(shouldWriteSnapshot(null, snap(null))).toBe(true);
    expect(shouldWriteSnapshot(written(snap(null)), snap(null, 2_000))).toBe(true);
  });

  it('writes when a fetch time first becomes known, or moves by the threshold', () => {
    const base = withTime(snap(null), null);
    expect(shouldWriteSnapshot(written(base), withTime(base, T0))).toBe(true);
    const at = withTime(base, T0);
    expect(shouldWriteSnapshot(written(at), withTime(base, T0 + 60_000))).toBe(false);
    expect(shouldWriteSnapshot(written(at), withTime(base, T0 + REFETCH_REWRITE_MS))).toBe(true);
    expect(shouldWriteSnapshot(written(at), withTime(base, null))).toBe(false);
  });
});
