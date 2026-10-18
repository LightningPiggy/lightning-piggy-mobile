import { act, renderHook } from '@testing-library/react-native';
import type { NostrProfile } from '../types/nostr';
import { fetchProfile } from '../services/nostrService';
import { useAccountState } from './useAccountState';
import { useOwnProfile } from './useOwnProfile';
import { readCachedWithTtl } from './nostrCacheKeys';

jest.mock('../services/nostrService', () => ({ fetchProfile: jest.fn() }));
jest.mock('./nostrCacheKeys', () => ({
  ...jest.requireActual('./nostrCacheKeys'),
  readCachedWithTtl: jest.fn(async () => ({ value: null, ageMs: Infinity })),
}));

it('ignores an own-profile fetch that finishes after an account switch', async () => {
  let finish: (profile: NostrProfile) => void = () => {};
  (fetchProfile as jest.Mock).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { result, rerender } = renderHook(
    ({ owner }: { owner: string }) => {
      const [profile, , setterFor] = useAccountState<NostrProfile | null>(owner, null);
      return { profile, ...useOwnProfile(setterFor) };
    },
    { initialProps: { owner: 'a' } },
  );
  let loading: Promise<void>;
  await act(async () => {
    loading = result.current.loadProfile('a', []);
    await Promise.resolve();
  });
  rerender({ owner: 'b' });
  await act(async () => {
    finish({ name: 'Account A' } as NostrProfile);
    await loading!;
  });
  expect(result.current.profile).toBeNull();
});

it('hydrates a stale saved own profile before a switched-account refresh that misses', async () => {
  const cached = { name: 'Big Piggy', displayName: 'Big Piggy' } as NostrProfile;
  jest.mocked(readCachedWithTtl).mockResolvedValueOnce({ value: cached, ageMs: Infinity });
  let finish!: (profile: NostrProfile | null) => void;
  jest.mocked(fetchProfile).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const { result } = renderHook(() => {
    const [profile, , setterFor] = useAccountState<NostrProfile | null>('b', null);
    return { profile, ...useOwnProfile(setterFor) };
  });
  let loading!: Promise<void>;
  await act(async () => {
    loading = result.current.loadProfile('b', []);
    await Promise.resolve();
  });
  expect(result.current.profile).toEqual(cached);
  await act(async () => {
    finish(null);
    await loading;
  });
  expect(result.current.profile).toEqual(cached);
});
