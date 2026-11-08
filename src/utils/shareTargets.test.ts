import { recentShareTargets } from './shareTargets';
import type { ConversationSummary } from './conversationSummaries';
import type { GroupSummary } from '../types/groups';

const dm = (id: string, name: string, at: number, extra: Partial<ConversationSummary> = {}) =>
  ({
    id,
    pubkey: id.split(':')[0],
    name,
    picture: null,
    nip05: null,
    lightningAddress: null,
    lastActivityAt: at,
    lastAmountSats: 0,
    lastDirection: 'incoming',
    lastComment: '',
    anonymous: false,
    protocol: 'nip17',
    ...extra,
  }) as ConversationSummary;

const group = (id: string, name: string, at: number) =>
  ({
    group: { id, name },
    activity: { lastActivityAt: at, lastText: '', lastSenderPubkey: null, recentSenderPubkeys: [] },
  }) as unknown as GroupSummary;

describe('recentShareTargets', () => {
  it('interleaves 1:1 chats and groups, newest first, capped', () => {
    const rows = recentShareTargets(
      [dm('a:nip17', 'Alice', 30), dm('b:marmot', 'Bob', 10)],
      [group('g1', 'Family', 20), group('g2', 'Club', 5)],
      '',
      3,
    );
    expect(rows.map((r) => r.key)).toEqual(['dm:a:nip17', 'group:g1', 'dm:b:marmot']);
  });

  it('filters by name, case-insensitively', () => {
    const rows = recentShareTargets(
      [dm('a:nip17', 'Alice', 30), dm('b:nip17', 'Bob', 10)],
      [group('g1', 'Alice & friends', 20)],
      '  ALI ',
    );
    expect(rows.map((r) => r.key)).toEqual(['dm:a:nip17', 'group:g1']);
  });

  it('leaves out rows that cannot take a message', () => {
    const rows = recentShareTargets(
      [
        dm('anon:w:1', 'Anonymous', 40, { pubkey: null, anonymous: true }),
        dm('c:marmot', 'Carol', 30, { marmotInviteFailed: true }),
        dm('d:nip17', 'Dan', 20),
      ],
      [],
      '',
    );
    expect(rows.map((r) => r.key)).toEqual(['dm:d:nip17']);
  });
});
