import { verifyEvent, type Event as SignedEvent, type EventTemplate } from 'nostr-tools';
import { t } from '../i18n';

/** Why a remote signer's answer was refused (#1779). */
export type RemoteSignerMismatchCode = 'wrong-account' | 'modified' | 'bad-signature';

const MESSAGE_KEY: Readonly<Record<RemoteSignerMismatchCode, string>> = {
  'wrong-account': 'remoteSignerMismatch.wrongAccount',
  modified: 'remoteSignerMismatch.modified',
  'bad-signature': 'remoteSignerMismatch.badSignature',
};

/**
 * A remote signer answered with something other than the event we asked it to
 * sign for this account. The message is the localised user-facing copy (same
 * pattern as `AmberSignerError`), so a send's `result.error` reads correctly
 * wherever it is shown.
 */
export class RemoteSignerMismatchError extends Error {
  readonly code: RemoteSignerMismatchCode;

  constructor(code: RemoteSignerMismatchCode) {
    super(t(MESSAGE_KEY[code]));
    this.name = 'RemoteSignerMismatchError';
    this.code = code;
  }
}

/**
 * Accept what a remote signer (Amber / NIP-46 bunker) handed back only if it is
 * the event we asked for, signed by the account we asked for (#1779).
 *
 * A multi-account Amber or a bunker can answer with an event signed by another
 * of the user's keys. Publishing that would overwrite the other key's
 * replaceable events (follow list, relay lists, profile) with this account's
 * data, and the app would then adopt the change locally as if it were ours.
 *
 * `created_at` is deliberately not compared: a signer may legitimately restamp
 * it (see nostrNip04Send), and the pubkey + kind + tags + content check is what
 * stops the wrong-account and tampering cases. `verifySignature` (pure-JS
 * schnorr on the JS thread) also checks the id against whatever `created_at`
 * came back; leave it off on per-message paths such as NIP-17 seals, where the
 * pubkey check already stops the wrong-account case and receivers verify.
 */
export function assertRemoteSignedEvent(
  signed: unknown,
  template: EventTemplate,
  expectedPubkey: string,
  { verifySignature = true }: { verifySignature?: boolean } = {},
): SignedEvent {
  const event = signed as Partial<SignedEvent> | null;
  if (
    !event ||
    typeof event !== 'object' ||
    typeof event.pubkey !== 'string' ||
    event.pubkey.toLowerCase() !== expectedPubkey.toLowerCase()
  ) {
    throw new RemoteSignerMismatchError('wrong-account');
  }
  if (
    event.kind !== template.kind ||
    event.content !== template.content ||
    JSON.stringify(event.tags) !== JSON.stringify(template.tags)
  ) {
    throw new RemoteSignerMismatchError('modified');
  }
  if (verifySignature && !verifyEvent(event as SignedEvent)) {
    throw new RemoteSignerMismatchError('bad-signature');
  }
  return event as SignedEvent;
}

/** `assertRemoteSignedEvent` over the JSON string the signer services return. */
export function parseRemoteSignedEvent(
  json: string,
  template: EventTemplate,
  expectedPubkey: string,
  options?: { verifySignature?: boolean },
): SignedEvent {
  return assertRemoteSignedEvent(JSON.parse(json), template, expectedPubkey, options);
}
