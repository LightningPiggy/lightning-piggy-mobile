/** Event kinds requested for pre-approval on the next signer connect/re-pair. */
export const SIGNER_PREAPPROVED_EVENT_KINDS = [22242] as const;

/** Keep broad signing and encryption permissions alongside explicit per-kind grants. */
export const NIP46_PERMS = [
  'sign_event',
  ...SIGNER_PREAPPROVED_EVENT_KINDS.map((kind) => `sign_event:${kind}`),
  'nip04_encrypt',
  'nip04_decrypt',
  'nip44_encrypt',
  'nip44_decrypt',
];

/** NIP-55 get_public_key Intent extra: JSON array with numeric event kinds. */
export const AMBER_PERMISSIONS_JSON = JSON.stringify(
  SIGNER_PREAPPROVED_EVENT_KINDS.map((kind) => ({ type: 'sign_event', kind })),
);
