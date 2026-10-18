import {
  finalizeEvent,
  generateSecretKey,
  getEventHash,
  getPublicKey,
  verifyEvent,
} from 'nostr-tools/pure';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import {
  classifyGroupRumor,
  groupKeysFromTickets,
  groupRumorTags,
  isNip171GroupId,
  nip171GroupId,
  nip171GroupPubkey,
  parseTicket,
  type Nip171Event,
  type Nip171Ticket,
} from './nip171';

const groupSk = generateSecretKey();
const GROUP = getPublicKey(groupSk);
const meSk = generateSecretKey();
const ME = getPublicKey(meSk);
const epochSk = generateSecretKey();
const EPOCH_PUB = getPublicKey(epochSk);
const EPOCH_HEX = bytesToHex(epochSk);
const verify = (e: Required<Omit<Nip171Event, 'sealInvitationProof'>>) =>
  verifyEvent(e as Parameters<typeof verifyEvent>[0]);

const parse = (e: Nip171Event, member: string) =>
  parseTicket(e, member, verify, getEventHash, (hex) => getPublicKey(hexToBytes(hex)));

function ticket(member: string, epoch: number, key = EPOCH_HEX, created_at = 1000, sk = groupSk) {
  return finalizeEvent(
    {
      kind: 1014,
      created_at,
      tags: [
        ['p', member],
        ['epoch', String(epoch)],
      ],
      content: key,
    },
    sk,
  ) as Nip171Event;
}

describe('group ids', () => {
  it('round-trips the group pubkey', () => {
    const id = nip171GroupId(GROUP.toUpperCase());
    expect(isNip171GroupId(id)).toBe(true);
    expect(nip171GroupPubkey(id)).toBe(GROUP);
    expect(nip171GroupPubkey('marmot:abc')).toBeNull();
  });
});

describe('parseTicket', () => {
  it('accepts a valid ticket addressed to us', () => {
    expect(parse(ticket(ME, 0), ME)).toMatchObject({
      groupPubkey: GROUP,
      memberPubkey: ME,
      epoch: 0,
      epochSecretHex: EPOCH_HEX,
      createdAt: 1000,
    });
  });

  it('rejects tickets that break a MUST', () => {
    const other = getPublicKey(generateSecretKey());
    expect(parse(ticket(other, 0), ME)).toBeNull(); // not for us
    expect(parse(ticket(ME, 0, 'nothex'), ME)).toBeNull();
    const tampered = { ...ticket(ME, 0), content: '1'.repeat(64) };
    expect(parse(tampered, ME)).toBeNull(); // bad signature
    const unsigned = { ...ticket(ME, 0) };
    delete unsigned.sig;
    expect(parse(unsigned, ME)).toBeNull();
    const twoP = finalizeEvent(
      {
        kind: 1014,
        created_at: 1,
        tags: [
          ['p', ME],
          ['p', ME],
          ['epoch', '0'],
        ],
        content: EPOCH_HEX,
      },
      groupSk,
    ) as Nip171Event;
    expect(parse(twoP, ME)).toBeNull();
    const leadingZero = finalizeEvent(
      {
        kind: 1014,
        created_at: 1,
        tags: [
          ['p', ME],
          ['epoch', '01'],
        ],
        content: EPOCH_HEX,
      },
      groupSk,
    ) as Nip171Event;
    expect(parse(leadingZero, ME)).toBeNull();
    // The epoch key may not be the group's own key.
    expect(parse(ticket(ME, 0, bytesToHex(groupSk)), ME)).toBeNull();
  });

  it("takes Anagram's signature from the seal's invitation_proof", () => {
    const signed = ticket(ME, 0);
    const { sig, ...rumor } = signed;
    expect(parse({ ...rumor, sealInvitationProof: sig }, ME)).toMatchObject({ id: signed.id, sig });
    expect(parse({ ...rumor, sealInvitationProof: '0'.repeat(128) }, ME)).toBeNull();
  });
});

describe('groupKeysFromTickets', () => {
  const t = (epoch: number, key: string, created: number) =>
    parse(ticket(ME, epoch, key, created), ME)!;
  const keyB = bytesToHex(generateSecretKey());

  it('uses the highest epoch, then the newest ticket', () => {
    const keys = groupKeysFromTickets([t(0, EPOCH_HEX, 1), t(1, keyB, 2), t(1, keyB, 5)])!;
    expect(keys.epoch).toBe(1);
    expect(keys.current.createdAt).toBe(5);
    expect(keys.conflicted).toBe(false);
    expect(keys.epochSecrets.get(0)).toBe(EPOCH_HEX);
    expect(keys.epochSecrets.get(1)).toBe(keyB);
  });

  it('marks two keys for the same epoch as conflicted', () => {
    expect(groupKeysFromTickets([t(2, EPOCH_HEX, 1), t(2, keyB, 2)])!.conflicted).toBe(true);
  });

  it('is null without tickets', () => {
    expect(groupKeysFromTickets([] as Nip171Ticket[])).toBeNull();
  });
});

