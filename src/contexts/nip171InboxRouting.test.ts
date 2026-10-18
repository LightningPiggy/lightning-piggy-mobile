import { ingestNip171Ticket } from '../services/nip171Groups';
import { isNip171InboxRumor, routeNip171Rumor } from './nip171InboxRouting';

jest.mock('../services/nip171Groups', () => ({
  ingestNip171Ticket: jest.fn(async () => true),
  isNip171GroupIdentity: jest.fn((_owner: string, pk: string) => pk === 'g'.repeat(64)),
}));

const ME = 'a'.repeat(64);
const PEER = 'b'.repeat(64);
const GROUP = 'g'.repeat(64);
const rumor = (over: Partial<{ kind: number; pubkey: string; tags: string[][] }>) => ({
  kind: 14,
  pubkey: PEER,
  created_at: 1,
  content: 'x',
  tags: [['p', ME]],
  ...over,
});

describe('routeNip171Rumor', () => {
  it('takes tickets, group messages and chats with a group identity', async () => {
    expect(await routeNip171Rumor(rumor({ kind: 1014 }), ME)).toBe(true);
    expect(ingestNip171Ticket).toHaveBeenCalledTimes(1);
    const groupTags = [
      ['h', GROUP],
      ['invitation_proof', 'f'.repeat(128)],
    ];
    expect(await routeNip171Rumor(rumor({ tags: groupTags }), ME)).toBe(true);
    expect(await routeNip171Rumor(rumor({ pubkey: GROUP }), ME)).toBe(true);
    // Our own leave request's self-copy, addressed to the group identity.
    expect(await routeNip171Rumor(rumor({ pubkey: ME, tags: [['p', GROUP]] }), ME)).toBe(true);
  });

  it('leaves ordinary 1:1 messages to the DM inbox', async () => {
    expect(await routeNip171Rumor(rumor({}), ME)).toBe(false);
    expect(isNip171InboxRumor(rumor({}))).toBe(false);
    expect(isNip171InboxRumor(rumor({ kind: 1014 }))).toBe(true);
  });
});
