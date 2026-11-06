import { getWelcome, type MarmotClient } from '@internet-privacy/marmot-ts';
import { previewInvitationWelcome } from './marmotInvitationPreview';
import type { MarmotRumor } from './marmotSession';

import { joinGroup } from '@internet-privacy/marmot-ts/mls';

jest.mock('@internet-privacy/marmot-ts', () => ({
  getWelcome: jest.fn(),
  getGroupMemberPubkeys: (state: { members: string[] }) => state.members,
  isValidAccountIdentity: () => true,
}));
jest.mock('@internet-privacy/marmot-ts/mls', () => ({
  defaultCredentialTypes: { basic: 1 },
  joinGroup: jest.fn(),
}));
const rumor = { id: 'welcome' } as MarmotRumor;

it('uses the same KeyPackageRef/private-secret selection as auto-join before reading group metadata', async () => {
  const welcome = { secrets: [] };
  (getWelcome as jest.Mock).mockReturnValue(welcome);
  const client = {
    keyPackages: { selectForWelcome: jest.fn().mockResolvedValue([{ hasMatchingSecret: false }]) },
    previewWelcome: jest.fn(),
  };
  expect(await previewInvitationWelcome(client as unknown as MarmotClient, rumor)).toEqual({
    forThisDevice: false,
    groupId: undefined,
    group: null,
  });
  expect(client.keyPackages.selectForWelcome).toHaveBeenCalledWith(welcome);
  expect(joinGroup).not.toHaveBeenCalled();
  expect(client.previewWelcome).not.toHaveBeenCalled();
});

it('exposes the MLS group id and member-account count when this install holds a matching secret', async () => {
  (getWelcome as jest.Mock).mockReturnValue({ secrets: [] });
  const held = { hasMatchingSecret: true, publicPackage: { cipherSuite: 1 }, privatePackage: {} };
  (joinGroup as jest.Mock)
    .mockRejectedValueOnce(new Error('not this key package'))
    .mockResolvedValueOnce({
      groupContext: { groupId: new Uint8Array([1, 2]) },
      // Two devices of one account plus another account: two member accounts.
      members: ['A'.repeat(64), 'a'.repeat(64), 'b'.repeat(64)],
    });
  const client = {
    keyPackages: {
      selectForWelcome: jest.fn().mockResolvedValue([{ ...held, hasMatchingSecret: false }, held]),
    },
    cryptoProvider: { getCiphersuiteImpl: jest.fn().mockResolvedValue({}) },
    previewWelcome: jest.fn().mockResolvedValue({ group: { name: 'Family' } }),
  };
  expect(await previewInvitationWelcome(client as unknown as MarmotClient, rumor)).toEqual({
    forThisDevice: true,
    groupId: '0102',
    memberCount: 2,
    group: { name: 'Family' },
  });
  // Decrypted in memory only: nothing is joined or stored.
  expect(joinGroup).toHaveBeenCalledTimes(2);
});

it('leaves the member count unknown when no held key package opens the Welcome', async () => {
  (getWelcome as jest.Mock).mockReturnValue({ secrets: [] });
  (joinGroup as jest.Mock).mockRejectedValue(new Error('no'));
  const client = {
    keyPackages: {
      selectForWelcome: jest
        .fn()
        .mockResolvedValue([
          { hasMatchingSecret: true, publicPackage: { cipherSuite: 1 }, privatePackage: {} },
        ]),
    },
    cryptoProvider: { getCiphersuiteImpl: jest.fn().mockResolvedValue({}) },
    previewWelcome: jest.fn().mockResolvedValue({ group: { name: '' } }),
  };
  const preview = await previewInvitationWelcome(client as unknown as MarmotClient, rumor);
  expect(preview).toMatchObject({
    forThisDevice: true,
    groupId: undefined,
    memberCount: undefined,
  });
});