describe('classifyGroupRumor', () => {
  const keys = groupKeysFromTickets([parse(ticket(ME, 0), ME)!])!;
  const context = {
    groupPubkey: GROUP,
    epoch: 0,
    epochPubkey: EPOCH_PUB,
    epochSecretHex: EPOCH_HEX,
    knownEpochPubkeys: new Set([EPOCH_PUB]),
  };
  const classify = (rumor: Parameters<typeof classifyGroupRumor>[0]) =>
    classifyGroupRumor(rumor, context, verify, getEventHash as never);

  it('accepts a member message whose proof rebuilds into a group-signed ticket', () => {
    const rumor = {
      kind: 14,
      pubkey: ME,
      created_at: 5,
      tags: groupRumorTags(keys, EPOCH_PUB),
      content: 'hi',
    };
    expect(classify(rumor)).toEqual({ type: 'message', sender: ME });
  });

  it('accepts another member proving their own ticket', () => {
    const aliceSk = generateSecretKey();
    const ALICE = getPublicKey(aliceSk);
    const aliceTicket = ticket(ALICE, 0, EPOCH_HEX, 777);
    const tags = [
      ['p', EPOCH_PUB],
      ['h', GROUP],
      ['epoch', '0'],
      ['invited_at', '777'],
      ['invitation_proof', aliceTicket.sig!],
    ];
    expect(classify({ kind: 14, pubkey: ALICE, created_at: 5, tags, content: 'hey' })).toEqual({
      type: 'message',
      sender: ALICE,
    });
    // Someone reusing Alice's proof under their own key fails.
    const mallory = getPublicKey(generateSecretKey());
    expect(classify({ kind: 14, pubkey: mallory, created_at: 5, tags, content: 'x' })).toEqual({
      type: 'invalid',
      reason: 'proof',
    });
  });

  it('rejects wrong p / h / epoch, missing proof tags and epoch-key authors', () => {
    const base = groupRumorTags(keys, EPOCH_PUB);
    const swap = (name: string, value: string) =>
      base.map((t) => (t[0] === name ? [name, value] : t));
    const r = (tags: string[][], pubkey = ME) =>
      classify({ kind: 14, pubkey, created_at: 1, tags, content: 'x' });
    expect(r(swap('p', GROUP))).toMatchObject({ reason: 'p' });
    expect(r(swap('h', EPOCH_PUB))).toMatchObject({ reason: 'h' });
    expect(r(swap('epoch', '1'))).toMatchObject({ reason: 'epoch' });
    expect(r(base.filter((t) => t[0] !== 'invitation_proof'))).toMatchObject({
      reason: 'proof-tags',
    });
    expect(r([...base, ['p', EPOCH_PUB]])).toMatchObject({ reason: 'p' });
    expect(r(base, EPOCH_PUB)).toMatchObject({ reason: 'epoch-author' });
  });

  it('reads group-key announcements and ignores other group-key messages', () => {
    const tags = [
      ['p', EPOCH_PUB],
      ['h', GROUP],
      ['epoch', '0'],
      ['member', ME],
    ];
    expect(classify({ kind: 14, pubkey: GROUP, created_at: 1, tags, content: '+' })).toEqual({
      type: 'announcement',
      change: 'joined',
      members: [ME],
    });
    expect(
      classify({ kind: 14, pubkey: GROUP, created_at: 1, tags, content: 'hello' }),
    ).toMatchObject({
      type: 'invalid',
    });
  });

  it('rejects a signed member message and an announcement carrying a proof', () => {
    const tags = groupRumorTags(keys, EPOCH_PUB);
    expect(
      classify({ kind: 14, pubkey: ME, created_at: 5, tags, content: 'hi', sig: 'f'.repeat(128) }),
    ).toMatchObject({ type: 'invalid', reason: 'signed' });
    expect(
      classify({
        kind: 14,
        pubkey: GROUP,
        created_at: 5,
        tags: [...tags, ['member', ME]],
        content: '+',
      }),
    ).toMatchObject({ type: 'invalid', reason: 'announcement' });
  });
});
