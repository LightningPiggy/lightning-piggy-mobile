import {
  buildProfileRows,
  chunk,
  collectMediaTiles,
  countTopLevelPosts,
  MAX_AUTO_PAGES,
  shouldAutoPage,
  sortFeed,
} from './profileFeedRows';
import type { AuthorFeedEvent } from '../services/authorFeedService';
import type { MarketProduct } from '../data/marketProducts';

const ev = (
  id: string,
  created_at: number,
  over: Partial<AuthorFeedEvent> = {},
): AuthorFeedEvent => ({
  id,
  pubkey: 'p',
  kind: 1,
  created_at,
  content: '',
  tags: [],
  ...over,
});
const product = (id: string) => ({ id }) as MarketProduct;
const base = { feed: [], feedLoading: false, products: [], productsLoading: false };

describe('sortFeed / chunk', () => {
  it('sorts newest first with a stable id tie-break', () => {
    expect(sortFeed([ev('b', 1), ev('c', 2), ev('a', 1)]).map((e) => e.id)).toEqual([
      'c',
      'a',
      'b',
    ]);
  });

  it('chunks into fixed-size rows', () => {
    expect(chunk([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
  });
});

describe('collectMediaTiles', () => {
  it('collects media across events, dropping repeated URLs', () => {
    const tiles = collectMediaTiles([
      ev('1', 2, { content: 'https://x.example/a.png https://x.example/b.mp4' }),
      ev('2', 1, { content: 'again https://x.example/a.png' }),
      ev('3', 1, { kind: 20, tags: [['imeta', 'url https://x.example/c']] }),
    ]);
    expect(tiles.map((t) => [t.eventId, t.item.type])).toEqual([
      ['1', 'image'],
      ['1', 'video'],
      ['3', 'image'],
    ]);
  });

  it("carries each tile's author, which decides auto-load vs tap-to-load (#1338)", () => {
    const tiles = collectMediaTiles([
      ev('1', 2, { pubkey: 'alice', content: 'https://x.example/a.png' }),
      ev('2', 1, { pubkey: 'bob', content: 'https://x.example/b.png' }),
    ]);
    expect(tiles.map((t) => t.authorPubkey)).toEqual(['alice', 'bob']);
  });
});

describe('buildProfileRows', () => {
  it('shows only kind-1 notes on Posts', () => {
    const rows = buildProfileRows({
      ...base,
      tab: 'posts',
      feed: [ev('1', 2), ev('2', 1, { kind: 20 })],
    });
    expect(rows).toEqual([{ type: 'post', key: '1', event: ev('1', 2), reply: null }]);
  });

  it('hides replies by default and shows them with context in Posts & replies', () => {
    const parent = '2'.repeat(64);
    const feed = [
      ev('top', 3),
      ev('re', 2, { tags: [['e', parent, '', 'reply', 'b'.repeat(64)]] }),
      ev('quote', 1, { tags: [['q', parent]] }),
    ];
    const posts = buildProfileRows({ ...base, tab: 'posts', feed });
    expect(posts.map((r) => r.key)).toEqual(['top', 'quote']);
    const all = buildProfileRows({ ...base, tab: 'posts', postsMode: 'all', feed });
    expect(all.map((r) => r.key)).toEqual(['top', 're', 'quote']);
    const reply = all[1];
    expect(reply.type === 'post' && reply.reply?.ref.id).toBe(parent);
    expect(reply.type === 'post' && reply.reply?.authorPubkey).toBe('b'.repeat(64));
    expect(all[0].type === 'post' && all[0].reply).toBeNull();
    expect(countTopLevelPosts(feed)).toBe(2);
  });

  it('shows NIP-22 note comments only in Posts & replies, with the parent (#1337)', () => {
    const note = '7'.repeat(64);
    const ben = '9'.repeat(64);
    const comment = ev('ditto', 2, {
      kind: 1111,
      content: 'a Ditto reply',
      tags: [
        ['E', note, '', ben],
        ['K', '1'],
        ['e', note, '', ben],
        ['k', '1'],
        ['p', ben],
      ],
    });
    const feed = [ev('top', 3), comment];
    expect(buildProfileRows({ ...base, tab: 'posts', feed }).map((r) => r.key)).toEqual(['top']);
    const all = buildProfileRows({ ...base, tab: 'posts', postsMode: 'all', feed });
    expect(all.map((r) => r.key)).toEqual(['top', 'ditto']);
    const row = all[1];
    expect(row.type === 'post' && row.reply?.ref.id).toBe(note);
    expect(row.type === 'post' && row.reply?.authorPubkey).toBe(ben);
    expect(countTopLevelPosts(feed)).toBe(1);
    // Only comments loaded: Posts points at the other mode.
    expect(buildProfileRows({ ...base, tab: 'posts', feed: [comment] })[0]).toMatchObject({
      status: 'onlyReplies',
    });
  });

  it('drops a comment that echoes a kind-1 reply, and ignores product comments', () => {
    const note = '7'.repeat(64);
    const feed = [
      ev('k1', 3, { content: 'same', tags: [['e', note, '', 'root']] }),
      ev('echo', 2, {
        kind: 1111,
        content: 'same',
        tags: [
          ['E', note],
          ['K', '1'],
        ],
      }),
      ev('product', 1, {
        kind: 1111,
        content: 'nice socks',
        tags: [
          ['A', `30402:${'9'.repeat(64)}:socks`],
          ['K', '30402'],
        ],
      }),
    ];
    const all = buildProfileRows({ ...base, tab: 'posts', postsMode: 'all', feed });
    expect(all.map((r) => r.key)).toEqual(['k1']);
  });

  it('says when only replies are loaded in Posts mode', () => {
    const feed = [ev('re', 2, { tags: [['e', '2'.repeat(64)]] })];
    expect(buildProfileRows({ ...base, tab: 'posts', feed })[0]).toMatchObject({
      status: 'onlyReplies',
    });
  });

  it('shows loading then empty status rows', () => {
    expect(buildProfileRows({ ...base, tab: 'posts', feedLoading: true })[0]).toMatchObject({
      status: 'loading',
    });
    expect(buildProfileRows({ ...base, tab: 'media' })[0]).toMatchObject({ status: 'emptyMedia' });
    expect(buildProfileRows({ ...base, tab: 'shop' })[0]).toMatchObject({
      status: 'emptyShop',
    });
  });

  it('says posts could not be loaded, never a false "no posts yet", when no relay answered', () => {
    for (const tab of ['posts', 'media'] as const) {
      expect(buildProfileRows({ ...base, tab, feedUnavailable: true })[0]).toMatchObject({
        status: 'feedUnavailable',
      });
    }
    // Still loading wins; a real answer with nothing in it is still "empty".
    expect(
      buildProfileRows({ ...base, tab: 'posts', feedLoading: true, feedUnavailable: true })[0],
    ).toMatchObject({ status: 'loading' });
    expect(buildProfileRows({ ...base, tab: 'posts' })[0]).toMatchObject({ status: 'emptyPosts' });
    // Posts that did arrive are shown, whatever the flag says.
    const shown = buildProfileRows({
      ...base,
      tab: 'posts',
      feed: [ev('1', 1)],
      feedUnavailable: true,
    });
    expect(shown[0]).toMatchObject({ type: 'post' });
  });

  it('says listings could not be loaded rather than "nothing for sale"', () => {
    expect(buildProfileRows({ ...base, tab: 'shop', productsIncomplete: true })[0]).toMatchObject({
      status: 'shopUnavailable',
    });
  });

  it('chunks media into rows of three and products into rows of two', () => {
    const feed = [
      ev('1', 1, { content: [1, 2, 3, 4].map((n) => `https://x.example/${n}.jpg`).join(' ') }),
    ];
    const media = buildProfileRows({ ...base, tab: 'media', feed });
    expect(media.map((r) => (r.type === 'media' ? r.tiles.length : 0))).toEqual([3, 1]);
    const products = buildProfileRows({
      ...base,
      tab: 'shop',
      products: [product('a'), product('b'), product('c')],
    });
    expect(products.map((r) => r.key)).toEqual(['products-a', 'products-c']);
  });
});

describe('shouldAutoPage', () => {
  const idle = {
    focused: true,
    tab: 'posts' as const,
    postsMode: 'posts' as const,
    loading: false,
    loadingMore: false,
    reachedEnd: false,
    feedSize: 30,
    topLevelCount: 3,
    autoPages: 0,
  };

  it('pages past replies while the Posts view is short of posts', () => {
    expect(shouldAutoPage(idle)).toBe(true);
  });

  it('never pages while blurred, even after an aborted request settles', () => {
    expect(shouldAutoPage({ ...idle, focused: false })).toBe(false);
  });

  it('stops at the budget, the end, enough posts, or outside Posts mode', () => {
    expect(shouldAutoPage({ ...idle, autoPages: MAX_AUTO_PAGES })).toBe(false);
    expect(shouldAutoPage({ ...idle, reachedEnd: true })).toBe(false);
    expect(shouldAutoPage({ ...idle, topLevelCount: 10 })).toBe(false);
    expect(shouldAutoPage({ ...idle, postsMode: 'all' })).toBe(false);
    expect(shouldAutoPage({ ...idle, tab: 'shop' })).toBe(false);
    expect(shouldAutoPage({ ...idle, loadingMore: true })).toBe(false);
  });
});
