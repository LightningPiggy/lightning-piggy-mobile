import {
  buildChatReactionDeletionRumor,
  buildChatReactionRumor,
  isChatReactionKind,
  serializeChatReactionRumor,
  storedChatReactionEvent,
} from './nip17Reactions';

const ME = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const TARGET = '1'.repeat(64);

describe('nip17Reactions', () => {
  it('treats only kind 7 and kind 5 as reaction kinds', () => {
    expect([7, 5, 14, 15, 1018, undefined].map(isChatReactionKind)).toEqual([
      true,
      true,
      false,
      false,
      false,
      false,
    ]);
  });

  it('tags a reaction to the peer’s message with NIP-25 e / p / k only', () => {
    const rumor = buildChatReactionRumor({
      myPubkey: ME,
      peerPubkey: PEER,
      emoji: '❤️',
      targetEventId: TARGET.toUpperCase(),
      targetAuthorPubkey: PEER,
      createdAt: 5,
    });
    expect(rumor).toEqual({
      kind: 7,
      pubkey: ME,
      created_at: 5,
      content: '❤️',
      tags: [
        ['e', TARGET],
        ['p', PEER],
        ['k', '14'],
      ],
    });
  });

  it('adds the peer after the author when reacting to our own message', () => {
    const rumor = buildChatReactionRumor({
      myPubkey: ME,
      peerPubkey: PEER,
      emoji: '👍',
      targetEventId: TARGET,
      targetAuthorPubkey: ME,
      targetEventKind: 15,
    });
    expect(rumor.tags).toEqual([
      ['e', TARGET],
      ['p', ME],
      ['p', PEER],
      ['k', '15'],
    ]);
  });

  it('builds a retraction with e / k like Amethyst and Anagram, plus the peer', () => {
    expect(
      buildChatReactionDeletionRumor({
        myPubkey: ME,
        peerPubkey: PEER,
        reactionEventId: TARGET,
        createdAt: 9,
      }),
    ).toEqual({
      kind: 5,
      pubkey: ME,
      created_at: 9,
      content: '',
      tags: [
        ['e', TARGET],
        ['k', '7'],
        ['p', PEER],
      ],
    });
  });

  it('round-trips a stored row back to the event shape', () => {
    const rumor = buildChatReactionRumor({
      myPubkey: ME,
      peerPubkey: PEER,
      emoji: '🎉',
      targetEventId: TARGET,
      targetAuthorPubkey: PEER,
    });
    const event = storedChatReactionEvent({
      wireKind: 7,
      content: serializeChatReactionRumor(rumor),
      sender: ME.toUpperCase(),
      createdAt: 42,
      rumorId: 'ABC',
    });
    expect(event).toEqual({
      id: 'abc',
      pubkey: ME,
      kind: 7,
      content: '🎉',
      created_at: 42,
      tags: rumor.tags,
    });
  });

  it('rejects rows that are not readable reactions', () => {
    const base = { wireKind: 7, content: '{"content":"x","tags":[]}', sender: ME, createdAt: 1 };
    expect(storedChatReactionEvent({ ...base, rumorId: 'id', wireKind: 14 })).toBeNull();
    expect(storedChatReactionEvent(base)).toBeNull(); // no rumor id
    expect(storedChatReactionEvent({ ...base, rumorId: 'id', content: 'not json' })).toBeNull();
    expect(storedChatReactionEvent({ ...base, rumorId: 'id', content: '{"tags":[]}' })).toBeNull();
    // Malformed tags are dropped rather than failing the row.
    expect(
      storedChatReactionEvent({
        ...base,
        rumorId: 'id',
        content: '{"content":"x","tags":[["e","t"],[1,2],"bad"]}',
      })?.tags,
    ).toEqual([['e', 't']]);
  });
});
