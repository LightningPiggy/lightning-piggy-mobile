/** Signer state is independent of whether a particular ciphertext is valid. */
export class SignerUnavailableError extends Error {
  readonly kind = 'unavailable';
  constructor(message = 'Signer unavailable') {
    super(message);
    this.name = 'SignerUnavailableError';
  }
}

/** A remote signer (NIP-46 bunker) didn't answer within its deadline. */
export class SignerTimeoutError extends Error {
  constructor(message = 'Signer did not answer in time') {
    super(message);
    this.name = 'SignerTimeoutError';
  }
}

export class NostrConnectError extends Error {
  constructor(
    readonly kind: 'unavailable' | 'permission' | 'failed' | 'decrypt-failed',
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'NostrConnectError';
  }
}

// Messages reproduced with the installed nostr-tools / noble / scure crypto.
const MALFORMED_CIPHERTEXT_PATTERNS = [
  /aes-\(cbc\/ecb\)\.decrypt ciphertext should consist of blocks with size 16/i,
  /aes\/pcks5: empty ciphertext not allowed/i,
  /Unknown letter:.*Allowed: ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789\+\//,
  /padding: (?:invalid|incorrect)/i,
  /"nonce" expected Uint8Array of length 16/i,
  /invalid (?:ciphertext|MAC|padding)|(?:bad|wrong) padding|invalid PKCS#7|(?:MAC|authentication tag) (?:check |verification )?failed|ciphertext.*(?:invalid|malformed)|wrong final block length/i,
];

/** Last resort for crypto libraries / bunkers that expose only a message. */
export function isCiphertextDecryptError(error: unknown): boolean {
  const message = typeof error === 'string' ? error : (error as Error | null)?.message;
  return (
    typeof message === 'string' &&
    MALFORMED_CIPHERTEXT_PATTERNS.some((pattern) => pattern.test(message))
  );
}
