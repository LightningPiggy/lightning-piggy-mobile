import { reconcileComments } from './commentEdits';
import type { Event as NostrEvent } from 'nostr-tools';
import {
  COMMENT_KIND,
  addressableCoord,
  belongsToRoot,
  buildCommentTags,
  commentFilterForRoot,
  commentRootRef,
  directReplies,
  isTopLevelComment,
  topLevelComments,
  threadedComments,
} from './productComments';

const MERCHANT = 'a'.repeat(64);
const D_TAG = 'robotechy-lightning-piggy';
const PRODUCT_COORD = `30402:${MERCHANT}:${D_TAG}`; // NOTE: no a: prefix

const product = (over: Partial<NostrEvent> = {}): NostrEvent =>
  ({
    id: 'prod-id',
    pubkey: MERCHANT,
    kind: 30402,
    tags: [['d', D_TAG]],
    content: '',
    created_at: 1,
    sig: '',
    ...over,
  }) as NostrEvent;

const comment = (tags: string[][], over: Partial<NostrEvent> = {}): NostrEvent =>
  ({
    id: 'c-id',
    pubkey: 'commenter',
    kind: COMMENT_KIND,
    tags,
    content: '',
    created_at: 1,
    sig: '',
    ...over,
  }) as NostrEvent;

describe('addressableCoord', () => {
  it('builds the bare <kind>:<pubkey>:<d> coordinate', () => {
    expect(addressableCoord(product())).toBe(PRODUCT_COORD);
  });

  it('leaves an empty d segment when absent', () => {
    expect(addressableCoord(product({ tags: [] }))).toBe(`30402:${MERCHANT}:`);
  });
});

describe('commentRootRef', () => {
  it('uses the coordinate for addressable roots and is stable across id changes', () => {
    expect(commentRootRef(product({ id: 'id-v1' }))).toBe(PRODUCT_COORD);
    expect(commentRootRef(product({ id: 'id-v2' }))).toBe(PRODUCT_COORD);
  });

  it('uses the id for a regular event and href for a URL', () => {
    expect(commentRootRef(product({ kind: 1, id: 'note1' }))).toBe('note1');
    expect(commentRootRef(new URL('https://shop.example/x'))).toBe('https://shop.example/x');
  });
});

describe('commentFilterForRoot', () => {
  it('filters kind 1111 by #A for an addressable product root', () => {
    const f = commentFilterForRoot(product());
    expect(f.kinds).toEqual([COMMENT_KIND]);
    expect(f['#A']).toEqual([PRODUCT_COORD]);
    expect(f.limit).toBeUndefined();
  });

  it('passes a numeric limit through', () => {
    expect(commentFilterForRoot(product(), 500).limit).toBe(500);
  });

  it('uses #I for a URL root and #E for a regular event root', () => {
    expect(commentFilterForRoot(new URL('https://shop.example/x'))['#I']).toEqual([
      'https://shop.example/x',
    ]);
    expect(commentFilterForRoot(product({ kind: 1, id: 'note1' }))['#E']).toEqual(['note1']);
  });
});

describe('buildCommentTags + isTopLevelComment', () => {
  it('roots a top-level comment on the product with matching upper/lower tags', () => {
    const tags = buildCommentTags(product());
    expect(tags).toContainEqual(['A', PRODUCT_COORD]);
    expect(tags).toContainEqual(['K', '30402']);
    expect(tags).toContainEqual(['P', MERCHANT]);
    expect(tags).toContainEqual(['a', PRODUCT_COORD]);
    expect(tags).toContainEqual(['k', '30402']);
    expect(tags).toContainEqual(['p', MERCHANT]);
    // A freshly-built top-level comment is recognised as top-level.
    expect(isTopLevelComment(comment(tags), product())).toBe(true);
  });

  it('points the lowercase tags at the parent comment when replying', () => {
    const parent = comment(buildCommentTags(product()), { id: 'parent-id', pubkey: 'alice' });
    const tags = buildCommentTags(product(), parent);
    // Uppercase root scope unchanged.
    expect(tags).toContainEqual(['A', PRODUCT_COORD]);
    // Lowercase parent points at the parent comment (regular event).
    expect(tags).toContainEqual(['e', 'parent-id']);
    expect(tags).toContainEqual(['k', String(COMMENT_KIND)]);
    expect(tags).toContainEqual(['p', 'alice']);
    // A reply is NOT top-level even though its uppercase A points at the product.
    expect(isTopLevelComment(comment(tags), product())).toBe(false);
  });

  it('uses the NIP-73 "web" external-id kind for K/k and href for I/i on a URL root', () => {
    const tags = buildCommentTags(new URL('https://shop.example/x'));
    // NIP-22 + NIP-73: a URL root scopes to the URL (I/i) with the external
    // identity kind "web" (K/k) — the literal string, not the hostname.
    expect(tags).toContainEqual(['I', 'https://shop.example/x']);
    expect(tags).toContainEqual(['K', 'web']);
    // The lowercase parent mirrors the root for a top-level comment.
    expect(tags).toContainEqual(['i', 'https://shop.example/x']);
    expect(tags).toContainEqual(['k', 'web']);
  });
});

