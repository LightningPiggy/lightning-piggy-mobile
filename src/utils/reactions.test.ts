/**
 * Unit tests for the NIP-25 reaction state-merge logic. These cover the
 * pure helpers in `reactions.ts` — no Nostr / network involved.
 *
 * The aggregator (`reduceReactions`) is the load-bearing piece: incoming
 * relay batches are unsorted and may include duplicates from spammy
 * clients. The merge has to be deterministic across delivery order.
 */

import {
  buildReactionEvent,
  buildReactionDeletionEvent,
  parseReactionEvent,
  reduceReactions,
  applyReactionDeletion,
  isOptimisticReactionId,
  makeOptimisticReactionId,
  markPendingReactions,
  OPTIMISTIC_REACTION_PREFIX,
  type ReactionRecord,
} from './reactions';

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);
const PK_C = 'c'.repeat(64);
const PK_ME = '0'.repeat(64);
const TARGET_1 = '1'.repeat(64);
const TARGET_2 = '2'.repeat(64);

function rec(
  reactor: string,
  emoji: string,
  target: string,
  createdAt: number,
  id?: string,
): ReactionRecord {
  return {
    id: id ?? `${reactor.slice(0, 4)}-${emoji}-${target.slice(0, 4)}-${createdAt}`,
    reactorPubkey: reactor,
    emoji,
    createdAt,
    targetEventId: target,
  };
}

describe('buildReactionEvent', () => {
  it('produces a kind-7 with e + p tags', () => {
    const ev = buildReactionEvent('🔥', TARGET_1, PK_A);
    expect(ev.kind).toBe(7);
    expect(ev.content).toBe('🔥');
    expect(ev.tags).toEqual(
      expect.arrayContaining([
        ['e', TARGET_1],
        ['p', PK_A],
      ]),
    );
  });

  it('lowercases the author pubkey in the p tag', () => {
    const ev = buildReactionEvent('👍', TARGET_1, 'A'.repeat(64));
    const pTag = ev.tags.find((t) => t[0] === 'p');
    expect(pTag?.[1]).toBe('a'.repeat(64));
  });

  it('appends a k tag when the kind hint is provided', () => {
    const ev = buildReactionEvent('❤️', TARGET_1, PK_A, 14);
    const kTag = ev.tags.find((t) => t[0] === 'k');
    expect(kTag).toEqual(['k', '14']);
  });

  it('omits the k tag when no kind hint is provided', () => {
    const ev = buildReactionEvent('❤️', TARGET_1, PK_A);
    expect(ev.tags.find((t) => t[0] === 'k')).toBeUndefined();
  });

  it('targets an addressable listing with a/e/p/k tags and relay hints (#1541)', () => {
    const coordinate = `30402:${PK_A}:widget`;
    const ev = buildReactionEvent('+', TARGET_1, PK_A, 30402, {
      coordinate,
      relayHint: 'wss://relay.example',
    });
    expect(ev.kind).toBe(7);
    expect(ev.content).toBe('+');
    expect(ev.tags).toEqual([
      ['e', TARGET_1, 'wss://relay.example'],
      ['p', PK_A],
      ['a', coordinate, 'wss://relay.example'],
      ['k', '30402'],
    ]);
  });

  it('omits relay hints when none is given', () => {
    const coordinate = `30402:${PK_A}:widget`;
    const ev = buildReactionEvent('+', TARGET_1, PK_A, 30402, { coordinate });
    expect(ev.tags).toEqual([
      ['e', TARGET_1],
      ['p', PK_A],
      ['a', coordinate],
      ['k', '30402'],
    ]);
  });

  it('never adds an a tag for a plain (DM / note) target', () => {
    const ev = buildReactionEvent('👍', TARGET_1, PK_A, 14);
    expect(ev.tags.find((t) => t[0] === 'a')).toBeUndefined();
  });
});

