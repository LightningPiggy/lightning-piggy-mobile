/**
 * Wire-format guards for `subjectFromRumor` (incoming NIP-17 kind-14
 * subject-tag parser). Used by `tryRouteGroupRumor` to materialise
 * synthetic groups from foreign-client messages (Amethyst, 0xchat).
 * Issue #271.
 */

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { wrapEvent } from 'nostr-tools/nip59';
import * as nip44 from 'nostr-tools/nip44';
import {
  subjectFromRumor,
  fileMetaFromRumor,
  textForRumor,
  partnerFromRumor,
  classifyRumor,
  unwrapWrapNsec,
  unwrapWrapViaNip44,
  type DecodedRumor,
} from './nip17Unwrap';

const PK_A = 'a'.repeat(64);
const PK_B = 'b'.repeat(64);

describe('subjectFromRumor (incoming kind-14)', () => {
  function rumorWithTags(tags: string[][]): DecodedRumor {
    return {
      pubkey: PK_A,
      created_at: 1,
      kind: 14,
      tags,
      content: '',
    };
  }

  it('returns the subject value when present', () => {
    expect(subjectFromRumor(rumorWithTags([['subject', 'Hello']]))).toBe('Hello');
  });

  it('returns null when there is no subject tag', () => {
    expect(subjectFromRumor(rumorWithTags([['p', PK_B]]))).toBeNull();
  });

  it('returns null when subject is whitespace-only', () => {
    expect(subjectFromRumor(rumorWithTags([['subject', '   ']]))).toBeNull();
  });

  it('trims surrounding whitespace', () => {
    expect(subjectFromRumor(rumorWithTags([['subject', '  Pizza Friday  ']]))).toBe('Pizza Friday');
  });
});

describe('classifyRumor — validated two-party subjects', () => {
  it.each([['subject', ''], ['subject', ' \t\n '], ['subject']])(
    'keeps an invalid subject %j on the DM path',
    (...subjectTag) => {
      const message: DecodedRumor = {
        pubkey: PK_A,
        created_at: 1,
        kind: 14,
        tags: [['p', PK_B], subjectTag],
        content: 'hello',
      };
      expect(classifyRumor(message, PK_B)).toEqual({
        type: 'dm',
        partnerPubkey: PK_A,
        fromMe: false,
      });
      message.tags.push(['p', 'c'.repeat(64)]);
      expect(classifyRumor(message, PK_B)).toEqual({
        type: 'group',
        otherParticipants: new Set([PK_A, 'c'.repeat(64)]),
        fromMe: false,
      });
    },
  );
});

describe('partnerFromRumor (partner-pubkey extraction + validation, #849)', () => {
  const ME = PK_A;
  const rumor = (over: Partial<DecodedRumor>): DecodedRumor => ({
    pubkey: PK_B,
    created_at: 1,
    kind: 14,
    tags: [],
    content: '',
    ...over,
  });

  it('incoming: sender is the partner, lowercased', () => {
    expect(partnerFromRumor(rumor({ pubkey: PK_B }), ME)).toEqual({
      partnerPubkey: PK_B,
      fromMe: false,
    });
  });

  it('incoming: lowercases a mixed-case sender pubkey (was leaking as raw-hex)', () => {
    const mixed = 'D'.repeat(64);
    expect(partnerFromRumor(rumor({ pubkey: mixed }), ME)).toEqual({
      partnerPubkey: 'd'.repeat(64),
      fromMe: false,
    });
  });

  it('incoming: returns null for a malformed sender pubkey (the dcc… junk fix)', () => {
    expect(partnerFromRumor(rumor({ pubkey: 'dcc123' }), ME)).toBeNull();
    expect(partnerFromRumor(rumor({ pubkey: 'z'.repeat(64) }), ME)).toBeNull();
  });

  it('fromMe: reads the p-tag partner, validated + lowercased', () => {
    expect(partnerFromRumor(rumor({ pubkey: ME, tags: [['p', PK_B.toUpperCase()]] }), ME)).toEqual({
      partnerPubkey: PK_B,
      fromMe: true,
    });
  });

  it('fromMe: skips our own p tag, so a reaction to our own message finds the peer (#1319)', () => {
    const tags = [
      ['e', 'f'.repeat(64)],
      ['p', ME],
      ['p', PK_B],
    ];
    expect(partnerFromRumor(rumor({ pubkey: ME, kind: 7, tags }), ME)).toEqual({
      partnerPubkey: PK_B,
      fromMe: true,
    });
    // A lone self p tag is still a note to self.
    expect(partnerFromRumor(rumor({ pubkey: ME, tags: [['p', ME]] }), ME)).toEqual({
      partnerPubkey: ME,
      fromMe: true,
    });
  });

  it('fromMe: returns null when the p-tag partner is missing or malformed', () => {
    expect(partnerFromRumor(rumor({ pubkey: ME, tags: [] }), ME)).toBeNull();
    expect(partnerFromRumor(rumor({ pubkey: ME, tags: [['p', 'nope']] }), ME)).toBeNull();
  });
});

