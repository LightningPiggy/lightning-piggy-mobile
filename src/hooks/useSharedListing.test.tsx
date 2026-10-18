import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useSharedListing } from './useSharedListing';
import { loadedMarketSnapshots, readLoadedMarketSnapshots } from '../services/marketStorage';
import { resolveEmbed } from '../services/nostrEmbedCache';
import type { EmbedRef } from '../services/nostrEmbedCache';
import { parseMarketListing } from '../utils/marketListings';
let mockFocused = true;
jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => void | (() => void)) =>
    jest
      .requireActual('react')
      .useEffect(() => (mockFocused ? effect() : undefined), [effect, mockFocused]),
}));
jest.mock('../contexts/NostrContext', () => ({
  useNostr: () => ({ pubkey: 'me', relays: [{ read: true, url: 'wss://read' }] }),
}));
jest.mock('../services/marketStorage', () => ({
  loadedMarketSnapshots: jest.fn(),
  readLoadedMarketSnapshots: jest.fn(),
}));
jest.mock('../services/nostrEmbedCache', () => ({ peekEmbed: jest.fn(), resolveEmbed: jest.fn() }));
const ref: EmbedRef = {
  type: 'address',
  kind: 30402,
  pubkey: 'a'.repeat(64),
  identifier: 'skull',
  relays: ['wss://hint'],
  raw: '',
};
const product = parseMarketListing({
  kind: 30402,
  pubkey: 'a'.repeat(64),
  id: 'b'.repeat(64),
  created_at: 1,
  content: '',
  sig: '',
  tags: [
    ['d', 'skull'],
    ['title', 'Bitcoin Satskull'],
    ['price', '10', 'SAT'],
  ],
})!;
const snapshots = [{ account: 'me', products: [product] }];
beforeEach(() => {
  jest.clearAllMocks();
  mockFocused = true;
  jest.mocked(loadedMarketSnapshots).mockReturnValue([]);
  jest.mocked(readLoadedMarketSnapshots).mockResolvedValue([]);
  jest.mocked(resolveEmbed).mockResolvedValue({ event: null });
});
it('paints from the loaded Market snapshot without disk or relay I/O', () => {
  jest.mocked(loadedMarketSnapshots).mockReturnValue(snapshots);
  const h = renderHook(() => useSharedListing(ref));
  expect(h.result.current).toBe(product);
  expect(readLoadedMarketSnapshots).not.toHaveBeenCalled();
  expect(resolveEmbed).not.toHaveBeenCalled();
});
it('hydrates the persisted Market snapshot before relay lookup', async () => {
  jest.mocked(readLoadedMarketSnapshots).mockResolvedValue(snapshots);
  const h = renderHook(() => useSharedListing(ref));
  await waitFor(() => expect(h.result.current).toBe(product));
  expect(resolveEmbed).not.toHaveBeenCalled();
});
it('uses hinted batched lookup for misses and aborts on blur', async () => {
  jest.mocked(resolveEmbed).mockReturnValue(new Promise(() => {}));
  const h = renderHook(() => useSharedListing(ref));
  await waitFor(() => expect(resolveEmbed).toHaveBeenCalledTimes(1));
  expect(resolveEmbed).toHaveBeenCalledWith(ref, ['wss://read'], expect.anything());
  const signal = jest.mocked(resolveEmbed).mock.calls[0][2]!;
  expect(h.result.current).toBeUndefined();
  mockFocused = false;
  h.rerender({});
  expect(signal.aborted).toBe(true);
});
it('does not start relay work when blurred during disk hydration', async () => {
  let finish!: (value: []) => void;
  jest.mocked(readLoadedMarketSnapshots).mockReturnValue(
    new Promise((r) => {
      finish = r;
    }),
  );
  const h = renderHook(() => useSharedListing(ref));
  mockFocused = false;
  h.rerender({});
  await act(async () => finish([]));
  expect(resolveEmbed).not.toHaveBeenCalled();
});
