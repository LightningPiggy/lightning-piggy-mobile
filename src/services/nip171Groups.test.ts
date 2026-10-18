import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { wrapEvent } from 'nostr-tools/nip59';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { Nip171Ticket } from '../utils/nip171';

import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  __resetNip171GroupsForTests,
  acceptNip171Invitation,
  declineNip171Invitation,
  forgetNip171Account,
  forgetNip171Group,
  isNip171GroupIdentity,
  NIP171_MAX_PENDING,
  NIP171_MAX_TICKETS_PER_GROUP,
  noteNip171Members,
  nip171Invitations,
  ingestNip171Ticket,
  loadNip171Groups,
  nip171GroupState,
  nip171GroupsFor,
  nip171Outgoing,
} from './nip171Groups';
import { ingestNip171Wrap } from './nip171Session';

const mockStore: (Nip171Ticket & { owner: string })[] = [];
jest.mock('./nip171Store', () => ({
  saveNip171Ticket: jest.fn(async (owner: string, t: Nip171Ticket) => {
    if (!mockStore.some((s) => s.owner === owner && s.id === t.id)) mockStore.push({ ...t, owner });
  }),
  loadNip171Tickets: jest.fn(async (owner: string) => mockStore.filter((s) => s.owner === owner)),
  deleteNip171Group: jest.fn(async (owner: string, group: string) => {
    for (let i = mockStore.length - 1; i >= 0; i--) {
      if (mockStore[i].owner === owner && mockStore[i].groupPubkey === group)
        mockStore.splice(i, 1);
    }
  }),
}));
const mockAppended: { groupId: string; text: string; senderPubkey: string }[] = [];
jest.mock('./groupMessagesStorageService', () => ({
  appendGroupMessage: jest.fn(async (_o: string, groupId: string, m: never) => {
    mockAppended.push({ groupId, ...(m as { text: string; senderPubkey: string }) });
  }),
}));
jest.mock('../contexts/nostrEventBus', () => ({ notifyGroupMessage: jest.fn() }));
jest.mock('./nostrService', () => ({ pool: {}, trackRelays: jest.fn() }));
jest.mock('./relayQuery', () => ({ querySyncAbortable: jest.fn() }));

const groupSk = generateSecretKey();
const GROUP = getPublicKey(groupSk);
const meSk = generateSecretKey();
const ME = getPublicKey(meSk);
const epochSk = generateSecretKey();
const EPOCH_PUB = getPublicKey(epochSk);
const peerSk = generateSecretKey();
const PEER = getPublicKey(peerSk);

/** An epoch ticket as Anagram sends it: unsigned rumor, signature on the seal. */
function anagramTicket(member: string, epoch = 0, createdAt = 1000) {
  const signed = finalizeEvent(
    {
      kind: 1014,
      created_at: createdAt,
      tags: [
        ['p', member],
        ['epoch', String(epoch)],
      ],
      content: bytesToHex(epochSk),
    },
    groupSk,
  );
  const { kind, created_at, tags, content, pubkey, sig } = signed;
  return { kind, created_at, tags, content, pubkey, sealInvitationProof: sig };
}

/** Receive the invitation and accept it. */
async function join(member: string, ticket = anagramTicket(member)) {
  await ingestNip171Ticket(member, ticket);
  expect(await acceptNip171Invitation(member, GROUP)).toBe(true);
}

beforeEach(async () => {
  await AsyncStorage.clear();
  mockStore.length = 0;
  mockAppended.length = 0;
  __resetNip171GroupsForTests();
});

