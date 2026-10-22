import {
  checkMarmotAvailability,
  invalidateMarmotAvailability,
  peekMarmotAvailability,
  resetMarmotAvailabilityCache,
  type MarmotAvailabilitySession,
} from './marmotAvailability';
import {
  MarmotKeyPackageLookupError,
  MarmotUnusableKeyPackageError,
} from '../services/marmotKeyPackages';

const viewer = 'a'.repeat(64);
const peer = 'b'.repeat(64);

function makeSession(over: Partial<MarmotAvailabilitySession> = {}) {
  const findDm = jest.fn<unknown, [string]>(() => undefined);
  return {
    pubkey: viewer,
    ready: Promise.resolve(),
    canMessage: jest.fn(async () => true),
    ...over,
    findDm,
  };
}

beforeEach(() => resetMarmotAvailabilityCache());

it('reports available when the peer has a usable key package, and caches it', async () => {
  const s = makeSession();
  expect(await checkMarmotAvailability(s, peer)).toBe('available');
  expect(peekMarmotAvailability(s, peer)).toBe('available');
  expect(await checkMarmotAvailability(s, peer.toUpperCase())).toBe('available');
  expect(s.canMessage).toHaveBeenCalledTimes(1);
});

it('reports unavailable when relays answered with no key packages, and caches it', async () => {
  const s = makeSession({ canMessage: jest.fn(async () => false) });
  expect(await checkMarmotAvailability(s, peer)).toBe('unavailable');
  expect(await checkMarmotAvailability(s, peer)).toBe('unavailable');
  expect(s.canMessage).toHaveBeenCalledTimes(1);
});

it('treats only-unusable key packages as unavailable', async () => {
  const s = makeSession({
    canMessage: jest.fn(async () => {
      throw new MarmotUnusableKeyPackageError(peer);
    }),
  });
  expect(await checkMarmotAvailability(s, peer)).toBe('unavailable');
});

it('never reads a failed lookup as "not on Marmot", and never caches it', async () => {
  const s = makeSession({
    canMessage: jest
      .fn()
      .mockRejectedValueOnce(new MarmotKeyPackageLookupError(peer))
      .mockResolvedValueOnce(true),
  });
  expect(await checkMarmotAvailability(s, peer)).toBe('error');
  expect(peekMarmotAvailability(s, peer)).toBeNull();
  expect(await checkMarmotAvailability(s, peer)).toBe('available');
});

it('times a hung lookup out as an error', async () => {
  jest.useFakeTimers();
  try {
    const s = makeSession({ canMessage: jest.fn(() => new Promise<boolean>(() => {})) });
    const result = checkMarmotAvailability(s, peer, { timeoutMs: 1_000 });
    await jest.advanceTimersByTimeAsync(1_000);
    expect(await result).toBe('error');
    expect(peekMarmotAvailability(s, peer)).toBeNull();
  } finally {
    jest.useRealTimers();
  }
});

it('is an error (retryable) without a Marmot session', async () => {
  expect(await checkMarmotAvailability(null, peer)).toBe('error');
  expect(peekMarmotAvailability(null, peer)).toBeNull();
});

it('shares one lookup between concurrent calls', async () => {
  let finish!: (v: boolean) => void;
  const s = makeSession({ canMessage: jest.fn(() => new Promise<boolean>((r) => (finish = r))) });
  const a = checkMarmotAvailability(s, peer);
  const b = checkMarmotAvailability(s, peer);
  await Promise.resolve();
  await Promise.resolve();
  finish(true);
  expect(await a).toBe('available');
  expect(await b).toBe('available');
  expect(s.canMessage).toHaveBeenCalledTimes(1);
});

it('force re-checks a cached answer (retry)', async () => {
  const s = makeSession({
    canMessage: jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
  });
  expect(await checkMarmotAvailability(s, peer)).toBe('unavailable');
  expect(await checkMarmotAvailability(s, peer, { force: true })).toBe('available');
});

it('an existing Marmot chat supersedes a cached "unavailable"', async () => {
  const s = makeSession({ canMessage: jest.fn(async () => false) });
  expect(await checkMarmotAvailability(s, peer)).toBe('unavailable');
  s.findDm.mockReturnValue({ id: 'marmot:1' });
  expect(peekMarmotAvailability(s, peer)).toBe('available');
});

it('invalidation drops the cached answer for that peer only', async () => {
  const other = 'c'.repeat(64);
  const s = makeSession({ canMessage: jest.fn(async () => false) });
  await checkMarmotAvailability(s, peer);
  await checkMarmotAvailability(s, other);
  invalidateMarmotAvailability(peer.toUpperCase());
  expect(peekMarmotAvailability(s, peer)).toBeNull();
  expect(peekMarmotAvailability(s, other)).toBe('unavailable');
});

it('keys the cache per viewer account', async () => {
  const s = makeSession({ canMessage: jest.fn(async () => false) });
  await checkMarmotAvailability(s, peer);
  const other = makeSession({ pubkey: 'd'.repeat(64) });
  expect(peekMarmotAvailability(other, peer)).toBeNull();
});

it('expires unavailable answers after two minutes and discovers newly published keys', async () => {
  jest.useFakeTimers();
  try {
    const s = makeSession({
      canMessage: jest.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true),
    });
    expect(await checkMarmotAvailability(s, peer)).toBe('unavailable');
    await jest.advanceTimersByTimeAsync(2 * 60_000 - 1);
    expect(await checkMarmotAvailability(s, peer)).toBe('unavailable');
    expect(s.canMessage).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(peekMarmotAvailability(s, peer)).toBeNull();
    expect(await checkMarmotAvailability(s, peer)).toBe('available');
    await jest.advanceTimersByTimeAsync(24 * 60 * 60_000);
    expect(await checkMarmotAvailability(s, peer)).toBe('available');
    expect(s.canMessage).toHaveBeenCalledTimes(2);
  } finally {
    jest.useRealTimers();
  }
});

it.each([false, true])(
  'discards an invalidated lookup without disturbing its replacement (replacement finishes first: %s)',
  async (replacementFirst) => {
    let finishOld!: (value: boolean) => void;
    let finishNew!: (value: boolean) => void;
    const s = makeSession({
      canMessage: jest
        .fn()
        .mockImplementationOnce(() => new Promise<boolean>((resolve) => (finishOld = resolve)))
        .mockImplementationOnce(() => new Promise<boolean>((resolve) => (finishNew = resolve))),
    });
    const old = checkMarmotAvailability(s, peer);
    await Promise.resolve();
    invalidateMarmotAvailability(peer);
    const replacement = checkMarmotAvailability(s, peer);
    await Promise.resolve();
    if (replacementFirst) {
      finishNew(true);
      expect(await replacement).toBe('available');
    }
    finishOld(false);
    expect(await old).toBe('error');
    if (!replacementFirst) {
      expect(peekMarmotAvailability(s, peer)).toBeNull();
      expect(checkMarmotAvailability(s, peer)).toBe(replacement);
      finishNew(true);
      expect(await replacement).toBe('available');
    }
    expect(peekMarmotAvailability(s, peer)).toBe('available');
    expect(s.canMessage).toHaveBeenCalledTimes(2);
  },
);
