import { invitationAlert, isDirectInvite } from './marmotInvitationKind';

const ben = 'b'.repeat(64);
const me = 'a'.repeat(64);
const carol = 'c'.repeat(64);

describe('isDirectInvite', () => {
  it('an unnamed group whose admins are the sender and me is a 1:1', () => {
    expect(isDirectInvite({ name: '', adminPubkeys: [ben, me] }, ben, me)).toBe(true);
    expect(isDirectInvite({ name: '', adminPubkeys: [ben.toUpperCase()] }, ben, me)).toBe(true);
  });

  it('a named group, or one with another admin, is a group', () => {
    expect(isDirectInvite({ name: 'Family', adminPubkeys: [ben, me] }, ben, me)).toBe(false);
    expect(isDirectInvite({ name: '', adminPubkeys: [ben, me, carol] }, ben, me)).toBe(false);
    expect(isDirectInvite({ name: '', adminPubkeys: [carol] }, ben, me)).toBe(false);
  });

  it('without our key, allows one admin besides the sender', () => {
    expect(isDirectInvite({ name: '', adminPubkeys: [ben, me] }, ben)).toBe(true);
    expect(isDirectInvite({ name: '', adminPubkeys: [ben, me, carol] }, ben)).toBe(false);
  });

  it('an unknown group (no preview) is not called a 1:1', () => {
    expect(isDirectInvite(null, ben, me)).toBe(false);
  });
});

describe('invitationAlert', () => {
  it('a 1:1 reads as a message from the person', () => {
    expect(invitationAlert(true, 'Ben')).toEqual({
      kind: 'dm',
      title: 'Ben',
      body: 'Invited you to a secure chat. Tap to accept.',
    });
  });

  it('a group keeps the group invitation copy', () => {
    expect(invitationAlert(false, 'Ben')).toMatchObject({
      kind: 'group',
      title: 'New group invitation',
    });
  });
});