describe('belongsToRoot', () => {
  it('accepts only comments whose UPPERCASE root tag is this product', () => {
    const root = product();
    const mine = comment([
      ['A', PRODUCT_COORD],
      ['a', PRODUCT_COORD],
    ]);
    const other = comment([['A', `30402:${MERCHANT}:another`], ['a', `30402:${MERCHANT}:another`]]); // prettier-ignore
    const missing = comment([['a', PRODUCT_COORD]]);
    const wrongKind = comment(
      [
        ['A', PRODUCT_COORD],
        ['a', PRODUCT_COORD],
      ],
      { kind: 1 },
    );
    expect(belongsToRoot(mine, root)).toBe(true);
    expect(belongsToRoot(other, root)).toBe(false);
    expect(belongsToRoot(missing, root)).toBe(false);
    expect(belongsToRoot(wrongKind, root)).toBe(false);
  });

  it('matches a URL root on the uppercase I tag', () => {
    const url = new URL('https://example.com/p/1');
    expect(belongsToRoot(comment([['I', url.toString()]]), url)).toBe(true);
    expect(belongsToRoot(comment([['I', 'https://example.com/p/2']]), url)).toBe(false);
  });
});

describe('topLevelComments + directReplies', () => {
  it('returns only top-level comments, newest-first', () => {
    const t1 = comment(buildCommentTags(product()), { id: 't1', created_at: 10 });
    const t2 = comment(buildCommentTags(product()), { id: 't2', created_at: 20 });
    const reply = comment(buildCommentTags(product(), t1), { id: 'r1', created_at: 30 });
    const tops = topLevelComments([t1, t2, reply], product());
    expect(tops.map((c) => c.id)).toEqual(['t2', 't1']);
  });

  it('returns direct replies of a parent, oldest-first', () => {
    const t1 = comment(buildCommentTags(product()), { id: 't1' });
    const r1 = comment(buildCommentTags(product(), t1), { id: 'r1', created_at: 30 });
    const r2 = comment(buildCommentTags(product(), t1), { id: 'r2', created_at: 20 });
    const replies = directReplies([t1, r1, r2], 't1');
    expect(replies.map((c) => c.id)).toEqual(['r2', 'r1']);
  });
});

describe('threadedComments after reconciliation', () => {
  const root = product();
  const original = comment(buildCommentTags(root), { id: 'original', pubkey: 'alice' });
  const edit = comment([...buildCommentTags(root), ['edit', original.id]], {
    id: 'edit',
    pubkey: 'alice',
    created_at: 2,
  });
  const reply = comment(buildCommentTags(root, original), { id: 'reply' });
  const nested = comment(buildCommentTags(root, reply), { id: 'nested' });
  const rows = (visible: NostrEvent[], ancestry = visible) =>
    threadedComments(visible, root, ancestry).map(({ comment: c, depth }) => [c.id, depth]);

  it('keeps replies under the latest edit across a chain, including hidden originals', () => {
    const latest = { ...edit, id: 'latest', tags: [...buildCommentTags(root), ['edit', edit.id]] };
    const ancestry = [original, edit, latest, reply, nested];
    const visible = reconcileComments(ancestry, []);
    expect(rows(visible, ancestry)).toEqual([
      ['latest', 0],
      ['reply', 1],
      ['nested', 2],
    ]);
    // Relays may have honoured the deletion of the original already.
    expect(rows([edit, reply, nested])).toEqual([
      ['edit', 0],
      ['reply', 1],
      ['nested', 2],
    ]);
  });

  it('renders orphan replies and descendants when the parent was deleted or not loaded', () => {
    expect(rows([reply, nested])).toEqual([
      ['reply', 0],
      ['nested', 1],
    ]);
    const deletion = { ...original, kind: 5, id: 'deletion', tags: [['e', original.id]] };
    const ancestry = [original, reply, nested];
    expect(rows(reconcileComments(ancestry, [deletion]), ancestry)).toEqual([
      ['reply', 0],
      ['nested', 1],
    ]);
  });

  it('does not attach replies to a forged edit by another author', () => {
    const forged = { ...edit, pubkey: 'mallory' };
    const result = rows([forged, original, reply]);
    expect(result).toContainEqual(['reply', 1]);
    expect(result.findIndex(([id]) => id === 'reply')).toBe(
      result.findIndex(([id]) => id === 'original') + 1,
    );
    expect(rows([forged, reply])).toContainEqual(['reply', 0]);
  });

  it('bounds malformed cycles and renders each comment once', () => {
    const cycle = { ...original, tags: buildCommentTags(root, reply) };
    expect(rows([cycle, reply])).toHaveLength(2);
  });
});