describe('textForRumor (wrapped reactions, #1321)', () => {
  it('stores the content and the tags that name the target, nothing else', () => {
    const out = textForRumor({
      pubkey: PK_B,
      created_at: 0,
      kind: 7,
      content: '🎉',
      tags: [
        ['e', 'f'.repeat(64)],
        ['p', PK_A],
        ['k', '14'],
        ['client', 'Amethyst'],
      ],
    });
    expect(JSON.parse(out)).toEqual({
      content: '🎉',
      tags: [
        ['e', 'f'.repeat(64)],
        ['p', PK_A],
        ['k', '14'],
      ],
    });
  });
});

describe('textForRumor (kind-15 → bubble text)', () => {
  const fileRumor = (mime: string, alg: string): DecodedRumor => ({
    pubkey: PK_A,
    created_at: 0,
    kind: 15,
    content: 'https://blossom.example/abc.bin',
    tags: [
      ['file-type', mime],
      ['encryption-algorithm', alg],
      ['decryption-key', 'a'.repeat(64)],
      ['decryption-nonce', 'b'.repeat(24)],
    ],
  });

  it('encodes an AES-GCM audio voice note into the #lpe URL', () => {
    const out = textForRumor(fileRumor('audio/mp4', 'aes-gcm'));
    expect(out).toContain('#lpe=1');
    expect(out).toContain('k=' + 'a'.repeat(64));
  });

  it('encodes an AES-GCM image into the #lpe URL (#688)', () => {
    const out = textForRumor(fileRumor('image/jpeg', 'aes-gcm'));
    expect(out).toContain('#lpe=1');
    expect(out).toContain('k=' + 'a'.repeat(64));
    expect(out).toContain('m=image%2Fjpeg');
  });

  it('encodes AES-GCM documents into the shared file URL', () => {
    const out = textForRumor(fileRumor('application/pdf', 'aes-gcm'));
    expect(out).toContain('#lpe=1');
    expect(out).toContain('m=application%2Fpdf');
  });

  it('does NOT leak the key for a non-aes-gcm audio kind-15', () => {
    const out = textForRumor(fileRumor('audio/mp4', 'chacha20'));
    expect(out).toBe('https://blossom.example/abc.bin');
    expect(out).not.toContain('a'.repeat(64));
  });

  it('does NOT leak the key for a non-aes-gcm image kind-15', () => {
    const out = textForRumor(fileRumor('image/png', 'chacha20'));
    expect(out).toBe('https://blossom.example/abc.bin');
    expect(out).not.toContain('a'.repeat(64));
  });

  it('returns plain content for a kind-14 text rumor', () => {
    expect(
      textForRumor({ pubkey: PK_A, created_at: 0, kind: 14, content: 'hi there', tags: [] }),
    ).toBe('hi there');
  });

  it('serializes a kind-1068 poll rumor to stored poll JSON with the rumor id', () => {
    const rumor: DecodedRumor = {
      pubkey: PK_A,
      created_at: 100,
      kind: 1068,
      content: 'Dinner?',
      tags: [
        ['p', 'c'.repeat(64)],
        ['option', '1', 'Pasta'],
        ['option', '2', 'Curry'],
        ['polltype', 'singlechoice'],
      ],
    };
    const out = JSON.parse(textForRumor(rumor));
    expect(out.question).toBe('Dinner?');
    expect(out.pollId).toMatch(/^[0-9a-f]{64}$/);
    expect(out.author).toBe(PK_A);
    expect(out.options).toEqual([
      { id: '1', label: 'Pasta' },
      { id: '2', label: 'Curry' },
    ]);
  });

  it('serializes a kind-1018 vote rumor capturing the voter + poll ref', () => {
    const rumor: DecodedRumor = {
      pubkey: PK_A,
      created_at: 200,
      kind: 1018,
      content: '',
      tags: [
        ['e', 'poll-abc'],
        ['p', 'c'.repeat(64)],
        ['response', '2'],
      ],
    };
    const out = JSON.parse(textForRumor(rumor));
    expect(out).toEqual({ pollId: 'poll-abc', voter: PK_A, optionIds: ['2'], createdAt: 200 });
  });

  it('falls back to plain content for a malformed poll rumor', () => {
    const rumor: DecodedRumor = {
      pubkey: PK_A,
      created_at: 0,
      kind: 1068,
      content: 'no options here',
      tags: [['option', '1', 'only-one']],
    };
    expect(textForRumor(rumor)).toBe('no options here');
  });
});

