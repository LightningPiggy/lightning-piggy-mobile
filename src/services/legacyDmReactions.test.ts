import AsyncStorage from '@react-native-async-storage/async-storage';

import {
  forgetOwnLegacyDmReactions,
  LEGACY_DM_REACTIONS_NONE_KEY_BASE,
  LEGACY_DM_REACTIONS_NONE_TTL_MS,
  readOwnLegacyDmReactions,
} from './legacyDmReactions';
import { perAccountKey } from './perAccountStorage';
import type { ChatReactionEvent } from '../utils/nip17Reactions';

// A read every relay answered.
const full = (events: ChatReactionEvent[]) => ({ events, complete: true });

const ME = 'a'.repeat(64);
const OTHER = 'd'.repeat(64);
const markerKey = (pubkey: string) => perAccountKey(LEGACY_DM_REACTIONS_NONE_KEY_BASE, pubkey);

const legacy = (pubkey: string): ChatReactionEvent => ({
  id: '9'.repeat(64),
  pubkey,
  kind: 7,
  content: '👍',
  created_at: 1,
  tags: [['e', '1'.repeat(64)]],
});

beforeEach(async () => {
  await forgetOwnLegacyDmReactions(ME);
  await forgetOwnLegacyDmReactions(OTHER);
});

it('reads once per account per session, whoever asks', async () => {
  const fetch = jest.fn(async () => full([legacy(ME), legacy(OTHER)]));
  const [a, b] = await Promise.all([
    readOwnLegacyDmReactions(ME, fetch),
    readOwnLegacyDmReactions(ME.toUpperCase(), fetch),
  ]);
  expect(await readOwnLegacyDmReactions(ME, fetch)).toBe(a);
  expect(a).toEqual([legacy(ME)]); // only our own
  expect(b).toBe(a);
  expect(fetch).toHaveBeenCalledTimes(1);
  // Not empty: no marker, so the next session reads again.
  expect(await AsyncStorage.getItem(markerKey(ME))).toBeNull();

  const otherFetch = jest.fn(async () => full([]));
  await readOwnLegacyDmReactions(OTHER, otherFetch);
  expect(otherFetch).toHaveBeenCalledTimes(1);
});

it("doesn't keep a failed read, so the next caller retries", async () => {
  const fetch = jest
    .fn<Promise<ReturnType<typeof full>>, []>()
    .mockRejectedValueOnce(new Error('relays down'))
    .mockResolvedValueOnce(full([legacy(ME)]));
  expect(await readOwnLegacyDmReactions(ME, fetch)).toBeNull();
  expect(await AsyncStorage.getItem(markerKey(ME))).toBeNull();
  expect(await readOwnLegacyDmReactions(ME, fetch)).toEqual([legacy(ME)]);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('marks an empty read, and a later session skips the query for a week', async () => {
  const fetch = jest.fn(async () => full([]));
  expect(await readOwnLegacyDmReactions(ME, fetch)).toEqual([]);
  const marked = Number(await AsyncStorage.getItem(markerKey(ME)));
  expect(Date.now() - marked).toBeLessThan(5_000);

  // A later session: the in-memory read is gone, the marker remains.
  await forgetOwnLegacyDmReactions(ME);
  await AsyncStorage.setItem(markerKey(ME), String(marked));
  fetch.mockClear();
  expect(await readOwnLegacyDmReactions(ME, fetch)).toEqual([]);
  expect(fetch).not.toHaveBeenCalled();

  // An expired marker reads again.
  await forgetOwnLegacyDmReactions(ME);
  await AsyncStorage.setItem(
    markerKey(ME),
    String(Date.now() - LEGACY_DM_REACTIONS_NONE_TTL_MS - 1),
  );
  expect(await readOwnLegacyDmReactions(ME, fetch)).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it("doesn't mark an empty read that some relays didn't answer", async () => {
  const fetch = jest.fn(async () => ({ events: [] as ChatReactionEvent[], complete: false }));
  expect(await readOwnLegacyDmReactions(ME, fetch)).toEqual([]);
  expect(await AsyncStorage.getItem(markerKey(ME))).toBeNull();
  // The next session reads again.
  await forgetOwnLegacyDmReactions(ME);
  expect(await readOwnLegacyDmReactions(ME, fetch)).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('reads anyway when the marker read fails', async () => {
  jest.mocked(AsyncStorage.getItem).mockRejectedValueOnce(new Error('storage'));
  const fetch = jest.fn(async () => full([legacy(ME)]));
  expect(await readOwnLegacyDmReactions(ME, fetch)).toEqual([legacy(ME)]);
  expect(fetch).toHaveBeenCalledTimes(1);
});

it('forgets the read and the marker on account wipe', async () => {
  await readOwnLegacyDmReactions(ME, async () => full([]));
  await forgetOwnLegacyDmReactions(ME);
  expect(await AsyncStorage.getItem(markerKey(ME))).toBeNull();
  const fetch = jest.fn(async () => full([legacy(ME)]));
  expect(await readOwnLegacyDmReactions(ME, fetch)).toEqual([legacy(ME)]);
  expect(fetch).toHaveBeenCalledTimes(1);
});