describe('buildReactionDeletionEvent', () => {
  it('produces a kind-5 with e + k=7 tags', () => {
    const del = buildReactionDeletionEvent('reaction-id-123');
    expect(del.kind).toBe(5);
    expect(del.content).toBe('');
    expect(del.tags).toEqual(
      expect.arrayContaining([
        ['e', 'reaction-id-123'],
        ['k', '7'],
      ]),
    );
  });
});

describe('parseReactionEvent', () => {
  it('extracts the e tag, pubkey, content, and createdAt', () => {
    const parsed = parseReactionEvent({
      id: 'r1',
      pubkey: PK_A,
      kind: 7,
      content: '🔥',
      created_at: 1000,
      tags: [
        ['p', PK_B],
        ['e', TARGET_1],
      ],
    });
    expect(parsed).toEqual({
      id: 'r1',
      reactorPubkey: PK_A,
      emoji: '🔥',
      createdAt: 1000,
      targetEventId: TARGET_1,
    });
  });

  it('returns null on a non-kind-7 event', () => {
    expect(
      parseReactionEvent({
        id: 'r1',
        pubkey: PK_A,
        kind: 1,
        content: '🔥',
        created_at: 1000,
        tags: [['e', TARGET_1]],
      }),
    ).toBeNull();
  });

  it('returns null when no e tag is present', () => {
    expect(
      parseReactionEvent({
        id: 'r1',
        pubkey: PK_A,
        kind: 7,
        content: '🔥',
        created_at: 1000,
        tags: [['p', PK_B]],
      }),
    ).toBeNull();
  });

  it('uses the LAST e tag per NIP-25 spec when multiple are present', () => {
    const parsed = parseReactionEvent({
      id: 'r1',
      pubkey: PK_A,
      kind: 7,
      content: '🔥',
      created_at: 1000,
      tags: [
        ['e', TARGET_1],
        ['e', TARGET_2],
      ],
    });
    expect(parsed?.targetEventId).toBe(TARGET_2);
  });

  it('normalizes empty content to 👍 so "+"-style likes bucket with 👍', () => {
    const parsed = parseReactionEvent({
      id: 'r1',
      pubkey: PK_A,
      kind: 7,
      content: '',
      created_at: 1000,
      tags: [['e', TARGET_1]],
    });
    expect(parsed?.emoji).toBe('👍');
  });

  it('normalizes "+" to 👍 and "-" to 👎', () => {
    const plus = parseReactionEvent({
      id: 'r1',
      pubkey: PK_A,
      kind: 7,
      content: '+',
      created_at: 1000,
      tags: [['e', TARGET_1]],
    });
    const minus = parseReactionEvent({
      id: 'r2',
      pubkey: PK_A,
      kind: 7,
      content: '-',
      created_at: 1000,
      tags: [['e', TARGET_1]],
    });
    expect(plus?.emoji).toBe('👍');
    expect(minus?.emoji).toBe('👎');
  });
});

