import { act, renderHook } from '@testing-library/react-native';
import { loadPiggies, type HiddenPiggy } from '../services/piggyStorageService';
import { useOwnedPiggies } from './useOwnedPiggies';

jest.mock('../services/piggyStorageService', () => ({ loadPiggies: jest.fn() }));

const load = jest.mocked(loadPiggies);
const piggy = (id: string): HiddenPiggy => ({ id, lnurlw: 'x', createdAt: 1, isPublic: false });
const RECORDS: Record<string, HiddenPiggy[]> = { A: [piggy('a1')], B: [piggy('b1')] };

beforeEach(() => {
  load.mockReset();
  load.mockImplementation(async (owner) => (owner ? (RECORDS[owner] ?? []) : []));
});

const keys = (m: ReadonlyMap<string, HiddenPiggy>) => [...m.keys()];

it("never surfaces the previous account's records after a switch (#1781)", async () => {
  let resolveB: (list: HiddenPiggy[]) => void = () => {};
  const h = renderHook(({ owner }: { owner: string | null }) => useOwnedPiggies(owner), {
    initialProps: { owner: 'A' as string | null },
  });
  await act(async () => {});
  expect(keys(h.result.current.piggiesById)).toEqual(['a1']);

  load.mockImplementationOnce(() => new Promise((r) => (resolveB = r)));
  h.rerender({ owner: 'B' });
  // B's load is still pending: A's snapshot must not render under B.
  expect(keys(h.result.current.piggiesById)).toEqual([]);
  await act(async () => resolveB(RECORDS.B));
  expect(keys(h.result.current.piggiesById)).toEqual(['b1']);

  h.rerender({ owner: null });
  expect(keys(h.result.current.piggiesById)).toEqual([]);
  await act(async () => {});
  expect(keys(h.result.current.piggiesById)).toEqual([]);
});

it("ignores a patch for an account that's no longer shown", async () => {
  const h = renderHook(({ owner }: { owner: string }) => useOwnedPiggies(owner), {
    initialProps: { owner: 'A' },
  });
  await act(async () => {});
  h.rerender({ owner: 'B' });
  await act(async () => {});
  // A republish / delete started under A finishes after the switch.
  act(() => h.result.current.upsertPiggy('A', piggy('late')));
  act(() => h.result.current.dropPiggy('A', 'b1'));
  expect(keys(h.result.current.piggiesById)).toEqual(['b1']);
  act(() => h.result.current.upsertPiggy('B', piggy('b2')));
  act(() => h.result.current.dropPiggy('B', 'b1'));
  expect(keys(h.result.current.piggiesById)).toEqual(['b2']);
});

it("keeps the new account's list when an earlier account's refresh lands late", async () => {
  let resolveA: (list: HiddenPiggy[]) => void = () => {};
  const h = renderHook(({ owner }: { owner: string }) => useOwnedPiggies(owner), {
    initialProps: { owner: 'A' },
  });
  await act(async () => {});
  load.mockImplementationOnce(() => new Promise((r) => (resolveA = r)));
  let refresh: Promise<void> = Promise.resolve();
  act(() => {
    refresh = h.result.current.reloadPiggies();
  });
  h.rerender({ owner: 'B' });
  await act(async () => {});
  expect(keys(h.result.current.piggiesById)).toEqual(['b1']);
  // A's pull-to-refresh finishes after the switch.
  await act(async () => {
    resolveA(RECORDS.A);
    await refresh;
  });
  expect(keys(h.result.current.piggiesById)).toEqual(['b1']);
});
