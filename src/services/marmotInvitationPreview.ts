import {
  getGroupMemberPubkeys,
  getWelcome,
  isValidAccountIdentity,
  type MarmotClient,
} from '@internet-privacy/marmot-ts';
import {
  defaultCredentialTypes,
  joinGroup,
  type AuthenticationService,
  type Welcome,
} from '@internet-privacy/marmot-ts/mls';
import { bytesToHex } from '@noble/hashes/utils.js';
import { hasWelcomeKeyPackage } from './marmotWelcomeFailure';
import type { MarmotRumor } from './marmotSession';

/** marmot-ts's own credential rule (its `marmotAuthService` isn't exported). */
const authService: AuthenticationService = {
  async validateCredential(credential) {
    if (credential.credentialType !== defaultCredentialTypes.basic || !('identity' in credential))
      return false;
    return credential.identity instanceof Uint8Array && isValidAccountIdentity(credential.identity);
  },
};

/**
 * Decrypt the Welcome in memory with a held key package, as marmot-ts's
 * readInviteGroupInfo does, but keep the member list it discards: the group
 * ID plus how many ACCOUNTS (not devices) the group has. Nothing is stored or
 * joined; undefined when no held key package opens it.
 */
async function readInvite(
  client: MarmotClient,
  welcome: Welcome,
): Promise<{ groupId: string; memberCount: number } | undefined> {
  for (const candidate of await client.keyPackages.selectForWelcome(welcome)) {
    try {
      const cipherSuite = await client.cryptoProvider.getCiphersuiteImpl(
        candidate.publicPackage.cipherSuite,
      );
      const state = await joinGroup({
        context: { cipherSuite, authService, externalPsks: {} },
        welcome,
        keyPackage: candidate.publicPackage,
        privateKeys: candidate.privatePackage,
      });
      const members = new Set(getGroupMemberPubkeys(state).map((p) => p.toLowerCase()));
      return { groupId: bytesToHex(state.groupContext.groupId), memberCount: members.size };
    } catch {
      // Try the next held key package.
    }
  }
  return undefined;
}

/** Validate this install's private key material before exposing invitation metadata. */
export async function previewInvitationWelcome(client: MarmotClient, rumor: MarmotRumor) {
  const welcome = getWelcome(rumor);
  if (!(await hasWelcomeKeyPackage(client.keyPackages, welcome)))
    return { forThisDevice: false, groupId: undefined, group: null };
  const info = await readInvite(client, welcome);
  const preview = await client.previewWelcome(rumor);
  return {
    ...preview,
    forThisDevice: true,
    groupId: info?.groupId,
    memberCount: info?.memberCount,
  };
}
