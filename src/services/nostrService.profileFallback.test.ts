import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { fetchProfile, fetchProfiles, pool } from './nostrService';
import { fetchProfilesBatch } from './nostrProfileBatch';
import { fetchMissingProfileEvents, scheduleMissingProfileFallback } from './profileOutboxFallback';
import { PROFILE_RELAYS } from './nostrRelayDefaults';
import { setCurrentUserPubkey } from './nostrActiveAccount';

// The missing-profile fallback (#1390) only runs for profiles that didn't
// resolve; a profile that resolves keeps the existing path untouched.
jest.mock('./profileOutboxFallback', () => ({
  fetchMissingProfileEvents: jest.fn(),
  scheduleMissingProfileFallback: jest.fn(() => () => {}),
  newFallbackGeneration: jest.requireActual('./profileOutboxFallback').newFallbackGeneration,
}));
jest.mock('./nostrProfileBatch', () => ({ fetchProfilesBatch: jest.fn() }));

const fallback = jest.mocked(fetchMissingProfileEvents);
const schedule = jest.mocked(scheduleMissingProfileFallback);
const batch = jest.mocked(fetchProfilesBatch);
const sk = generateSecretKey();
const pubkey = getPublicKey(sk);
const kind0 = (name: string) =>
  finalizeEvent({ kind: 0, created_at: 100, tags: [], content: JSON.stringify({ name }) }, sk);
const batchEvent = (pk: string, content: string) =>
  ({ pubkey: pk, content, created_at: 1 }) as unknown as Parameters<
    Parameters<typeof fetchProfilesBatch>[3]
  >[0];

let get: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  get = jest.spyOn(pool, 'get');
  fallback.mockResolvedValue(new Map());
});
afterEach(() => get.mockRestore());

describe('fetchProfile', () => {
  it('a profile that resolves never touches the fallback', async () => {
    get.mockResolvedValue(kind0('Eden'));
    expect((await fetchProfile(pubkey, ['wss://mine.example']))?.name).toBe('Eden');
    expect(fallback).not.toHaveBeenCalled();
  });

  it("a miss asks the person's own relays and hints, then verifies the result", async () => {
    get.mockResolvedValue(null);
    fallback.mockResolvedValue(new Map([[pubkey, kind0('Eden')]]));
    const profile = await fetchProfile(pubkey, ['wss://mine.example'], {
      hints: ['wss://hint.example'],
    });
    expect(profile?.name).toBe('Eden');
    const [people, opts] = fallback.mock.calls[0];
    expect(people).toEqual([pubkey]);
    expect(opts.purpose).toBe('verified');
    expect(opts.alreadyAsked).toEqual(
      expect.arrayContaining(['wss://mine.example', ...PROFILE_RELAYS]),
    );
    expect(opts.hints?.get(pubkey)).toEqual(['wss://hint.example']);
  });

  it('rejects a forged kind-0 from the fallback', async () => {
    get.mockResolvedValue(null);
    const forged = { ...kind0('Mallory'), sig: 'f'.repeat(128) };
    fallback.mockResolvedValue(new Map([[pubkey, forged]]));
    expect(await fetchProfile(pubkey, [])).toBeNull();
  });

  it('can opt out (background tasks)', async () => {
    get.mockResolvedValue(null);
    expect(await fetchProfile(pubkey, [], { outboxFallback: false })).toBeNull();
    expect(fallback).not.toHaveBeenCalled();
  });

  it('a main-path kind-0 that fails verification is a miss: the real one is still found', async () => {
    get.mockResolvedValue({ ...kind0('Mallory'), sig: 'f'.repeat(128) });
    fallback.mockResolvedValue(new Map([[pubkey, kind0('Eden')]]));
    const profile = await fetchProfile(pubkey, []);
    expect(fallback).toHaveBeenCalled();
    expect(profile?.name).toBe('Eden');
    // A verified result is dated: its created_at can be trusted.
    expect(profile?.createdAt).toBe(100);
  });
});