/**
 * Security characterisation for the nsec decrypt path. Proves the guarantees
 * after #802 (the redundant gift-wrap schnorr verify no longer gates
 * decryption) and #830 (the path now binds `rumor.pubkey === seal.pubkey`):
 *   - a wrap with an invalid signature still decrypts (verify is gone),
 *   - a tampered ciphertext is still rejected by the NIP-44 MAC,
 *   - a rumor claiming a different pubkey than its seal is rejected
 *     (sender-spoofing blocked).
 */
describe('classifyRumor — kind-16/17 order classification', () => {
  // Viewer is PK_B; the market (PK_A) addresses the order to them via `#p`.
  const orderRumor = (over: Partial<DecodedRumor> = {}): DecodedRumor => ({
    pubkey: PK_A,
    created_at: 1,
    kind: 16,
    tags: [
      ['p', PK_B],
      ['order', 'c6c790ca-1234'],
      ['type', '1'],
    ],
    content: '',
    ...over,
  });

  it('classifies a genuine kind-16 marketplace order as an order', () => {
    const cls = classifyRumor(orderRumor(), PK_B);
    expect(cls).toEqual({ type: 'order', partnerPubkey: PK_A, fromMe: false });
  });

  it('classifies a genuine kind-17 receipt as an order', () => {
    const cls = classifyRumor(
      orderRumor({
        kind: 17,
        tags: [
          ['p', PK_B],
          ['order', 'c6c790ca-1234'],
          ['subject', 'order-receipt'],
        ],
      }),
      PK_B,
    );
    expect(cls).toEqual({ type: 'order', partnerPubkey: PK_A, fromMe: false });
  });

  it('does NOT classify a kind-16 NIP-18 repost as an order — falls through to dm', () => {
    // A repost carries a `k` repost-target tag, so parseOrderEvent rejects it;
    // classifyRumor must then fall through to the normal dm/group path.
    const cls = classifyRumor(
      orderRumor({
        tags: [
          ['p', PK_B],
          ['k', '1'],
        ],
      }),
      PK_B,
    );
    expect(cls).toEqual({ type: 'dm', partnerPubkey: PK_A, fromMe: false });
  });

  it('does NOT classify a kind-17 without the order-receipt subject as an order', () => {
    const cls = classifyRumor(
      orderRumor({
        kind: 17,
        tags: [
          ['p', PK_B],
          ['order', 'c6c790ca-1234'],
        ],
      }),
      PK_B,
    );
    // No subject=order-receipt → not an order; falls through to dm.
    expect(cls).toEqual({ type: 'dm', partnerPubkey: PK_A, fromMe: false });
  });
});

