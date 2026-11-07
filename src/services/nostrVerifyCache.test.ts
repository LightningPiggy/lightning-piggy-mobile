import { schnorr } from '@noble/curves/secp256k1.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { finalizeEvent, verifiedSymbol } from 'nostr-tools/pure';
import {
  __resetVerifiedEventCache,
  __verifiedEventCacheSize,
  verifyEventCached,
  flushVerifiedEventCache,
  hydrateVerifiedEventCache,
} from './nostrVerifyCache';

const key = new Uint8Array(32).fill(3);
const signed = () =>
  finalizeEvent({ kind: 1, created_at: 1700000000, content: 'hi', tags: [] }, key);

beforeEach(async () => {
  __resetVerifiedEventCache();
  await AsyncStorage.clear();
});
afterEach(() => __resetVerifiedEventCache());

it('verifies once, then serves the same event from the cache', () => {
  const event = signed();
  expect(verifyEventCached({ ...event })).toBe(true);
  expect(__verifiedEventCacheSize()).toBe(1);
  expect(verifyEventCached(JSON.parse(JSON.stringify(event)))).toBe(true);
});

it('rejects a forged payload that reuses a cached id', () => {
  const event = signed();
  expect(verifyEventCached({ ...event })).toBe(true);
  const forged = JSON.parse(JSON.stringify({ ...event, content: 'pay me instead' }));
  expect(verifyEventCached(forged)).toBe(false);
});

it('does not cache events that fail the signature check', () => {
  const bad = JSON.parse(JSON.stringify({ ...signed(), sig: '0'.repeat(128) }));
  expect(verifyEventCached(bad)).toBe(false);
  expect(__verifiedEventCacheSize()).toBe(0);
});

it('rejects content and signature substitution after hydrating persisted trust', async () => {
  const event = signed();
  expect(verifyEventCached(event)).toBe(true);
  await flushVerifiedEventCache();
  __resetVerifiedEventCache();
  await hydrateVerifiedEventCache();
  expect(verifyEventCached({ ...event })).toBe(true);
  expect(verifyEventCached({ ...event, content: 'forged' })).toBe(false);
  expect(verifyEventCached({ ...event, sig: '0'.repeat(128) })).toBe(false);
});

it('does not trust nostr-tools verifiedSymbol supplied on a forged object', () => {
  const forged = { ...signed(), content: 'forged', [verifiedSymbol]: true };
  expect(verifyEventCached(forged)).toBe(false);
});

it('falls back to verification when persistent storage is corrupt', async () => {
  await AsyncStorage.setItem('nostr_verified_v1_00', 'invalid json');
  await hydrateVerifiedEventCache();
  expect(__verifiedEventCacheSize()).toBe(0);
  expect(verifyEventCached({ ...signed(), sig: '0'.repeat(128) })).toBe(false);
});

it('does not confer trust when storage cannot be read', async () => {
  // The AsyncStorage jest mock is already a jest.fn: never mockRestore() it
  // (that would strip its implementation for every later test).
  jest.spyOn(AsyncStorage, 'multiGet').mockRejectedValueOnce(new Error('storage unavailable'));
  await hydrateVerifiedEventCache();
  expect(__verifiedEventCacheSize()).toBe(0);
  expect(verifyEventCached({ ...signed(), sig: '0'.repeat(128) })).toBe(false);
});

it('fully verifies distinct valid Schnorr signatures for the same canonical event and id', async () => {
  const event = signed();
  const first = {
    ...event,
    sig: bytesToHex(schnorr.sign(hexToBytes(event.id), key, new Uint8Array(32))),
  };
  const second = {
    ...event,
    sig: bytesToHex(schnorr.sign(hexToBytes(event.id), key, new Uint8Array(32).fill(1))),
  };
  expect(first.id).toBe(second.id);
  expect(first.sig).not.toBe(second.sig);
  expect(verifyEventCached(first)).toBe(true);
  await flushVerifiedEventCache();
  __resetVerifiedEventCache();
  await hydrateVerifiedEventCache();
  expect(verifyEventCached(second)).toBe(true);
  expect(verifyEventCached({ ...second, sig: '0'.repeat(128), [verifiedSymbol]: true })).toBe(
    false,
  );
  expect(verifyEventCached(second)).toBe(true);
  expect(verifyEventCached(first)).toBe(true);
  expect(__verifiedEventCacheSize()).toBe(1);
});

it('hydrates all 256 shards with ONE storage round trip, not 256 serial reads', async () => {
  // One well-formed record per shard (a leading id byte each): hydration only
  // checks shape here; a hit still re-hashes and compares the signature.
  for (let i = 0; i < 256; i++) {
    const bucket = i.toString(16).padStart(2, '0');
    const record = [bucket + 'a'.repeat(62), 'b'.repeat(128)];
    await AsyncStorage.setItem(`nostr_verified_v1_${bucket}`, JSON.stringify([record]));
  }
  const multiGet = jest.spyOn(AsyncStorage, 'multiGet');
  const getItem = jest.spyOn(AsyncStorage, 'getItem');
  multiGet.mockClear();
  getItem.mockClear();
  await hydrateVerifiedEventCache();
  expect(multiGet).toHaveBeenCalledTimes(1);
  expect(multiGet.mock.calls[0][0]).toHaveLength(256);
  expect(getItem).not.toHaveBeenCalled();
  expect(__verifiedEventCacheSize()).toBe(256);
});

it('ignores a shard stored under the wrong bucket', async () => {
  const event = signed();
  const wrong = event.id.slice(0, 2) === '00' ? '01' : '00';
  await AsyncStorage.setItem(`nostr_verified_v1_${wrong}`, JSON.stringify([[event.id, event.sig]]));
  await hydrateVerifiedEventCache();
  expect(__verifiedEventCacheSize()).toBe(0);
});

it('does not resurrect trust when the cache is reset mid-hydration', async () => {
  const event = signed();
  expect(verifyEventCached(event)).toBe(true);
  await flushVerifiedEventCache();
  __resetVerifiedEventCache();
  const pending = hydrateVerifiedEventCache();
  __resetVerifiedEventCache(); // e.g. sign-out while the read is in flight
  await pending;
  expect(__verifiedEventCacheSize()).toBe(0);
});
