import { invitationAlert, isDirectInvite } from './marmotInvitationKind';

const ben = 'b'.repeat(64);
const me = 'a'.repeat(64);
const carol = 'c'.repeat(64);

describe('isDirectInvite', () => {
  it('an unnamed group whose admins are the sender and me, with two member accounts, is a 1:1', () => {
    expect(isDirectInvite({ name: '', adminPubkeys: [ben, me] }, ben, me, 2)).toBe(true);
    expect(isDirectInvite({ name: '', adminPubkeys: [me, ben.toUpperCase()] }, ben, me, 2)).toBe(
      true,
    );
  });

  it('extra non-admin members make it a group, however the admins look', () => {
    // A sender can name no group and make only {sender, me} admins, then add
    // Carol and Dave as ordinary members. That must not read as a 1:1.
    expect(isDirectInvite({ name: '', adminPubkeys: [ben, me] }, ben, me, 3)).toBe(false);
    expect(isDirectInvite({ name: '', adminPubkeys: [ben, me] }, ben, me, 4)).toBe(false);
  });

  it('an unknown member count is not called a 1:1', () => {
    expect(isDirectInvite({ name: '', adminPubkeys: [ben, me] }, ben, me)).toBe(false);
  });

  it('a named group, or one with another admin, is a group', () => {
    expect(isDirectInvite({ name: 'Family', adminPubkeys: [ben, me] }, ben, me, 2)).toBe(false);
    expect(isDirectInvite({ name: '', adminPubkeys: [ben, me, carol] }, ben, me, 2)).toBe(false);
    expect(isDirectInvite({ name: '', adminPubkeys: [carol] }, ben, me, 2)).toBe(false);
  });

  it("a creator-only-admin unnamed group isn't a 1:1 (it may have three accounts)", () => {
    // createGroup('', [me, carol]) makes the creator the sole admin.
    expect(isDirectInvite({ name: '', adminPubkeys: [ben] }, ben, me, 2)).toBe(false);
  });

  it('without our key, or with no preview, it stays a group', () => {
    expect(isDirectInvite({ name: '', adminPubkeys: [ben, me] }, ben, undefined, 2)).toBe(false);
  });

  it('an unknown group (no preview) is not called a 1:1', () => {
    expect(isDirectInvite(null, ben, me)).toBe(false);
  });
});

describe('invitationAlert', () => {
  it('a 1:1 reads as a message from the person', () => {
    expect(invitationAlert(true, 'Ben', true)).toEqual({
      kind: 'dm',
      title: 'Ben',
      body: 'Invited you to a secure chat. Tap to accept.',
    });
  });

  it("with lock-screen content off, a 1:1 alert doesn't name the sender", () => {
    expect(invitationAlert(true, 'Ben', false)).toEqual({
      kind: 'dm',
      title: 'Secure chat invitation',
      body: 'Tap to accept.',
    });
  });

  it('a group keeps the group invitation copy', () => {
    expect(invitationAlert(false, 'Ben', true)).toMatchObject({
      kind: 'group',
      title: 'New group invitation',
    });
  });
});
