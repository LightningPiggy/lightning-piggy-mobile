import { act, renderHook } from '@testing-library/react-native';
import { finalizeEvent, getPublicKey, type Event } from 'nostr-tools';
import { useSellerActions, StaleRevisionError } from './useSellerActions';
import { fetchLatestRevision, publishSellerEvent } from '../services/marketSellerService';
import {
  SHOP_COLLECTION_D,
  buildShippingZoneTemplate,
  buildListingTemplate,
  coordinateOf,
} from '../utils/marketSellerEvents';
import { reduceSellerSnapshot, type SellerSnapshot } from '../utils/marketSellerSnapshot';

jest.mock('../contexts/NostrContext', () => ({ useNostr: () => mockAccount }));
jest.mock('../services/marketSellerService', () => ({
  fetchLatestRevision: jest.fn(),
  publishSellerEvent: jest.fn(),
  persistSellerSnapshot: jest.fn(),
  saveHiddenListings: jest.fn(),
  sellerRelays: () => ['wss://example.com'],
}));
const key = new Uint8Array(32).fill(7);
const pubkey = getPublicKey(key);
const mockSign = jest.fn(async (t) => finalizeEvent(t, key));
let mockAccount = { pubkey, relays: [], signEvent: mockSign };
const zone = { dTag: 'uk', name: 'UK', countries: ['GB'], cost: '3', currency: 'GBP' };
const oldZone = finalizeEvent({ ...buildShippingZoneTemplate(zone), created_at: 100 }, key);
const newZone = finalizeEvent(
  { ...buildShippingZoneTemplate({ ...zone, cost: '9' }), created_at: 200 },
  key,
);
const coordinate = coordinateOf(30406, pubkey, 'uk');
const snapshot: SellerSnapshot = {
  shop: null,
  zones: [],
  zoneEvents: new Map([[coordinate, newZone]]),
  listings: [],
};
const base = {
  shop: null,
  zoneCoordinates: [coordinate],
  zoneEvents: new Map([[coordinate, oldZone]]),
};
const shop = { name: 'Shop', description: '', currency: 'GBP' };
const fetched = (event: Event | null) => event;

beforeEach(() => {
  jest.clearAllMocks();
  mockAccount = { pubkey, relays: [], signEvent: mockSign };
  (fetchLatestRevision as jest.Mock).mockImplementation(async ({ kind }) =>
    fetched(kind === 30406 ? newZone : null),
  );
  (publishSellerEvent as jest.Mock).mockResolvedValue(undefined);
});

it.each(['edit', 'remove'])(
  'checks the retained zone form base before any %s mutation',
  async (action) => {
    const { result } = renderHook(() => useSellerActions(snapshot));
    await act(async () => {
      await expect(
        result.current.saveShop(shop, action === 'edit' ? [zone] : [], base),
      ).rejects.toBeInstanceOf(StaleRevisionError);
    });
    expect(mockSign).not.toHaveBeenCalled();
    expect(publishSellerEvent).not.toHaveBeenCalled();
  },
);

it('checks all zones before publishing an earlier changed zone', async () => {
  const { result } = renderHook(() => useSellerActions(snapshot));
  (fetchLatestRevision as jest.Mock).mockImplementation(async ({ dTag }) =>
    fetched(dTag === 'uk' ? newZone : null),
  );
  await act(async () => {
    await expect(
      result.current.saveShop(shop, [{ ...zone, dTag: 'new' }, zone], base),
    ).rejects.toBeInstanceOf(StaleRevisionError);
  });
  expect(mockSign).not.toHaveBeenCalled();
});

it('cancels a shop save when the account changes during revision lookup', async () => {
  let finish!: (value: ReturnType<typeof fetched>) => void;
  (fetchLatestRevision as jest.Mock).mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const { result, rerender } = renderHook(() => useSellerActions(snapshot));
  let pending!: Promise<void>;
  act(() => {
    pending = result.current.saveShop(shop, [zone], {
      shop: null,
      zoneCoordinates: [],
      zoneEvents: new Map(),
    });
  });
  mockAccount = { ...mockAccount, pubkey: getPublicKey(new Uint8Array(32).fill(8)) };
  rerender({});
  await act(async () => {
    finish(fetched(null));
    await expect(pending).rejects.toThrow('account changed');
  });
  expect(mockSign).not.toHaveBeenCalled();
  expect(publishSellerEvent).not.toHaveBeenCalled();
});

