import { act, renderHook } from '@testing-library/react-native';
import type { Event } from 'nostr-tools';
import { useListingRepublish } from './useListingRepublish';
import { Alert } from '../components/BrandedAlert';
import { Toast } from '../components/BrandedToast';

let mockFocused = true;

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => void | (() => void)) =>
    jest
      .requireActual('react')
      .useEffect(() => (mockFocused ? effect() : undefined), [effect, mockFocused]),
}));
jest.mock('../contexts/NostrContext', () => ({
  useNostr: () => ({ pubkey: 'seller', relays: [] }),
}));
jest.mock('../contexts/LocaleContext', () => ({ useTranslation: () => (key: string) => key }));
jest.mock('../components/BrandedAlert', () => ({ Alert: { alert: jest.fn() } }));
jest.mock('../components/BrandedToast', () => ({ Toast: { show: jest.fn() } }));
jest.mock('../services/listingRepublish', () => ({
  listingTargetRelays: () => ['wss://example.com'],
  fetchListingCoverage: jest.fn(async () => ({
    copies: [],
    relays: new Map([['wss://example.com', []]]),
  })),
  newestSignedListing: jest.fn(() => null),
  republishListing: jest.fn(),
}));

beforeEach(() => {
  jest.clearAllMocks();
  jest
    .mocked(jest.requireMock('../services/listingRepublish').newestSignedListing)
    .mockReturnValue(null);
  mockFocused = true;
});

it('waits for confirmation then passes the complete stored event to re-signing', async () => {
  const stored: Event = {
    id: 'stored',
    sig: '',
    pubkey: 'seller',
    kind: 30402,
    created_at: 100,
    content: ' Original content ',
    tags: [
      ['d', 'subscription'],
      ['visibility', 'hidden'],
      ['type', 'subscription', 'digital'],
      ['price', '5', 'SATS', 'month'],
      ['extension', 'keep'],
    ],
  };
  const resign = jest.fn(async () => stored);
  const { result } = renderHook(() => useListingRepublish([stored], resign));
  await act(async () => {});
  expect(result.current.coverage.get('subscription')?.missing).toBe(true);
  act(() => result.current.republish(stored));
  expect(resign).not.toHaveBeenCalled();
  const buttons = jest.mocked(Alert.alert).mock.calls[0][2]!;
  expect(buttons[0].style).toBe('cancel');
  await act(async () => {
    buttons[1].onPress!();
  });
  expect(resign).toHaveBeenCalledTimes(1);
  expect(resign).toHaveBeenCalledWith(stored);
});

it.each([true, false])(
  'shows a re-sign error only while focused (focused: %s)',
  async (focused) => {
    const stored: Event = {
      id: 'stored',
      sig: '',
      pubkey: 'seller',
      kind: 30402,
      created_at: 100,
      content: '',
      tags: [['d', 'item']],
    };
    let rejectSigning!: (error: Error) => void;
    const pending = new Promise<Event>((_resolve, reject) => {
      rejectSigning = reject;
    });
    const resign = jest.fn(() => pending);
    const { result, rerender } = renderHook(() => useListingRepublish([stored], resign));
    await act(async () => {});
    act(() => result.current.republish(stored));
    act(() => jest.mocked(Alert.alert).mock.calls[0][2]![1].onPress!());
    if (!focused) {
      mockFocused = false;
      rerender({});
    }
    await act(async () => {
      rejectSigning(new Error('Signing failed'));
    });
    expect(resign).toHaveBeenCalledTimes(1);
    if (focused)
      expect(Toast.show).toHaveBeenCalledWith({
        type: 'error',
        text1: 'market.republish.failed',
        text2: 'Error: Signing failed',
      });
    else expect(Toast.show).not.toHaveBeenCalled();
  },
);

it('opens the progress sheet before relays answer, then fills in results', async () => {
  const services = jest.requireMock('../services/listingRepublish');
  const listing: Event = {
    id: 'signed',
    sig: 'sig',
    pubkey: 'seller',
    kind: 30402,
    created_at: 100,
    content: '',
    tags: [
      ['d', 'item'],
      ['title', 'Piggy mug'],
    ],
  };
  jest.mocked(services.newestSignedListing).mockReturnValue(listing);
  let finish!: () => void;
  jest.mocked(services.republishListing).mockImplementation(
    (
      _pubkey: string,
      _d: string,
      _snapshot: unknown,
      _signal: AbortSignal,
      _timeout: number | undefined,
      onResult: (result: { url: string; status: string }) => void,
    ) =>
      new Promise((resolve) => {
        onResult({ url: 'wss://example.com', status: 'accepted' });
        finish = () => resolve([{ url: 'wss://example.com', status: 'accepted' }]);
      }),
  );
  const { result } = renderHook(() => useListingRepublish([listing], jest.fn()));
  await act(async () => {});
  act(() => result.current.republishAll());
  expect(result.current.progress.open).toBe(true);
  expect(result.current.progress.finished).toBe(false);
  expect(result.current.progress.items).toEqual([
    expect.objectContaining({ key: 'item', title: 'Piggy mug', done: false }),
  ]);
  await act(async () => {
    finish();
  });
  expect(result.current.progress.finished).toBe(true);
  expect(result.current.progress.items[0]).toMatchObject({
    done: true,
    results: [{ url: 'wss://example.com', status: 'accepted' }],
  });
});

it('closes the sheet when the screen loses focus mid-run', async () => {
  const services = jest.requireMock('../services/listingRepublish');
  const listing = {
    id: 'signed',
    sig: 'sig',
    pubkey: 'seller',
    kind: 30402,
    created_at: 1,
    content: '',
    tags: [['d', 'item']],
  } as Event;
  jest.mocked(services.newestSignedListing).mockReturnValue(listing);
  jest
    .mocked(services.republishListing)
    .mockImplementation(
      (_p: string, _d: string, _s: unknown, signal: AbortSignal) =>
        new Promise((resolve) =>
          signal.addEventListener('abort', () => resolve([]), { once: true }),
        ),
    );
  const { result, rerender } = renderHook(() => useListingRepublish([listing], jest.fn()));
  await act(async () => {});
  act(() => result.current.republishAll());
  expect(result.current.progress.open).toBe(true);
  mockFocused = false;
  await act(async () => {
    rerender({});
  });
  expect(result.current.progress.open).toBe(false);
  expect(result.current.busy).toBe(false);
});
