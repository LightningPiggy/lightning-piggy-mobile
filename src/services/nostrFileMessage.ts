// NIP-17 kind-15 encrypted file-message rumor builders (#235 voice notes).
// Pure tag/object construction — extracted from nostrService to keep that
// file under the 1,000-line cap (#703). The blob itself is AES-encrypted +
// uploaded elsewhere; these just describe where it is + how to decrypt it.

interface FileMessageRumor {
  kind: number;
  created_at: number;
  tags: string[][];
  content: string;
  pubkey: string;
}

/** kind-15 file message for a 1:1 recipient. */
export function createFileMessageRumor(input: {
  senderPubkey: string;
  recipientPubkey: string;
  url: string;
  mime: string;
  keyHex: string;
  nonceHex: string;
  sha256Hex: string;
  size: number;
  algorithm?: string;
  filename?: string;
}): FileMessageRumor {
  return {
    pubkey: input.senderPubkey,
    kind: 15,
    created_at: Math.floor(Date.now() / 1000),
    tags: [
      ['p', input.recipientPubkey],
      ['file-type', input.mime],
      ['encryption-algorithm', input.algorithm ?? 'aes-gcm'],
      ['decryption-key', input.keyHex],
      ['decryption-nonce', input.nonceHex],
      ['x', input.sha256Hex],
      ['size', String(input.size)],
      ...(input.filename ? [['filename', input.filename]] : []),
    ],
    content: input.url,
  };
}

/** kind-15 file message for a group (subject + a `p` tag per member). */
export function createGroupFileRumor(input: {
  senderPubkey: string;
  subject: string;
  memberPubkeys: string[];
  url: string;
  mime: string;
  keyHex: string;
  nonceHex: string;
  sha256Hex: string;
  size: number;
  algorithm?: string;
  filename?: string;
}): FileMessageRumor {
  const tags: string[][] = [['subject', input.subject]];
  for (const pk of input.memberPubkeys) {
    tags.push(['p', pk]);
  }
  tags.push(
    ['file-type', input.mime],
    ['encryption-algorithm', input.algorithm ?? 'aes-gcm'],
    ['decryption-key', input.keyHex],
    ['decryption-nonce', input.nonceHex],
    ['x', input.sha256Hex],
    ['size', String(input.size)],
    ...(input.filename ? [['filename', input.filename]] : []),
  );
  return {
    pubkey: input.senderPubkey,
    kind: 15,
    created_at: Math.floor(Date.now() / 1000),
    tags,
    content: input.url,
  };
}
