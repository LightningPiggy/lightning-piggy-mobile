import * as nip19 from 'nostr-tools/nip19';
import {
  applyMentionPick,
  decodeProfileUri,
  encodeMentions,
  filterMentionCandidates,
  findMentionQuery,
  groupPreviewPubkeys,
  mentionedPubkeys,
  messageMentions,
  previewMentions,
  splitMentions,
} from './chatMentions';

const ALICE = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const ME = 'c'.repeat(64);
const npub = (hex: string) => nip19.npubEncode(hex);
const nprofile = (hex: string) =>
  nip19.nprofileEncode({ pubkey: hex, relays: ['wss://relay.example.com'] });

describe('decodeProfileUri', () => {
  it('decodes nostr:npub and nostr:nprofile to the hex pubkey', () => {
    expect(decodeProfileUri(`nostr:${npub(ALICE)}`)).toBe(ALICE);
    expect(decodeProfileUri(`nostr:${nprofile(BOB)}`)).toBe(BOB);
  });

  it('rejects bad checksums, mixed case and non-profile entities', () => {
    const good = npub(ALICE);
    const broken = `${good.slice(0, -1)}${good.endsWith('q') ? 'p' : 'q'}`;
    expect(decodeProfileUri(`nostr:${broken}`)).toBeNull();
    expect(
      decodeProfileUri(`nostr:${good.toUpperCase().slice(0, 10)}${good.slice(10)}`),
    ).toBeNull();
    expect(decodeProfileUri(`nostr:${nip19.noteEncode(ALICE)}`)).toBeNull();
  });
});

describe('splitMentions', () => {
  it('returns one text segment when there is no reference', () => {
    expect(splitMentions('hello there')).toEqual([{ kind: 'text', text: 'hello there' }]);
  });

  it('splits text around mentions, in order', () => {
    const text = `hi nostr:${npub(ALICE)} and nostr:${nprofile(BOB)}!`;
    const segs = splitMentions(text);
    expect(segs.map((s) => s.kind)).toEqual(['text', 'mention', 'text', 'mention', 'text']);
    expect(segs[1]).toMatchObject({ kind: 'mention', pubkey: ALICE });
    expect(segs[3]).toMatchObject({ kind: 'mention', pubkey: BOB });
    expect(segs[4]).toEqual({ kind: 'text', text: '!' });
  });

  it('splits two references written back to back', () => {
    const segs = splitMentions(`nostr:${npub(ALICE)}nostr:${npub(BOB)}`);
    expect(segs.filter((s) => s.kind === 'mention')).toHaveLength(2);
  });

  it('leaves an undecodable reference as text', () => {
    const text = 'see nostr:npub1qqqqqqqqqqqqqqqq';
    expect(splitMentions(text)).toEqual([{ kind: 'text', text }]);
  });

  it("reads White Noise's @npub mention form", () => {
    const segs = splitMentions(`Hey @${npub(ALICE)} please look`);
    expect(segs).toEqual([
      { kind: 'text', text: 'Hey ' },
      { kind: 'mention', pubkey: ALICE, raw: `@${npub(ALICE)}` },
      { kind: 'text', text: ' please look' },
    ]);
    expect(messageMentions({ text: `@${npub(ME)} hi` }, ME)).toBe(true);
  });

  it('does not treat an email-like x@npub… as a mention', () => {
    expect(splitMentions(`me@${npub(ALICE)}`)).toHaveLength(1);
  });

  it('ignores a bare npub without the nostr: scheme', () => {
    expect(splitMentions(`hi ${npub(ALICE)}`)).toHaveLength(1);
  });
});

describe('mentionedPubkeys / messageMentions', () => {
  it('lists each mentioned pubkey once', () => {
    const text = `nostr:${npub(ALICE)} nostr:${nprofile(ALICE)} nostr:${npub(BOB)}`;
    expect(mentionedPubkeys(text)).toEqual([ALICE, BOB]);
  });

  it('detects a text mention of the viewer', () => {
    expect(messageMentions({ text: `yo nostr:${npub(ME)}` }, ME)).toBe(true);
    expect(messageMentions({ text: `yo nostr:${npub(ALICE)}` }, ME)).toBe(false);
    expect(messageMentions({ text: 'plain' }, ME)).toBe(false);
  });

  it('detects a Marmot p-tag mention (case-insensitive)', () => {
    expect(messageMentions({ text: 'hi', mentions: [ME.toUpperCase()] }, ME)).toBe(true);
  });

  it('is false with no viewer', () => {
    expect(messageMentions({ text: `nostr:${npub(ME)}` }, null)).toBe(false);
  });
});

