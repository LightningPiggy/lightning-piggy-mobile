// Storage-layer tests for the bolt11 settlement cache. Settled is a
// terminal state (paid invoices can't un-pay), so we verify it never
// flips back to false. Unsettled entries have a 24 h TTL — past that
// the cache returns null so the caller re-polls lookupInvoice.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as cache from './bolt11SettlementCache';

jest.mock('@react-native-async-storage/async-storage', () =>
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- Jest factory loads the native storage mock lazily.
  require('@react-native-async-storage/async-storage/jest/async-storage-mock'),
);

beforeEach(async () => {
  await AsyncStorage.clear();
  cache.__resetForTests();
});

describe('bolt11SettlementCache — round-trip', () => {
  it('records and reads back a settled entry', async () => {
    await cache.record('hash-A', true);
    const e = await cache.get('hash-A');
    expect(e?.settled).toBe(true);
    expect(typeof e?.checkedAt).toBe('number');
  });

  it('records and reads back an unsettled entry', async () => {
    await cache.record('hash-B', false);
    const e = await cache.get('hash-B');
    expect(e?.settled).toBe(false);
  });

  it('returns null for unknown payment hashes', async () => {
    const e = await cache.get('hash-unknown');
    expect(e).toBeNull();
  });

  it('returns null for empty payment-hash input', async () => {
    const e = await cache.get('');
    expect(e).toBeNull();
  });
});

describe('bolt11SettlementCache — getMany', () => {
  it('returns settled and fresh-unsettled entries, drops misses', async () => {
    await cache.record('hash-A', true);
    await cache.record('hash-B', false);
    const got = await cache.getMany(['hash-A', 'hash-B', 'hash-missing']);
    expect(got.get('hash-A')?.settled).toBe(true);
    expect(got.get('hash-B')?.settled).toBe(false);
    expect(got.has('hash-missing')).toBe(false);
  });

  it('returns an empty map for empty input', async () => {
    const got = await cache.getMany([]);
    expect(got.size).toBe(0);
  });
});

describe('bolt11SettlementCache — terminal-state semantics', () => {
  it('once settled, a subsequent record(false) is ignored', async () => {
    await cache.record('hash-A', true);
    await cache.record('hash-A', false);
    const e = await cache.get('hash-A');
    expect(e?.settled).toBe(true);
  });

  it('an unsettled entry CAN be flipped to settled', async () => {
    await cache.record('hash-A', false);
    await cache.record('hash-A', true);
    const e = await cache.get('hash-A');
    expect(e?.settled).toBe(true);
  });
});

describe('bolt11SettlementCache — TTL on unsettled', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-01-01T00:00:00Z'));
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('honours an unsettled entry within the 24 h TTL', async () => {
    await cache.record('hash-B', false);
    jest.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    const e = await cache.get('hash-B');
    expect(e?.settled).toBe(false);
  });

  it('returns null for an unsettled entry past the 24 h TTL', async () => {
    await cache.record('hash-B', false);
    jest.setSystemTime(new Date('2026-01-02T01:00:00Z'));
    const e = await cache.get('hash-B');
    expect(e).toBeNull();
  });

  it('honours a settled entry indefinitely (terminal state)', async () => {
    await cache.record('hash-A', true);
    jest.setSystemTime(new Date('2030-01-01T00:00:00Z'));
    const e = await cache.get('hash-A');
    expect(e?.settled).toBe(true);
  });

  it('getMany filters out stale unsettled entries', async () => {
    await cache.record('hash-A', true);
    await cache.record('hash-B', false);
    jest.setSystemTime(new Date('2026-01-02T12:00:00Z'));
    const got = await cache.getMany(['hash-A', 'hash-B']);
    expect(got.get('hash-A')?.settled).toBe(true);
    expect(got.has('hash-B')).toBe(false);
  });
});

describe('bolt11SettlementCache — persistence', () => {
  it('survives a memory-cache reset (re-reads AsyncStorage)', async () => {
    await cache.record('hash-A', true);
    cache.__resetForTests();
    const e = await cache.get('hash-A');
    expect(e?.settled).toBe(true);
  });
});

it('discards legacy positives that could have come from stateless expired lookups', async () => {
  await AsyncStorage.setItem(
    'bolt11_settlement_v1',
    JSON.stringify({
      legacy: { settled: true, checkedAt: Date.now() },
    }),
  );
  expect(await cache.get('legacy')).toBeNull();
  expect((await cache.getMany(['legacy'])).size).toBe(0);
});
