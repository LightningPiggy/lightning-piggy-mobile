import { marmotFallbackPromptCopy } from '../services/marmotFallback';
import { t } from '../i18n';
import { inviteStatusTextKey, isRemoteSigner, undeliveredInviteNotice } from './marmotInviteNotice';

const names: Record<string, string> = { a: 'Big Piggy', b: 'Little Piggy', c: 'Middle Piggy' };
const nameOf = (pubkey: string) => names[pubkey] ?? pubkey;

describe('undeliveredInviteNotice (#1402)', () => {
  it('is null when everyone was reached', () => {
    expect(undeliveredInviteNotice({ undelivered: [], waitingForRelays: [] }, nameOf)).toBeNull();
  });

  it('keeps the automatic-retry wording for invitations still being retried', () => {
    const notice = undeliveredInviteNotice({ undelivered: ['a'], waitingForRelays: [] }, nameOf);
    expect(notice).toEqual({
      title: 'Invitation not delivered yet',
      body: "We couldn't deliver the invitation to Big Piggy yet. Lightning Piggy will keep trying automatically.",
    });
  });

  it('says who is waiting on their own inbox relays, apart from the rest', () => {
    const one = undeliveredInviteNotice({ undelivered: ['b'], waitingForRelays: ['b'] }, nameOf);
    expect(one?.body).toBe(
      "Little Piggy hasn't published inbox relays yet. Lightning Piggy will send the invitation once they do.",
    );
    const mixed = undeliveredInviteNotice(
      { undelivered: ['a', 'b', 'c'], waitingForRelays: ['b', 'c'] },
      nameOf,
    );
    expect(mixed?.body).toBe(
      "We couldn't deliver the invitation to Big Piggy yet. Lightning Piggy will keep trying automatically. " +
        "Little Piggy, Middle Piggy haven't published inbox relays yet. Lightning Piggy will send their invitations once they do.",
    );
  });

  it('has a NIP-17 fallback title for a peer with no inbox relays', () => {
    expect(marmotFallbackPromptCopy('noInbox', 'Little Piggy', false).title).toBe(
      "Can't reach Little Piggy on Marmot yet",
    );
  });
});

describe('wording per signer (#1402): remote signers retry only on a send', () => {
  it('treats Amber and NIP-46 as remote signers, a local key (or none) as not', () => {
    expect(isRemoteSigner('amber')).toBe(true);
    expect(isRemoteSigner('nip46')).toBe(true);
    expect(isRemoteSigner('nsec')).toBe(false);
    expect(isRemoteSigner(null)).toBe(false);
  });

  it('keeps the automatic wording for a local key', () => {
    const body = undeliveredInviteNotice(
      { undelivered: ['a', 'b'], waitingForRelays: ['b'] },
      nameOf,
      false,
    )?.body;
    expect(body).toMatch(/keep trying automatically/);
    expect(body).not.toMatch(/next time you send a message here/);
    expect(t(inviteStatusTextKey('pending', false))).toBe(
      'Invitation not delivered yet. Lightning Piggy will keep trying.',
    );
  });

  it('says a remote signer retries on the next message sent here, never "automatically"', () => {
    const one = undeliveredInviteNotice(
      { undelivered: ['a', 'b'], waitingForRelays: ['b'] },
      nameOf,
      true,
    )?.body;
    expect(one).toBe(
      "We couldn't deliver the invitation to Big Piggy yet. It'll be retried the next time you send a message here. " +
        "Little Piggy hasn't published inbox relays yet. The invitation will be sent the next time you send a message here after they do.",
    );
    const many = undeliveredInviteNotice(
      { undelivered: ['b', 'c'], waitingForRelays: ['b', 'c'] },
      nameOf,
      true,
    )?.body;
    expect(many).toBe(
      "Little Piggy, Middle Piggy haven't published inbox relays yet. Their invitations will be sent the next time you send a message here after they do.",
    );
    expect(t(inviteStatusTextKey('waitingForRelays', true), { name: 'Little Piggy' })).toBe(
      "Invitation waiting: Little Piggy hasn't published inbox relays yet. It'll be sent the next time you send a message here after they do.",
    );
    expect(t(inviteStatusTextKey('pending', true))).toBe(
      "Invitation not delivered yet. It'll be retried the next time you send a message here.",
    );
  });
});

describe('a signer that declined or went quiet (#1402)', () => {
  it('names them apart, says they will be asked again on a send', () => {
    const notice = undeliveredInviteNotice(
      { undelivered: ['a', 'b'], waitingForRelays: [], needsSigner: ['a'] },
      nameOf,
      true,
    );
    expect(notice?.body).toBe(
      "Your signer didn't approve the invitation for Big Piggy. You'll be asked again the next time you send a message here. " +
        "We couldn't deliver the invitation to Little Piggy yet. It'll be retried the next time you send a message here.",
    );
    expect(t(inviteStatusTextKey('needsSigner', true))).toBe(
      "Invitation not sent: your signer didn't approve it. You'll be asked again the next time you send a message here.",
    );
  });
});
