import { renderHook, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as profileCache from '../services/zapSenderProfileStorage';
import type { NostrContact, NostrProfile } from '../types/nostr';
import { MAX_MEMBER_PROFILE_FETCH, useGroupMemberProfiles } from './useGroupMemberProfiles';

const SELF = 'a'.repeat(64);
const FRIEND = 'b'.repeat(64);
const STRANGER = 'c'.repeat(64);
const CACHED = 'e'.repeat(64);

const fetched = (pubkey: string, name: string): NostrProfile => ({
  pubkey,
  npub: `npub-${name}`,
  name,
  displayName: null,
  picture: `https://x/${name}.png`,
  banner: null,
  about: null,
  lud16: null,
  nip05: null,
  hasLud16: true,
});

const friendContact = { pubkey: FRIEND, relay: null, petname: null, profile: null } as NostrContact;

interface Props {
  memberPubkeys: string[];
  messages?: { senderPubkey: string }[];
  enabled: boolean;
}

function setup(
  fetchProfilesForPubkeys: (pks: string[]) => Promise<Map<string, NostrProfile>>,
  initialProps: Props,
) {
  return renderHook(
    (props: Props) =>
      useGroupMemberProfiles({
        ...props,
        selfPubkey: SELF,
        contacts: [friendContact],
        fetchProfilesForPubkeys,
      }),
    { initialProps },
  );
}

beforeEach(async () => {
  await AsyncStorage.clear();
  profileCache.__resetForTests();
});

describe('useGroupMemberProfiles', () => {
  it('batches historical senders with current members and resolves later arrivals', async () => {
    const fetchProfiles = jest.fn(
      async (pubkeys: string[]) =>
        new Map(
          pubkeys.map((pk) => [pk, fetched(pk, pk === STRANGER ? 'former member' : 'member')]),
        ),
    );
    const { result, rerender } = setup(fetchProfiles, {
      memberPubkeys: [CACHED],
      messages: [SELF, FRIEND, STRANGER, STRANGER.toUpperCase(), CACHED].map((senderPubkey) => ({
        senderPubkey,
      })),
      enabled: true,
    });
    await waitFor(() => expect(result.current.get(STRANGER)?.name).toBe('former member'));
    expect(result.current.get(CACHED)?.name).toBe('member');
    expect(fetchProfiles).toHaveBeenCalledTimes(1);
    expect(fetchProfiles).toHaveBeenCalledWith([CACHED, STRANGER]);

    const newcomer = 'd'.repeat(64);
    rerender({
      memberPubkeys: [CACHED],
      messages: [STRANGER, newcomer].map((senderPubkey) => ({ senderPubkey })),
      enabled: true,
    });
    await waitFor(() => expect(result.current.get(newcomer)?.name).toBe('member'));
    expect(fetchProfiles).toHaveBeenCalledTimes(2);
    expect(fetchProfiles).toHaveBeenLastCalledWith([newcomer]);
  });

  it('does not touch relays while the sheet is closed', async () => {
    const fetchProfiles = jest.fn(async () => new Map<string, NostrProfile>());
    setup(fetchProfiles, { memberPubkeys: [SELF, FRIEND, STRANGER], enabled: false });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchProfiles).not.toHaveBeenCalled();
  });

  it('fetches only non-followed, non-self members in one batch when enabled', async () => {
    const fetchProfiles = jest.fn(async () => new Map([[STRANGER, fetched(STRANGER, 'stranger')]]));
    const { result, rerender } = setup(fetchProfiles, {
      memberPubkeys: [SELF, FRIEND, STRANGER],
      enabled: false,
    });
    rerender({ memberPubkeys: [SELF, FRIEND, STRANGER], enabled: true });
    await waitFor(() => expect(result.current.get(STRANGER)?.name).toBe('stranger'));
    expect(fetchProfiles).toHaveBeenCalledTimes(1);
    expect(fetchProfiles).toHaveBeenCalledWith([STRANGER]);
  });

  it('serves cache hits without fetching, and writes fetches back without lud16', async () => {
    await profileCache.setMany(
      new Map([
        [CACHED, { npub: 'n', name: 'cached', displayName: null, picture: null, nip05: null }],
      ]),
    );
    const fetchProfiles = jest.fn(async () => new Map([[STRANGER, fetched(STRANGER, 'stranger')]]));
    const { result } = setup(fetchProfiles, { memberPubkeys: [CACHED, STRANGER], enabled: true });
    await waitFor(() => expect(result.current.get(STRANGER)?.name).toBe('stranger'));
    expect(result.current.get(CACHED)?.name).toBe('cached');
    expect(fetchProfiles).toHaveBeenCalledWith([STRANGER]);
    const written = await profileCache.get(STRANGER);
    expect(written?.name).toBe('stranger');
    // Left undefined so usePubkeyProfile still runs its verified fetch.
    expect(written?.lud16).toBeUndefined();
  });

  it('attempts each member once per mount across sheet re-opens', async () => {
    const fetchProfiles = jest.fn(async () => new Map<string, NostrProfile>());
    const { rerender } = setup(fetchProfiles, { memberPubkeys: [STRANGER], enabled: true });
    await waitFor(() => expect(fetchProfiles).toHaveBeenCalledTimes(1));
    rerender({ memberPubkeys: [STRANGER], enabled: false });
    rerender({ memberPubkeys: [STRANGER], enabled: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(fetchProfiles).toHaveBeenCalledTimes(1);
  });

  it('releases a failed batch so the next open retries', async () => {
    const fetchProfiles = jest
      .fn<Promise<Map<string, NostrProfile>>, [string[]]>()
      .mockRejectedValueOnce(new Error('relay down'))
      .mockResolvedValueOnce(new Map([[STRANGER, fetched(STRANGER, 'stranger')]]));
    const { result, rerender } = setup(fetchProfiles, { memberPubkeys: [STRANGER], enabled: true });
    await waitFor(() => expect(fetchProfiles).toHaveBeenCalledTimes(1));
    rerender({ memberPubkeys: [STRANGER], enabled: false });
    rerender({ memberPubkeys: [STRANGER], enabled: true });
    await waitFor(() => expect(result.current.get(STRANGER)?.name).toBe('stranger'));
    expect(fetchProfiles).toHaveBeenCalledTimes(2);
  });

  it('bounds the batch size', async () => {
    const many = Array.from({ length: MAX_MEMBER_PROFILE_FETCH + 20 }, (_, i) =>
      i.toString(16).padStart(64, 'f'),
    );
    const fetchProfiles = jest.fn(async (_pks: string[]) => new Map<string, NostrProfile>());
    setup(fetchProfiles, { memberPubkeys: many, enabled: true });
    await waitFor(() => expect(fetchProfiles).toHaveBeenCalledTimes(1));
    expect(fetchProfiles.mock.calls[0][0]).toHaveLength(MAX_MEMBER_PROFILE_FETCH);
  });
});
