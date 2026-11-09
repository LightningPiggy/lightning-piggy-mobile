import { verifyEvent, type Event as SignedEvent, type EventTemplate } from 'nostr-tools';

/**
 * Accept what a remote signer (Amber / NIP-46 bunker) handed back only if it is
 * the event we asked for, signed by the account we asked for (#1779).
 *
 * A multi-account Amber or a bunker can answer with an event signed by another
 * of the user's keys. Publishing that would overwrite the other key's
 * replaceable events (follow list, relay lists, profile) with this account's
 * data, and the app would then adopt the change locally as if it were ours.
 *
 * The pubkey + template comparison is cheap and always runs. `verifySignature`
 * adds a schnorr check (pure JS on the JS thread); leave it off on per-message
 * paths such as NIP-17 seals, where the pubkey check already stops the
 * wrong-account case and receivers verify the seal anyway.
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
    throw new Error('Signer returned an event signed by a different account');
  }
  if (
    event.kind !== template.kind ||
    event.created_at !== template.created_at ||
    event.content !== template.content ||
    JSON.stringify(event.tags) !== JSON.stringify(template.tags)
  ) {
    throw new Error('Signer returned a different event than the one requested');
  }
  if (verifySignature && !verifyEvent(event as SignedEvent)) {
    throw new Error('Signer returned an event with an invalid signature');
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