describe('ingestNip171Ticket', () => {
  it('holds an Anagram ticket as an invitation until accepted', async () => {
    await loadNip171Groups(ME);
    expect(await ingestNip171Ticket(ME, anagramTicket(ME))).toBe(true);
    // Not joined: no keys in use, no group row, nothing to subscribe to.
    expect(nip171GroupState(ME, GROUP)).toBeNull();
    expect(nip171GroupsFor(ME)).toEqual([]);
    expect(nip171Invitations(ME)).toEqual([{ groupPubkey: GROUP, invitedAt: 1000 }]);
    expect(isNip171GroupIdentity(ME, GROUP)).toBe(true);

    expect(await acceptNip171Invitation(ME, GROUP)).toBe(true);
    expect(nip171GroupState(ME, GROUP)!.epochPubkey).toBe(EPOCH_PUB);
    expect(nip171Invitations(ME)).toEqual([]);
    expect(nip171GroupsFor(ME)).toEqual([
      expect.objectContaining({ id: `nip171:${GROUP}`, protocol: 'nip171' }),
    ]);
  });

  it('keeps a declined group out until a newer ticket re-invites', async () => {
    await ingestNip171Ticket(ME, anagramTicket(ME));
    await declineNip171Invitation(ME, GROUP);
    expect(nip171Invitations(ME)).toEqual([]);
    expect(mockStore).toEqual([]);
    // The same ticket read again (a refresh) is ignored...
    await ingestNip171Ticket(ME, anagramTicket(ME));
    expect(nip171Invitations(ME)).toEqual([]);
    expect(mockStore).toEqual([]);
    // ...a newer one is a new invitation.
    await ingestNip171Ticket(ME, anagramTicket(ME, 1, 2000));
    expect(nip171Invitations(ME)).toEqual([{ groupPubkey: GROUP, invitedAt: 2000 }]);
  });

  it('keeps the keys if the decline cannot be recorded', async () => {
    await ingestNip171Ticket(ME, anagramTicket(ME));
    jest.mocked(AsyncStorage.setItem).mockRejectedValueOnce(new Error('full'));
    await expect(declineNip171Invitation(ME, GROUP)).rejects.toThrow('full');
    // Nothing deleted without the record that keeps the ticket out.
    expect(mockStore).toHaveLength(1);
  });

  it('bounds tickets per group, refusing future times and repeats but taking rotations', async () => {
    await join(ME);
    const now = Math.floor(Date.now() / 1000);
    // Far future: refused (it would also outrank every later decline).
    await ingestNip171Ticket(ME, anagramTicket(ME, 0, now + 3600));
    expect(mockStore).toHaveLength(1);
    // The same key again, no newer: a repeat.
    await ingestNip171Ticket(ME, anagramTicket(ME, 0, 1000));
    expect(mockStore).toHaveLength(1);
    // Same epoch, newer times: kept up to the cap, then dropped.
    for (let i = 1; i <= NIP171_MAX_TICKETS_PER_GROUP + 3; i++) {
      await ingestNip171Ticket(ME, anagramTicket(ME, 0, 1000 + i));
    }
    expect(mockStore).toHaveLength(NIP171_MAX_TICKETS_PER_GROUP);
    // A higher epoch is a key rotation: always taken.
    await ingestNip171Ticket(ME, anagramTicket(ME, 1, 5000));
    expect(mockStore).toHaveLength(NIP171_MAX_TICKETS_PER_GROUP + 1);
    expect(nip171GroupState(ME, GROUP)!.keys.epoch).toBe(1);
  });

  it('hands back the same group rows until something changes', async () => {
    await join(ME);
    const first = nip171GroupsFor(ME);
    expect(nip171GroupsFor(ME)).toBe(first);
    noteNip171Members(ME, GROUP, [PEER]);
    expect(nip171GroupsFor(ME)).not.toBe(first);
  });

  it('caps unanswered invitations', async () => {
    for (let i = 0; i < NIP171_MAX_PENDING + 3; i++) {
      const sk = generateSecretKey();
      const signed = finalizeEvent(
        {
          kind: 1014,
          created_at: 1000 + i,
          tags: [
            ['p', ME],
            ['epoch', '0'],
          ],
          content: bytesToHex(epochSk),
        },
        sk,
      );
      const { kind, created_at, tags, content, pubkey, sig } = signed;
      await ingestNip171Ticket(ME, {
        kind,
        created_at,
        tags,
        content,
        pubkey,
        sealInvitationProof: sig,
      });
    }
    expect(nip171Invitations(ME)).toHaveLength(NIP171_MAX_PENDING);
  });

  it('forgets everything for a wiped account', async () => {
    await join(ME);
    await forgetNip171Account(ME);
    expect(nip171GroupState(ME, GROUP)).toBeNull();
    expect(isNip171GroupIdentity(ME, GROUP)).toBe(false);
  });

  it('swallows an invalid ticket without joining', async () => {
    const bad = { ...anagramTicket(ME), sealInvitationProof: '0'.repeat(128) };
    expect(await ingestNip171Ticket(ME, bad)).toBe(true);
    expect(nip171GroupsFor(ME)).toEqual([]);
  });

  it('ignores rumors that are not tickets', async () => {
    expect(
      await ingestNip171Ticket(ME, {
        kind: 14,
        pubkey: PEER,
        created_at: 1,
        tags: [],
        content: '',
      }),
    ).toBe(false);
  });
});