describe('reduceReactions', () => {
  it('returns an empty map when given no records', () => {
    expect(reduceReactions([], PK_ME).size).toBe(0);
  });

  it('groups reactors by emoji per target', () => {
    const out = reduceReactions(
      [
        rec(PK_A, '🔥', TARGET_1, 100),
        rec(PK_B, '🔥', TARGET_1, 101),
        rec(PK_C, '❤️', TARGET_1, 102),
        rec(PK_A, '👍', TARGET_2, 103),
      ],
      PK_ME,
    );
    expect(out.get(TARGET_1)?.byEmoji['🔥']).toEqual([PK_A, PK_B]);
    expect(out.get(TARGET_1)?.byEmoji['❤️']).toEqual([PK_C]);
    expect(out.get(TARGET_2)?.byEmoji['👍']).toEqual([PK_A]);
  });

  it('dedupes the same (reactor, emoji, target) — latest wins', () => {
    // Same person reacted twice with the same emoji to the same message.
    // Out-of-order delivery shouldn't matter.
    const out = reduceReactions(
      [rec(PK_A, '🔥', TARGET_1, 200, 'newer'), rec(PK_A, '🔥', TARGET_1, 100, 'older')],
      PK_ME,
    );
    expect(out.get(TARGET_1)?.byEmoji['🔥']).toEqual([PK_A]);
  });

  it('breaks equal-createdAt ties deterministically (higher id wins, any order)', () => {
    // Two records for the same (reactor, emoji, target) sharing a second — a
    // double-tap. The survivor must be the higher id regardless of delivery
    // order, so both orderings resolve to the same reaction id.
    const forward = reduceReactions(
      [rec(PK_ME, '🔥', TARGET_1, 100, 'id-aaa'), rec(PK_ME, '🔥', TARGET_1, 100, 'id-bbb')],
      PK_ME,
    );
    const reverse = reduceReactions(
      [rec(PK_ME, '🔥', TARGET_1, 100, 'id-bbb'), rec(PK_ME, '🔥', TARGET_1, 100, 'id-aaa')],
      PK_ME,
    );
    expect(forward.get(TARGET_1)?.myReactions['🔥']).toBe('id-bbb');
    expect(reverse.get(TARGET_1)?.myReactions['🔥']).toBe('id-bbb');
  });

  it('orders reactors within an emoji bucket by createdAt ascending', () => {
    const out = reduceReactions(
      [
        rec(PK_C, '🔥', TARGET_1, 300),
        rec(PK_A, '🔥', TARGET_1, 100),
        rec(PK_B, '🔥', TARGET_1, 200),
      ],
      PK_ME,
    );
    expect(out.get(TARGET_1)?.byEmoji['🔥']).toEqual([PK_A, PK_B, PK_C]);
  });

  it("records the viewer's reaction id in myReactions for toggle support", () => {
    const out = reduceReactions(
      [rec(PK_A, '🔥', TARGET_1, 100), rec(PK_ME, '🔥', TARGET_1, 101, 'my-reaction-id')],
      PK_ME,
    );
    expect(out.get(TARGET_1)?.myReactions['🔥']).toBe('my-reaction-id');
  });

  it('matches the viewer pubkey case-insensitively', () => {
    const upper = PK_ME.toUpperCase();
    const out = reduceReactions([rec(PK_ME, '🔥', TARGET_1, 100, 'my-reaction-id')], upper);
    expect(out.get(TARGET_1)?.myReactions['🔥']).toBe('my-reaction-id');
  });

  it('leaves myReactions empty when no viewer pubkey is supplied', () => {
    const out = reduceReactions([rec(PK_A, '🔥', TARGET_1, 100)], null);
    expect(out.get(TARGET_1)?.myReactions).toEqual({});
  });

  it('keeps multiple distinct emojis from the same reactor', () => {
    const out = reduceReactions(
      [rec(PK_A, '🔥', TARGET_1, 100), rec(PK_A, '❤️', TARGET_1, 101)],
      PK_ME,
    );
    expect(out.get(TARGET_1)?.byEmoji['🔥']).toEqual([PK_A]);
    expect(out.get(TARGET_1)?.byEmoji['❤️']).toEqual([PK_A]);
  });
});

