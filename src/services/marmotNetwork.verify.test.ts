// MarmotClient's event verifier (#perf): group events the pool already
// verified must not pay a second Schnorr check, and anything the cache hasn't
// vouched for must still be fully verified — never a pass-through.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { finalizeEvent, generateSecretKey, type Event } from 'nostr-tools';
import { nostrVerifyEvent } from './nostrCrypto';
import { verifyMarmotEvent } from './marmotNetwork';
import { __resetVerifiedEventCache, verifyEventCached } from './nostrVerifyCache';
import { makeRelay, makeSession } from './marmotSessionTestKit';

// Count Schnorr checks (the ~34 ms unit on a Pixel); keep the real crypto.
jest.mock('./nostrCrypto', () => {
  const actual = jest.requireActual('./nostrCrypto');
  return { ...actual, nostrVerifyEvent: jest.fn(actual.nostrVerifyEvent) };
});
const schnorr = jest.mocked(nostrVerifyEvent);

// Capture the options MarmotSession hands to the real MarmotClient.
const mockClientOptions: unknown[] = [];
jest.mock('@internet-privacy/marmot-ts', () => {
  const actual = jest.requireActual('@internet-privacy/marmot-ts');
  return {
    ...actual,
    MarmotClient: jest.fn((opts: unknown) => {
      mockClientOptions.push(opts);
      return new actual.MarmotClient(opts);
    }),
  };
});

const sk = generateSecretKey();
const groupEvent = (content = 'ciphertext') =>
  finalizeEvent(
    { kind: 445, created_at: 1_700_000_000, content, tags: [['h', 'ab'.repeat(32)]] },
    sk,
  );
// A relay hands us a fresh object (no in-memory verifiedSymbol mark).
const fromWire = (event: Event): Event => JSON.parse(JSON.stringify(event));

beforeEach(async () => {
  __resetVerifiedEventCache();
  await AsyncStorage.clear();
  schnorr.mockClear();
});
afterEach(() => __resetVerifiedEventCache());

it('serves an event the pool already verified without a second Schnorr check', () => {
  const event = groupEvent();
  expect(verifyEventCached(fromWire(event))).toBe(true); // the pool's pass
  expect(schnorr).toHaveBeenCalledTimes(1);
  expect(verifyMarmotEvent(fromWire(event))).toBe(true); // marmot-ts' pass
  expect(schnorr).toHaveBeenCalledTimes(1);
});

it('fully verifies an event the cache has not seen, then caches it', () => {
  const event = groupEvent();
  expect(verifyMarmotEvent(fromWire(event))).toBe(true);
  expect(verifyMarmotEvent(fromWire(event))).toBe(true);
  expect(schnorr).toHaveBeenCalledTimes(1);
});

it('rejects a forged signature and a payload swapped under a cached id', () => {
  const event = groupEvent();
  expect(verifyMarmotEvent({ ...fromWire(event), sig: '0'.repeat(128) })).toBe(false);
  expect(verifyMarmotEvent(fromWire(event))).toBe(true);
  expect(verifyMarmotEvent({ ...fromWire(event), content: 'forged' })).toBe(false);
});

it('rejects malformed events instead of throwing', () => {
  expect(verifyMarmotEvent({ ...fromWire(groupEvent()), pubkey: 'not-hex' })).toBe(false);
  expect(verifyMarmotEvent({} as Event)).toBe(false);
});

it('is the verifier MarmotSession hands to MarmotClient', () => {
  makeSession(makeRelay());
  expect(mockClientOptions).toHaveLength(1);
  expect((mockClientOptions[0] as { verifyEvent?: unknown }).verifyEvent).toBe(verifyMarmotEvent);
});