describe('unwrapWrapNsec (NIP-17 nsec decrypt, post-#802)', () => {
  // Build a real NIP-17 gift wrap from `sender` to `recipient`.
  function makeWrap(content: string) {
    const senderSk = generateSecretKey();
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);
    const senderPk = getPublicKey(senderSk);
    const wrap = wrapEvent(
      { kind: 14, content, tags: [['p', recipientPk]] },
      senderSk,
      recipientPk,
    );
    return { wrap, recipientSk, senderPk };
  }

  // Cast helper — `wrapEvent` returns a fully-typed VerifiedEvent; the
  // unwrap function takes the looser RawGiftWrapEvent shape.
  type WrapArg = Parameters<typeof unwrapWrapNsec>[0];

  it('round-trips a kind-14 rumor (decrypt works without a sig verify)', () => {
    const { wrap, recipientSk, senderPk } = makeWrap('hello piggy');
    const rumor = unwrapWrapNsec(wrap as unknown as WrapArg, recipientSk);
    expect(rumor).not.toBeNull();
    expect(rumor?.content).toBe('hello piggy');
    expect(rumor?.kind).toBe(14);
    // For a well-formed wrap, rumor.pubkey == seal.pubkey == sender, so the
    // #830 binding passes and the sender is surfaced as rumor.pubkey.
    expect(rumor?.pubkey).toBe(senderPk);
  });

  it('STILL decrypts when the wrap signature is invalid (verify is gone, #802)', () => {
    const { wrap, recipientSk } = makeWrap('sig should not matter');
    // Corrupt the ephemeral-key signature. Pre-#802 this returned null
    // ('wrap signature invalid'); now the sig is never consulted, so the
    // NIP-44 layers decrypt regardless — that's the whole point.
    (wrap as unknown as { sig: string }).sig = 'f'.repeat(128);
    const rumor = unwrapWrapNsec(wrap as unknown as WrapArg, recipientSk);
    expect(rumor?.content).toBe('sig should not matter');
  });

  it('still REJECTS a wrap whose ciphertext was tampered (MAC enforces integrity)', () => {
    const { wrap, recipientSk } = makeWrap('tamper me');
    // Flip one base64 char mid-payload → NIP-44 MAC mismatch → decrypt throws
    // → unwrapWrapNsec skips (returns null). This is the guarantee that
    // replaced the schnorr verify: integrity is preserved. The midpoint is
    // always in-bounds (a valid NIP-44 payload is ≥132 chars).
    const i = Math.floor(wrap.content.length / 2);
    const swapped = wrap.content[i] === 'A' ? 'B' : 'A';
    const tampered = wrap.content.slice(0, i) + swapped + wrap.content.slice(i + 1);
    const onSkip = jest.fn();
    const rumor = unwrapWrapNsec(
      { ...wrap, content: tampered } as unknown as WrapArg,
      recipientSk,
      onSkip,
    );
    expect(rumor).toBeNull();
    expect(onSkip).toHaveBeenCalledTimes(1);
  });

  it('REJECTS a wrap whose rumor.pubkey != seal.pubkey (sender spoofing, #830)', () => {
    // Hand-craft a malicious wrap: the seal is sealed (and ECDH-authenticated)
    // by the *attacker*, but the inner rumor claims it was sent by a different
    // pubkey (the victim being impersonated). `wrapEvent` can't produce this —
    // it always sets rumor.pubkey == seal sender — so we build the two NIP-44
    // layers by hand.
    const recipientSk = generateSecretKey();
    const recipientPk = getPublicKey(recipientSk);
    const attackerSk = generateSecretKey(); // the key that actually seals
    const victimPk = 'd'.repeat(64); // the pubkey the rumor falsely claims

    const rumor = {
      pubkey: victimPk,
      created_at: 1,
      kind: 14,
      content: 'transfer 1000 sats, trust me',
      tags: [['p', recipientPk]],
    };
    const sealKey = nip44.v2.utils.getConversationKey(attackerSk, recipientPk);
    const seal = finalizeEvent(
      {
        kind: 13,
        content: nip44.v2.encrypt(JSON.stringify(rumor), sealKey),
        created_at: 1,
        tags: [],
      },
      attackerSk,
    );
    const ephemeralSk = generateSecretKey();
    const wrapKey = nip44.v2.utils.getConversationKey(ephemeralSk, recipientPk);
    const wrap = finalizeEvent(
      {
        kind: 1059,
        content: nip44.v2.encrypt(JSON.stringify(seal), wrapKey),
        created_at: 1,
        tags: [['p', recipientPk]],
      },
      ephemeralSk,
    );

    const onSkip = jest.fn();
    const out = unwrapWrapNsec(wrap as unknown as WrapArg, recipientSk, onSkip);
    expect(out).toBeNull();
    // Skipped specifically for the pubkey-binding mismatch, not a decrypt error.
    expect(onSkip).toHaveBeenCalledWith(expect.stringContaining('!='), expect.any(String));
  });
});

