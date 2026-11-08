import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { fetchProfile, fetchProfiles, pool } from './nostrService';
import { fetchProfilesBatch } from './nostrProfileBatch';
import { fetchMissingProfileEvents, scheduleMissingProfileFallback } from './profileOutboxFallback';
import { PROFILE_RELAYS } from './nostrRelayDefaults';

// The missing-profile fallback (#1390) only runs for profiles that didn't
// resolve; a profile that resolves keeps the existing path untouched.
jest.mock('./profileOutboxFallback', () => ({
  fetchMissingProfileEvents: jest.fn(),
  scheduleMissingProfileFallback: jest.fn(() => () => {}),
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
});

describe('fetchProfiles', () => {
  const found = 'b'.repeat(64);
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

  it('merges late finds through onBatch and hands only the new ones to onLateProfiles', async () => {
    resolveFoundOnly();
    const onBatch = jest.fn();
    const onLateProfiles = jest.fn();
    const profiles = await fetchProfiles([found, missing], [], onBatch, { onLateProfiles });
    const onFound = schedule.mock.calls[0][2];
    onBatch.mockClear();
    onFound(
      new Map([[missing, batchEvent(missing, '{"name":"C","lud16":"c@example.com"}') as never]]),
    );
    const snapshot: Map<string, { name?: string; lud16?: string | null }> =
      onBatch.mock.calls[0][0];
    expect([...snapshot.keys()].sort()).toEqual([found, missing]);
    expect(snapshot.get(missing)?.name).toBe('C');
    // Display-only path: payment fields stripped like any batch profile.
    expect(snapshot.get(missing)?.lud16 ?? null).toBeNull();
    const late: Map<string, unknown> = onLateProfiles.mock.calls[0][0];
    expect([...late.keys()]).toEqual([missing]);
    // The map already returned is left as it was.
    expect(profiles.has(missing)).toBe(false);
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