describe('nip171Outgoing', () => {
  it('addresses the epoch key with the membership proof', async () => {
    const ticket = anagramTicket(ME);
    await join(ME, ticket);
    const out = nip171Outgoing(ME, `nip171:${GROUP}`, 'hi', ['wss://a']);
    if ('error' in out) throw new Error(out.error);
    expect(out.recipientPubkeys).toEqual([EPOCH_PUB]);
    expect(out.rumor.tags).toEqual([
      ['p', EPOCH_PUB],
      ['h', GROUP],
      ['epoch', '0'],
      ['invited_at', '1000'],
      ['invitation_proof', ticket.sealInvitationProof],
    ]);
  });

  it('refuses groups we are not in', () => {
    expect(nip171Outgoing(ME, `nip171:${GROUP}`, 'hi', [])).toEqual({
      error: 'Not a member of this group',
    });
  });

  it('leaves for good: the same ticket read again does not rejoin', async () => {
    await join(ME);
    await forgetNip171Group(ME, GROUP);
    expect(nip171GroupsFor(ME)).toEqual([]);
    expect(mockStore).toEqual([]);
    await ingestNip171Ticket(ME, anagramTicket(ME));
    expect(nip171GroupsFor(ME)).toEqual([]);
    expect(nip171Invitations(ME)).toEqual([]);
    // Our leave request's self-copy still belongs to no 1:1 chat.
    expect(isNip171GroupIdentity(ME, GROUP)).toBe(true);
  });
});

describe('ingestNip171Wrap', () => {
  /** A member's message, built the way Anagram builds one. */
  async function memberWrap(senderSk: Uint8Array, proofOverride?: string) {
    await join(getPublicKey(senderSk));
    const sender = nip171GroupState(getPublicKey(senderSk), GROUP)!;
    const tags = [
      ['p', EPOCH_PUB],
      ['h', GROUP],
      ['epoch', '0'],
      ['invited_at', String(sender.keys.current.createdAt)],
      ['invitation_proof', proofOverride ?? sender.keys.current.sig],
    ];
    return wrapEvent({ kind: 14, created_at: 2000, tags, content: 'hello' }, senderSk, EPOCH_PUB);
  }

  it('stores a member message whose proof verifies', async () => {
    const wrap = await memberWrap(peerSk);
    await join(ME);
    const state = nip171GroupState(ME, GROUP)!;
    expect(await ingestNip171Wrap(ME, state, wrap)).toBe('stored');
    expect(mockAppended).toEqual([
      expect.objectContaining({ groupId: `nip171:${GROUP}`, text: 'hello', senderPubkey: PEER }),
    ]);
    expect(state.members.has(PEER)).toBe(true);
  });

  it('drops a message with a forged proof', async () => {
    const wrap = await memberWrap(peerSk, '1'.repeat(128));
    await join(ME);
    expect(await ingestNip171Wrap(ME, nip171GroupState(ME, GROUP)!, wrap)).toBe('invalid');
    expect(mockAppended).toEqual([]);
  });

  it('applies a member announcement from the group key', async () => {
    await join(ME);
    const wrap = wrapEvent(
      {
        kind: 14,
        created_at: 2000,
        tags: [
          ['p', EPOCH_PUB],
          ['h', GROUP],
          ['epoch', '0'],
          ['member', PEER],
        ],
        content: '+',
      },
      groupSk,
      EPOCH_PUB,
    );
    const state = nip171GroupState(ME, GROUP)!;
    expect(await ingestNip171Wrap(ME, state, wrap)).toBe('announcement');
    expect(state.members.has(PEER)).toBe(true);
    const left = wrapEvent(
      {
        kind: 14,
        created_at: 2001,
        tags: [
          ['p', EPOCH_PUB],
          ['h', GROUP],
          ['epoch', '0'],
          ['member', PEER],
        ],
        content: '-',
      },
      groupSk,
      EPOCH_PUB,
    );
    expect(await ingestNip171Wrap(ME, state, left)).toBe('announcement');
    expect(state.members.has(PEER)).toBe(false);
  });
});