it('uses the confirmed latest zone revision when the user overwrites', async () => {
  const { result } = renderHook(() => useSellerActions(snapshot));
  await act(async () => {
    await result.current.saveShop(shop, [zone], base, { force: true });
  });
  expect(publishSellerEvent).toHaveBeenCalledTimes(1);
  expect(mockSign.mock.calls[0][0].created_at).toBeGreaterThan(newZone.created_at);
});

it.each([0, 60])(
  'recreates strictly after an address deletion %s seconds ahead of the clock',
  async (ahead) => {
    const now = Math.floor(Date.now() / 1000);
    const deletedAt = now + ahead;
    jest.spyOn(Date, 'now').mockReturnValue(now * 1000);
    try {
      const draft = {
        dTag: 'book',
        title: 'Book',
        description: 'Book',
        images: [],
        price: '21',
        currency: 'SAT',
        quantity: '1',
        categories: [],
        shipping: [],
      };
      const old = finalizeEvent(
        { ...buildListingTemplate({ draft, pubkey, nowSeconds: 100 }), created_at: 100 },
        key,
      );
      const deletion = finalizeEvent(
        {
          kind: 5,
          created_at: deletedAt,
          content: '',
          tags: [['a', coordinateOf(30402, pubkey, draft.dTag)]],
        },
        key,
      );
      (fetchLatestRevision as jest.Mock).mockResolvedValue({
        event: null,
        deletedAt,
        deletedIds: [],
      });
      const { result } = renderHook(() => useSellerActions(snapshot));
      await act(async () => {
        await expect(result.current.saveListing(draft, old)).rejects.toBeInstanceOf(
          StaleRevisionError,
        );
      });
      expect(mockSign).not.toHaveBeenCalled();
      await act(async () => {
        const recreated = await result.current.saveListing(draft, old, { force: true });
        expect(recreated.created_at).toBe(deletedAt + 1);
        expect(reduceSellerSnapshot([old, deletion, recreated], pubkey).listings).toEqual([
          recreated,
        ]);
      });
    } finally {
      jest.restoreAllMocks();
    }
  },
);

it.each(['deleted', 'older', 'newer', 'tie'])(
  'removing a zone never fetches or republishes listings when the relay revision is %s',
  async (revision) => {
    const draft = {
      dTag: 'book',
      title: 'Book',
      description: 'Updated description',
      images: [],
      price: '20',
      currency: 'GBP',
      quantity: '1',
      categories: [],
      shipping: [],
    };
    const cached = finalizeEvent(
      {
        ...buildListingTemplate({ draft, pubkey, nowSeconds: 200 }),
        created_at: 200,
        tags: [
          ['d', 'book'],
          ['price', '20', 'GBP'],
          ['shipping_option', coordinate],
        ],
      },
      key,
    );
    const returned =
      revision === 'deleted'
        ? null
        : finalizeEvent(
            {
              kind: cached.kind,
              content: 'Relay description',
              created_at: revision === 'older' ? 100 : revision === 'tie' ? 200 : 300,
              tags: [
                ['d', 'book'],
                ['price', '10', 'GBP'],
                ['shipping_option', coordinate],
              ],
            },
            key,
          );
    (fetchLatestRevision as jest.Mock).mockImplementation(async ({ kind }) =>
      kind === 30402
        ? { event: returned, deletedAt: -1, deletedIds: [] }
        : kind === 30406
          ? oldZone
          : null,
    );
    const { result } = renderHook(() => useSellerActions({ ...snapshot, listings: [cached] }));
    await act(async () => {
      await result.current.saveShop(shop, [], base);
    });
    const published = (publishSellerEvent as jest.Mock).mock.calls.map(([event]) => event as Event);
    expect(published.map((event) => event.kind)).toEqual([5]);
    expect(published[0].tags).toEqual([
      ['a', coordinate],
      ['e', oldZone.id],
      ['k', '30406'],
    ]);
    expect(published[0].created_at).toBeGreaterThanOrEqual(oldZone.created_at);
    expect(fetchLatestRevision).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 30402 }));
  },
);

it('saving shop settings never creates or updates a shop-name collection', async () => {
  const { result } = renderHook(() => useSellerActions(snapshot));
  (fetchLatestRevision as jest.Mock).mockResolvedValue(null);
  await act(async () => {
    await result.current.saveShop({ currency: 'GBP' }, [{ ...zone, dTag: 'new' }], {
      shop: null,
      zoneCoordinates: [],
      zoneEvents: new Map(),
    });
  });
  expect((publishSellerEvent as jest.Mock).mock.calls.map(([e]) => e.kind)).toEqual([30406]);
  expect(fetchLatestRevision).not.toHaveBeenCalledWith(expect.objectContaining({ kind: 30405 }));
});