describe('unwrapWrapViaNip44 (NIP-46 signer denials reach the ingest loop)', () => {
  // Minimal wrap and seal shapes: the decrypt is a stub, so only the wrap's
  // id/pubkey/content and the seal's pubkey/content/kind have to be valid.
  const wrap = { id: 'w'.repeat(64), pubkey: PK_A, content: 'ciphertext' } as unknown as Parameters<
    typeof unwrapWrapNsec
  >[0];
  const sealJson = JSON.stringify({
    kind: 13,
    pubkey: PK_B,
    content: 'inner',
    created_at: 1,
    tags: [],
  });
  const denied = () => Promise.reject(new Error('NIP-46 signer denied nip44_decrypt'));

  it('rethrows a NIP-46 signer denial from the wrap decrypt, so the loop can stop', async () => {
    const onSkip = jest.fn();
    await expect(unwrapWrapViaNip44(wrap, denied, onSkip)).rejects.toThrow(
      'NIP-46 signer denied nip44_decrypt',
    );
    expect(onSkip).not.toHaveBeenCalled();
  });

  it('rethrows a NIP-46 signer denial from the seal decrypt', async () => {
    const onSkip = jest.fn();
    const decrypt = jest.fn().mockResolvedValueOnce(sealJson).mockImplementationOnce(denied);
    await expect(unwrapWrapViaNip44(wrap, decrypt, onSkip)).rejects.toThrow(
      'NIP-46 signer denied nip44_decrypt',
    );
    expect(onSkip).not.toHaveBeenCalled();
  });

  it('still skips any other decrypt failure rather than throwing', async () => {
    const onSkip = jest.fn();
    const failure = () => Promise.reject(new Error('invalid MAC'));
    await expect(unwrapWrapViaNip44(wrap, failure, onSkip)).resolves.toBeNull();
    expect(onSkip).toHaveBeenCalledWith(
      expect.stringContaining('wrap decrypt failed'),
      'w'.repeat(64),
    );
  });
});

it('validates kind-15 URLs and carries the advertised size into render text', () => {
  const rumor: DecodedRumor = {
    pubkey: PK_A,
    created_at: 0,
    kind: 15,
    content: 'https://example.com/blob',
    tags: [
      ['file-type', 'image/jpeg'],
      ['decryption-key', 'a'.repeat(64)],
      ['decryption-nonce', 'b'.repeat(24)],
      ['size', '123'],
    ],
  };
  expect(textForRumor(rumor)).toContain('&s=123');
  expect(textForRumor({ ...rumor, content: 'https://127.0.0.1/blob' })).not.toContain('#lpe=1');
  expect(
    textForRumor({
      ...rumor,
      tags: [...rumor.tags.filter((t) => t[0] !== 'size'), ['size', String(50 * 1024 * 1024 + 1)]],
    }),
  ).not.toContain('#lpe=1');
});

it('bounds incoming kind-15 filenames before metadata storage', () => {
  expect(
    fileMetaFromRumor({
      pubkey: PK_A,
      created_at: 1,
      kind: 15,
      content: 'https://example.com/file',
      tags: [
        ['decryption-key', '11'.repeat(32)],
        ['decryption-nonce', '22'.repeat(12)],
        ['filename', 'a'.repeat(1000)],
      ],
    })?.filename,
  ).toHaveLength(255);
});