describe('findMentionQuery', () => {
  it('opens on a bare @ at the start or after whitespace', () => {
    expect(findMentionQuery('@', 1)).toEqual({ start: 0, end: 1, query: '' });
    expect(findMentionQuery('hey @al', 7)).toEqual({ start: 4, end: 7, query: 'al' });
  });

  it('allows inner spaces so a full display name can be typed', () => {
    expect(findMentionQuery('@Big Pig', 8)?.query).toBe('Big Pig');
  });

  it('closes on a trailing space, a line break, or an @ inside a word', () => {
    expect(findMentionQuery('@Alice ', 7)).toBeNull();
    expect(findMentionQuery('@al\nx', 5)).toBeNull();
    expect(findMentionQuery('me@example', 10)).toBeNull();
    expect(findMentionQuery('@ x', 3)).toBeNull();
  });

  it('uses the cursor, not the end of the text', () => {
    expect(findMentionQuery('@al rest', 3)).toEqual({ start: 0, end: 3, query: 'al' });
  });

  it('stops looking after a bounded distance', () => {
    expect(findMentionQuery(`@${'a'.repeat(40)}`, 41)).toBeNull();
  });
});

describe('filterMentionCandidates', () => {
  const members = [
    { pubkey: ME, name: 'Me' },
    { pubkey: ALICE, name: 'Alice' },
    { pubkey: BOB, name: 'Big Piggy' },
    { pubkey: 'd'.repeat(64), name: 'Malicious' },
  ];

  it('lists everyone but the viewer for an empty query', () => {
    expect(filterMentionCandidates(members, '', ME).map((m) => m.name)).toEqual([
      'Alice',
      'Big Piggy',
      'Malicious',
    ]);
  });

  it('ranks prefix, then word-start, then substring', () => {
    expect(filterMentionCandidates(members, 'ali', ME).map((m) => m.name)).toEqual([
      'Alice',
      'Malicious',
    ]);
    expect(filterMentionCandidates(members, 'pig', ME).map((m) => m.name)).toEqual(['Big Piggy']);
  });

  it('caps the list', () => {
    expect(filterMentionCandidates(members, '', null, 2)).toHaveLength(2);
  });
});

describe('applyMentionPick + encodeMentions', () => {
  it('replaces the query with @Label and a space, cursor after it', () => {
    const text = 'hi @al';
    const q = findMentionQuery(text, text.length)!;
    expect(applyMentionPick(text, q, 'Alice')).toEqual({ text: 'hi @Alice ', cursor: 10 });
  });

  it('keeps the text after the cursor, without doubling a space', () => {
    const text = 'hi @al there';
    const q = findMentionQuery(text, 6)!;
    expect(applyMentionPick(text, q, 'Alice').text).toBe('hi @Alice there');
  });

  it('encodes picked labels to nostr:npub, longest label first', () => {
    const out = encodeMentions('@Alice and @Al, see?', [
      { label: 'Al', pubkey: BOB },
      { label: 'Alice', pubkey: ALICE },
    ]);
    expect(out).toBe(`nostr:${npub(ALICE)} and nostr:${npub(BOB)}, see?`);
    expect(mentionedPubkeys(out)).toEqual([ALICE, BOB]);
  });

  it('leaves edited labels and email-like text alone', () => {
    expect(encodeMentions('@Alic hi', [{ label: 'Alice', pubkey: ALICE }])).toBe('@Alic hi');
    expect(encodeMentions('me@Alice', [{ label: 'Alice', pubkey: ALICE }])).toBe('me@Alice');
  });

  it('handles labels with regex characters', () => {
    expect(encodeMentions('@a.b (x)', [{ label: 'a.b (x)', pubkey: ALICE }])).toBe(
      `nostr:${npub(ALICE)}`,
    );
  });
});

describe('previewMentions', () => {
  it('shows mentions as @Name, falling back for unknown pubkeys', () => {
    const text = `hi nostr:${npub(ALICE)} and nostr:${npub(BOB)}`;
    expect(
      previewMentions(
        text,
        (pk) => (pk === ALICE ? 'Alice' : null),
        (pk) => pk.slice(0, 4),
      ),
    ).toBe('hi @Alice and @bbbb');
  });
  it('returns plain text unchanged', () => {
    expect(
      previewMentions(
        'plain',
        () => 'x',
        () => 'y',
      ),
    ).toBe('plain');
  });
});

describe('groupPreviewPubkeys', () => {
  it("collects each row's last sender and everyone its preview mentions, once each", () => {
    const rows = [
      {
        activity: {
          lastSenderPubkey: BOB,
          lastText: `ping nostr:${npub(ALICE)} and nostr:${npub(ALICE)}`,
        },
      },
      { activity: { lastSenderPubkey: ALICE.toUpperCase(), lastText: 'no mentions' } },
      { activity: { lastSenderPubkey: null, lastText: null } },
    ];
    expect(groupPreviewPubkeys(rows).sort()).toEqual([ALICE, BOB].sort());
  });
});