it('collection edits reject conflicts and merge the confirmed current collection extensions', async () => {
  const old = finalizeEvent(
    {
      kind: 30405,
      content: 'Notes',
      tags: [
        ['d', 'art'],
        ['title', 'Old'],
      ],
      created_at: 100,
    },
    key,
  );
  const latest = finalizeEvent(
    {
      kind: 30405,
      content: 'Latest notes',
      tags: [
        ['d', 'art'],
        ['title', 'New'],
        ['custom', 'keep'],
      ],
      created_at: 200,
    },
    key,
  );
  (fetchLatestRevision as jest.Mock).mockResolvedValue(latest);
  const { result } = renderHook(() => useSellerActions(snapshot));
  const draft = {
    dTag: 'art',
    title: 'Prints',
    summary: 'Art prints',
    image: '',
    location: '',
    shipping: [],
    products: [`30402:${pubkey}:print`],
  };
  await act(async () => {
    await expect(result.current.saveCollection(draft, old)).rejects.toBeInstanceOf(
      StaleRevisionError,
    );
  });
  expect(mockSign).not.toHaveBeenCalled();
  await act(async () => {
    await result.current.saveCollection(draft, old, { force: true });
  });
  const signed = (publishSellerEvent as jest.Mock).mock.calls[0][0];
  expect(signed.kind).toBe(30405);
  expect(signed.content).toBe('Latest notes');
  expect(signed.tags).toContainEqual(['custom', 'keep']);
  expect(signed.tags).toContainEqual(['a', `30402:${pubkey}:print`]);
});

it('collection deletion checks revisions then publishes NIP-09 for the confirmed revision', async () => {
  const old = finalizeEvent(
    {
      kind: 30405,
      content: '',
      tags: [
        ['d', 'art'],
        ['title', 'Art'],
      ],
      created_at: 100,
    },
    key,
  );
  const latest = finalizeEvent({ ...old, created_at: 200 }, key);
  (fetchLatestRevision as jest.Mock).mockResolvedValue(latest);
  const { result } = renderHook(() => useSellerActions(snapshot));
  await act(async () => {
    await expect(result.current.deleteCollection(old)).rejects.toBeInstanceOf(StaleRevisionError);
  });
  expect(mockSign).not.toHaveBeenCalled();
  await act(async () => {
    await result.current.deleteCollection(old, { force: true });
  });
  expect((publishSellerEvent as jest.Mock).mock.calls[0][0].tags).toEqual([
    ['a', `30405:${pubkey}:art`],
    ['e', latest.id],
    ['k', '30405'],
  ]);
});

it.each(['repurposed', 'missing', 'empty', 'foreign'])(
  'legacy migration refuses the current %s collection even after confirmation',
  async (revision) => {
    const legacy = finalizeEvent(
      {
        kind: 30405,
        content: '',
        tags: [
          ['d', 'lightning-piggy-shop'],
          ['currency', 'GBP'],
        ],
        created_at: 100,
      },
      key,
    );
    const latest =
      revision === 'empty'
        ? null
        : revision === 'missing'
          ? { event: null, deletedAt: 200, deletedIds: [legacy.id] }
          : finalizeEvent(
              {
                ...legacy,
                tags:
                  revision === 'repurposed'
                    ? [
                        ['d', 'lightning-piggy-shop'],
                        ['title', 'Repurposed'],
                      ]
                    : legacy.tags,
                created_at: 200,
              },
              revision === 'foreign' ? new Uint8Array(32).fill(8) : key,
            );
    (fetchLatestRevision as jest.Mock).mockResolvedValue(latest);
    const { result } = renderHook(() => useSellerActions(snapshot));
    await act(async () => {
      await expect(
        result.current.deleteLegacyCollection(legacy, { force: true }),
      ).rejects.toThrow();
    });
    expect(mockSign).not.toHaveBeenCalled();
    expect(publishSellerEvent).not.toHaveBeenCalled();
  },
);
it('legacy migration discards a deletion if the collection is repurposed during signing', async () => {
  const legacy = finalizeEvent(
    {
      kind: 30405,
      content: '',
      tags: [
        ['d', SHOP_COLLECTION_D],
        ['currency', 'GBP'],
      ],
      created_at: 100,
    },
    key,
  );
  const repurposed = finalizeEvent(
    {
      ...legacy,
      tags: [
        ['d', SHOP_COLLECTION_D],
        ['title', 'Repurposed'],
      ],
      created_at: 200,
    },
    key,
  );
  (fetchLatestRevision as jest.Mock)
    .mockResolvedValueOnce(legacy)
    .mockResolvedValueOnce(repurposed);
  const { result } = renderHook(() => useSellerActions(snapshot));
  await act(async () => {
    await expect(result.current.deleteLegacyCollection(legacy, { force: true })).rejects.toThrow();
  });
  expect(mockSign).toHaveBeenCalledTimes(1);
  expect(publishSellerEvent).not.toHaveBeenCalled();
});