describe('applyReactionDeletion', () => {
  it('removes a record matching id + author', () => {
    const records = [rec(PK_A, '🔥', TARGET_1, 100, 'r1'), rec(PK_B, '🔥', TARGET_1, 101, 'r2')];
    const out = applyReactionDeletion(records, 'r1', PK_A);
    expect(out).toHaveLength(1);
    expect(out[0].id).toBe('r2');
  });

  it('refuses to delete when the deletion was issued by a different pubkey (NIP-09)', () => {
    // NIP-09: only the original author can delete their own event.
    const records = [rec(PK_A, '🔥', TARGET_1, 100, 'r1')];
    const out = applyReactionDeletion(records, 'r1', PK_B);
    expect(out).toHaveLength(1);
  });

  it('is a no-op when the deletion targets an unknown id', () => {
    const records = [rec(PK_A, '🔥', TARGET_1, 100, 'r1')];
    expect(applyReactionDeletion(records, 'r-unknown', PK_A)).toEqual(records);
  });

  // End-to-end of the RECEIVE path the hook wires up (#205 blocking): a peer's
  // kind-7 is parsed + reduced into a pill, then their kind-5 retraction is
  // parsed for its `e` tag + reactor pubkey and applied — and the pill vanishes.
  it('drops a peer reaction from the reduced state once their kind-5 arrives', () => {
    // 1. Peer's reaction lands and reduces into a visible ❤️ pill.
    const reaction = parseReactionEvent({
      id: 'peer-react-1',
      pubkey: PK_B,
      kind: 7,
      content: '❤️',
      created_at: 100,
      tags: [
        ['e', TARGET_1],
        ['p', PK_ME],
      ],
    });
    expect(reaction).not.toBeNull();
    let records: ReactionRecord[] = [reaction!];
    expect(reduceReactions(records, PK_ME).get(TARGET_1)?.byEmoji['❤️']).toEqual([PK_B]);

    // 2. Peer retracts it: a kind-5 whose `e` tag names the reaction id and
    //    whose author is the reactor. Applying it removes the record.
    const deletion = { pubkey: PK_B, tags: [['e', 'peer-react-1']] };
    for (const t of deletion.tags) {
      records = applyReactionDeletion(records, t[1], deletion.pubkey);
    }

    // 3. The ❤️ pill is gone entirely.
    expect(reduceReactions(records, PK_ME).get(TARGET_1)).toBeUndefined();
  });

  it('ignores a kind-5 whose author is not the reaction author (NIP-09) in the receive path', () => {
    const records = [rec(PK_B, '❤️', TARGET_1, 100, 'peer-react-1')];
    // A third party (PK_C) tries to retract PK_B's reaction — must be ignored.
    const out = applyReactionDeletion(records, 'peer-react-1', PK_C);
    expect(reduceReactions(out, PK_ME).get(TARGET_1)?.byEmoji['❤️']).toEqual([PK_B]);
  });
});

describe('optimistic reaction ids', () => {
  it('stamps the shared prefix and reports it as optimistic', () => {
    const id = makeOptimisticReactionId(0);
    expect(id.startsWith(OPTIMISTIC_REACTION_PREFIX)).toBe(true);
    expect(isOptimisticReactionId(id)).toBe(true);
  });

  it('treats a real relay event id (64-hex) as NOT optimistic', () => {
    // A published kind-7 id is a 64-char hex — the removal path deletes THIS
    // for real, rather than deferring like it does for a `local-react-*` id.
    expect(isOptimisticReactionId('e'.repeat(64))).toBe(false);
  });

  it('mints unique ids for same-millisecond taps (seq disambiguates)', () => {
    const a = makeOptimisticReactionId(0);
    const b = makeOptimisticReactionId(1);
    expect(a).not.toBe(b);
  });
});

describe('markPendingReactions (#1656)', () => {
  const record = (id: string, emoji: string, reactor = PK_A): ReactionRecord => ({
    id,
    reactorPubkey: reactor,
    emoji,
    createdAt: 1,
    targetEventId: 't',
  });

  it("flags only the viewer's in-flight and unconfirmed reactions", () => {
    const reduced = reduceReactions(
      [
        record(makeOptimisticReactionId(0), '👍'),
        record('sent-unconfirmed', '❤️'),
        record('sent-confirmed', '🐷'),
        record('theirs', '😮', 'b'.repeat(64)),
      ],
      PK_A,
    );
    const marked = markPendingReactions(reduced, new Set(['sent-unconfirmed', 'theirs']));
    expect(marked.get('t')?.pending).toEqual({ '👍': true, '❤️': true });
  });

  it('leaves a fully confirmed state untouched', () => {
    const reduced = reduceReactions([record('sent-confirmed', '🐷')], PK_A);
    const before = reduced.get('t');
    expect(markPendingReactions(reduced, new Set()).get('t')).toBe(before);
  });
});
