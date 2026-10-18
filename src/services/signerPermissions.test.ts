import {
  AMBER_PERMISSIONS_JSON,
  NIP46_PERMS,
  SIGNER_PREAPPROVED_EVENT_KINDS,
} from './signerPermissions';

describe('signer pre-approval permissions', () => {
  it('requests relay login explicitly while preserving existing NIP-46 methods', () => {
    expect(NIP46_PERMS).toEqual(
      expect.arrayContaining([
        'sign_event',
        'sign_event:22242',
        'nip04_encrypt',
        'nip04_decrypt',
        'nip44_encrypt',
        'nip44_decrypt',
      ]),
    );
    for (const kind of SIGNER_PREAPPROVED_EVENT_KINDS) {
      expect(NIP46_PERMS).toContain(`sign_event:${kind}`);
    }
  });

  it('serializes NIP-55 permissions as an array of method and numeric kind objects', () => {
    expect(JSON.parse(AMBER_PERMISSIONS_JSON)).toEqual([{ type: 'sign_event', kind: 22242 }]);
  });
});