it('legacy migration deletes a current owned legacy revision after both checks', async () => {
  const legacy = finalizeEvent(
    {
      kind: 30405,
      content: '',
      tags: [
        ['d', 'lightning-piggy-shop'],
        ['currency', 'GBP'],
      ],
      created_at: 100,
    },
    key,
  );
  (fetchLatestRevision as jest.Mock).mockResolvedValue(legacy);
  const { result } = renderHook(() => useSellerActions(snapshot));
  await act(async () => {
    await result.current.deleteLegacyCollection(legacy);
  });
  expect(fetchLatestRevision).toHaveBeenCalledTimes(2);
  expect(publishSellerEvent).toHaveBeenCalledTimes(1);
  expect((publishSellerEvent as jest.Mock).mock.calls[0][0].tags).toContainEqual(['e', legacy.id]);
});

it.each(['hidden', 'on-sale'])(
  're-signs a %s subscription with its complete stored payload',
  async (visibility) => {
    const stored: Event = {
      id: 'missing-signature',
      sig: '',
      pubkey,
      kind: 30402,
      created_at: Math.floor(Date.now() / 1000) + 60,
      content: '  Original description\n',
      tags: [
        ['d', 'subscription'],
        ['title', ' Subscription '],
        ['visibility', visibility],
        ['type', 'subscription', 'digital'],
        ['price', '005', 'SAT', 'month'],
        ['published_at', '100'],
        ['extension', 'first', 'extra'],
        ['extension', 'second'],
      ],
    };
    const original = JSON.parse(JSON.stringify(stored));
    const { result } = renderHook(() => useSellerActions(snapshot));
    await act(async () => {
      const signed = await result.current.resignListing(stored);
      expect(signed.kind).toBe(stored.kind);
      expect(signed.content).toBe(stored.content);
      expect(signed.tags).toEqual(stored.tags);
      expect(signed.tags).not.toBe(stored.tags);
      expect(signed.tags[0]).not.toBe(stored.tags[0]);
      expect(signed.created_at).toBe(stored.created_at + 1);
      expect(publishSellerEvent).toHaveBeenCalledWith(signed, ['wss://example.com']);
    });
    expect(mockSign).toHaveBeenCalledTimes(1);
    expect(fetchLatestRevision).toHaveBeenCalledWith({
      pubkey,
      kind: 30402,
      dTag: 'subscription',
      baseId: stored.id,
      relays: ['wss://example.com'],
    });
    expect(stored).toEqual(original);
  },
);

it.each(['newer', 'deleted-address', 'deleted-id', 'unreachable'])(
  'refuses to re-sign a stored listing when the current revision is %s',
  async (revision) => {
    const stored = finalizeEvent(
      { kind: 30402, tags: [['d', 'item']], content: 'Original', created_at: 100 },
      key,
    );
    const fetch = jest.mocked(fetchLatestRevision);
    if (revision === 'unreachable') fetch.mockRejectedValueOnce(new Error('offline'));
    else if (revision === 'newer')
      fetch.mockResolvedValueOnce({
        event: finalizeEvent({ ...stored, created_at: 200 }, key),
        deletedAt: -1,
        deletedIds: [],
      });
    else
      fetch.mockResolvedValueOnce({
        event: null,
        deletedAt: revision === 'deleted-address' ? 100 : -1,
        deletedIds: revision === 'deleted-id' ? [stored.id] : [],
      });
    const { result } = renderHook(() => useSellerActions(snapshot));
    await act(async () => {
      await expect(result.current.resignListing(stored)).rejects.toThrow(
        revision === 'unreachable' ? 'offline' : 'A newer revision exists',
      );
    });
    expect(mockSign).not.toHaveBeenCalled();
    expect(publishSellerEvent).not.toHaveBeenCalled();
  },
);

it.each(['author', 'kind'])('rejects re-signing an unexpected listing %s', async (field) => {
  const stored = {
    ...oldZone,
    kind: field === 'kind' ? 30406 : 30402,
    pubkey: field === 'author' ? 'someone-else' : pubkey,
  };
  const { result } = renderHook(() => useSellerActions(snapshot));
  await act(async () => {
    await expect(result.current.resignListing(stored)).rejects.toThrow('Unexpected listing');
  });
  expect(mockSign).not.toHaveBeenCalled();
  expect(publishSellerEvent).not.toHaveBeenCalled();
});