describe('fetchProfiles', () => {
  const found = 'b'.repeat(64);

  it('never dates an UNVERIFIED batch profile, so a forged timestamp gets no freshness authority', async () => {
    batch.mockImplementation(async (pubkeys, _r, _t, onEvent) => {
      for (const pk of pubkeys) {
        onEvent({ pubkey: pk, content: '{"name":"Faked"}', created_at: 9_999_999_999 } as never);
      }
    });
    const profiles = await fetchProfiles([found], [], jest.fn());
    expect(profiles.get(found)?.name).toBe('Faked');
    expect(profiles.get(found)?.createdAt).toBeUndefined();
  });
  const missing = 'c'.repeat(64);
  const resolveFoundOnly = () =>
    batch.mockImplementation(async (pubkeys, _relays, _timeout, onEvent) => {
      if (pubkeys.includes(found)) onEvent(batchEvent(found, '{"name":"B"}'));
    });

  it('resolves without waiting for the fallback, which runs later in the background', async () => {
    resolveFoundOnly();
    // A fallback that never finishes can't hold fetchProfiles up.
    schedule.mockImplementation(() => () => {});
    const onBatch = jest.fn();
    const onLateProfiles = jest.fn();
    const profiles = await fetchProfiles([found, missing], ['wss://mine.example'], onBatch, {
      onLateProfiles,
    });
    expect([...profiles.keys()]).toEqual([found]);
    // Main pass + retry pass ran; the fallback was only scheduled, never awaited.
    expect(batch).toHaveBeenCalledTimes(2);
    expect(fallback).not.toHaveBeenCalled();
    expect(onLateProfiles).not.toHaveBeenCalled();
    const [people, opts] = schedule.mock.calls[0];
    expect(people).toEqual([missing]);
    expect(opts).toMatchObject({ purpose: 'display', lookupRelays: ['wss://mine.example'] });
  });

  it('delivers ONLY the newly found profiles, dated, never a full snapshot (#3)', async () => {
    resolveFoundOnly();
    const onBatch = jest.fn();
    const onLateProfiles = jest.fn();
    const profiles = await fetchProfiles([found, missing], [], onBatch, { onLateProfiles });
    const onFound = schedule.mock.calls[0][2];
    onBatch.mockClear();
    onFound(
      new Map([[missing, batchEvent(missing, '{"name":"C","lud16":"c@example.com"}') as never]]),
    );
    const delivered: Map<string, { name?: string; lud16?: string | null; createdAt?: number }> =
      onBatch.mock.calls[0][0];
    // No replay of `found`'s (possibly older) copy.
    expect([...delivered.keys()]).toEqual([missing]);
    expect(delivered.get(missing)?.name).toBe('C');
    // Dated, so the caller merges newest-wins on it.
    expect(delivered.get(missing)?.createdAt).toBe(1);
    // Display-only path: payment fields stripped like any batch profile.
    expect(delivered.get(missing)?.lud16 ?? null).toBeNull();
    expect(onLateProfiles.mock.calls[0][0]).toBe(delivered);
    // The map already returned is left as it was.
    expect(profiles.has(missing)).toBe(false);
  });

  it("a newer refresh cancels the older refresh's fallback (generation, #3)", async () => {
    resolveFoundOnly();
    await fetchProfiles([found, missing], [], jest.fn());
    const older = schedule.mock.calls[0][1].signal!;
    expect(older.aborted).toBe(false);
    await fetchProfiles([found, missing], [], jest.fn());
    expect(older.aborted).toBe(true);
    expect(schedule.mock.calls[1][1].signal!.aborted).toBe(false);
  });

  it('takes the owner when it STARTS, so a switch mid-batch is not handed on (#4)', async () => {
    const owner = 'd'.repeat(64);
    setCurrentUserPubkey(owner);
    batch.mockImplementation(async (pubkeys, _r, _t, onEvent) => {
      // The user switches account while the main batch is still running.
      setCurrentUserPubkey('e'.repeat(64));
      if (pubkeys.includes(found)) onEvent(batchEvent(found, '{}'));
    });
    await fetchProfiles([found, missing], [], jest.fn());
    expect(schedule.mock.calls[0][1].viewerPubkey).toBe(owner);
    setCurrentUserPubkey(null);
  });

  it("a caller's explicit owner wins (a stale load for another account), so the scheduler refuses it", async () => {
    setCurrentUserPubkey('e'.repeat(64)); // B is active...
    batch.mockImplementation(async (pubkeys, _r, _t, onEvent) => {
      if (pubkeys.includes(found)) onEvent(batchEvent(found, '{}'));
    });
    // ...while A's contacts load finishes late.
    await fetchProfiles([found, missing], [], jest.fn(), { owner: 'd'.repeat(64) });
    expect(schedule.mock.calls[0][1].viewerPubkey).toBe('d'.repeat(64));
    setCurrentUserPubkey(null);
  });

  it('schedules nothing when every profile resolved, or without an onBatch to deliver to', async () => {
    batch.mockImplementation(async (pubkeys, _r, _t, onEvent) => {
      for (const pk of pubkeys) onEvent(batchEvent(pk, '{}'));
    });
    await fetchProfiles([found, missing], [], jest.fn());
    resolveFoundOnly();
    await fetchProfiles([found, missing], []);
    expect(schedule).not.toHaveBeenCalled();
  });
});
