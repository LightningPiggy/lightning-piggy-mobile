import { act, renderHook, waitFor } from '@testing-library/react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { NostrContact, NostrProfile } from '../types/nostr';
import type { DmInboxEntry } from '../utils/conversationSummaries';
import { nonFollowProfilesKey, useNonFollowProfiles } from './useNonFollowProfiles';

const A = 'a'.repeat(64);
const B = 'b'.repeat(64);
const PARTNER = 'c'.repeat(64);
const FRIEND = 'd'.repeat(64);

const entry = (partnerPubkey: string): DmInboxEntry => ({
  id: `id-${partnerPubkey.slice(0, 4)}`,
  partnerPubkey,
  fromMe: false,
  createdAt: 1,
  text: 'hi',
  wireKind: 14,
});
const profile = (name: string): NostrProfile =>
  ({ name, picture: `https://x/${name}.png` }) as NostrProfile;

interface Props {
  pubkey: string | null;
  dmInbox: DmInboxEntry[];
  contacts: NostrContact[];
}

function setup(fetchProfilesForPubkeys: (pks: string[]) => Promise<Map<string, NostrProfile>>) {
  return renderHook((props: Props) => useNonFollowProfiles({ ...props, fetchProfilesForPubkeys }), {
    initialProps: { pubkey: A, dmInbox: [entry(PARTNER)], contacts: [] } as Props,
  });
}

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('useNonFollowProfiles', () => {
  it('keeps a fetched profile when the inbox / contacts re-render mid-fetch', async () => {
    let resolveFetch: (m: Map<string, NostrProfile>) => void = () => {};
    const fetchProfiles = jest.fn(
      () => new Promise<Map<string, NostrProfile>>((r) => (resolveFetch = r)),
    );
    const { result, rerender } = setup(fetchProfiles);
    await waitFor(() => expect(fetchProfiles).toHaveBeenCalledWith([PARTNER]));

    // Contacts land while the kind-0 fetch is still in flight (the post-switch
    // churn that used to cancel the fetch and strand the partner as an npub).
    rerender({
      pubkey: A,
      dmInbox: [entry(PARTNER)],
      contacts: [{ pubkey: FRIEND, profile: profile('friend') } as NostrContact],
    });
    await act(async () => resolveFetch(new Map([[PARTNER, profile('partner')]])));

    expect(result.current.contactInfoMap.get(PARTNER)?.name).toBe('partner');
    expect(fetchProfiles).toHaveBeenCalledTimes(1);
  });

  it('discards a fetch that resolves after an account switch and never persists it under the new account', async () => {
    let resolveFetch: (m: Map<string, NostrProfile>) => void = () => {};
    const fetchProfiles = jest.fn(
      () => new Promise<Map<string, NostrProfile>>((r) => (resolveFetch = r)),
    );
    const { result, rerender } = setup(fetchProfiles);
    await waitFor(() => expect(fetchProfiles).toHaveBeenCalled());

    rerender({ pubkey: B, dmInbox: [], contacts: [] });
    await act(async () => resolveFetch(new Map([[PARTNER, profile('partner')]])));

    expect(result.current.nonFollowProfiles.size).toBe(0);
    expect(await AsyncStorage.getItem(nonFollowProfilesKey(B))).toBeNull();
  });

  it("does not show or copy the previous account's cached profiles after a switch", async () => {
    const fetchProfiles = jest.fn(async () => new Map([[PARTNER, profile('partner')]]));
    const { result, rerender } = setup(fetchProfiles);
    await waitFor(() => expect(result.current.nonFollowProfiles.size).toBe(1));

    rerender({ pubkey: B, dmInbox: [], contacts: [] });
    expect(result.current.nonFollowProfiles.size).toBe(0);
    await act(async () => {});
    expect(await AsyncStorage.getItem(nonFollowProfilesKey(B))).toBeNull();
    expect(await AsyncStorage.getItem(nonFollowProfilesKey(A))).not.toBeNull();
  });

  it('also names extra people (group senders, people mentioned in previews), never the viewer', async () => {
    const MENTIONED = 'e'.repeat(64);
    const fetchProfiles = jest.fn(
      async (pks: string[]) => new Map(pks.map((pk) => [pk, profile(pk.slice(0, 1))])),
    );
    const { result } = renderHook(() =>
      useNonFollowProfiles({
        pubkey: A,
        dmInbox: [],
        contacts: [],
        fetchProfilesForPubkeys: fetchProfiles,
        extraPubkeys: [MENTIONED, A],
      }),
    );
    await waitFor(() => expect(result.current.contactInfoMap.get(MENTIONED)?.name).toBe('e'));
    expect(fetchProfiles).toHaveBeenCalledWith([MENTIONED]);
  });

  it('retries a partner after a failed fetch', async () => {
    const fetchProfiles = jest
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(new Map([[PARTNER, profile('partner')]]));
    const { result, rerender } = setup(fetchProfiles);
    await waitFor(() => expect(fetchProfiles).toHaveBeenCalledTimes(1));
    await act(async () => {});

    rerender({ pubkey: A, dmInbox: [entry(PARTNER), entry(PARTNER)], contacts: [] });
    await waitFor(() => expect(result.current.contactInfoMap.get(PARTNER)?.name).toBe('partner'));
    expect(fetchProfiles).toHaveBeenCalledTimes(2);
  });
  it("hydrates each account's own disk cache and never applies a stale one after a switch", async () => {
    await AsyncStorage.setItem(
      nonFollowProfilesKey(A),
      JSON.stringify({ [PARTNER]: profile('cached-for-a') }),
    );
    const fetchProfiles = jest.fn(async () => new Map<string, NostrProfile>());
    // Switch to B in the same tick, before A's disk read resolves.
    const { result, rerender } = setup(fetchProfiles);
    rerender({ pubkey: B, dmInbox: [], contacts: [] });
    await act(async () => {});
    expect(result.current.nonFollowProfiles.size).toBe(0);
    expect(await AsyncStorage.getItem(nonFollowProfilesKey(B))).toBeNull();

    // Back on A, its own disk cache paints (the fetch mock returns nothing).
    rerender({ pubkey: A, dmInbox: [entry(PARTNER)], contacts: [] });
    await waitFor(() =>
      expect(result.current.contactInfoMap.get(PARTNER)?.name).toBe('cached-for-a'),
    );
  });
});

it('re-arms kind-0 loading for the new account and rejects the old account response', async () => {
  const finish: ((profiles: Map<string, NostrProfile>) => void)[] = [];
  const fetchProfiles = jest.fn(
    () => new Promise<Map<string, NostrProfile>>((resolve) => finish.push(resolve)),
  );
  const { result, rerender } = setup(fetchProfiles);
  await waitFor(() => expect(fetchProfiles).toHaveBeenCalledTimes(1));
  rerender({ pubkey: B, dmInbox: [entry(PARTNER)], contacts: [] });
  await waitFor(() => expect(fetchProfiles).toHaveBeenCalledTimes(2));
  await act(async () => finish[1](new Map([[PARTNER, profile('for-b')]])));
  await act(async () => finish[0](new Map([[PARTNER, profile('stale-for-a')]])));
  expect(result.current.contactInfoMap.get(PARTNER)?.name).toBe('for-b');
  expect(await AsyncStorage.getItem(nonFollowProfilesKey(B))).toContain('for-b');
  expect(await AsyncStorage.getItem(nonFollowProfilesKey(B))).not.toContain('stale-for-a');
});
