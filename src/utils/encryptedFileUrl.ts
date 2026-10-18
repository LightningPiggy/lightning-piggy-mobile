// --- Encrypted voice-note URL encoding (#235, NIP-17 kind 15) ---
//
// kind-15 file messages carry the blob URL + AES-256-GCM decryption params
// in event tags. Internally we fold those into the message `text` as a URL
// fragment (`#lpe=1&alg=…&k=…&n=…&m=…`) so the existing string-based message
// store + DM cache carry everything the player needs without a schema
// change. The fragment is NEVER sent to the Blossom server (HTTP strips
// `#…` from requests), and the whole string only ever lives inside the
// E2E-encrypted DM realm. The wire format stays standard NIP-17 kind 15.
//
// Kept in its own dependency-free module so both messageContent (parse side)
// and nip17Unwrap (textForRumor) can import the encoder without dragging in
// messageContent's heavier graph (boltzService → bitcoinjs-lib), which Jest
// can't parse in unit tests.
const LPE_MARKER = 'lpe=1';

export function encodeEncryptedFileUrl(input: {
  url: string;
  mime: string;
  keyHex: string;
  nonceHex: string;
  algorithm?: string;
  filename?: string;
  dim?: string;
  size?: number;
  sha256?: string;
}): string {
  const frag =
    `${LPE_MARKER}&alg=${encodeURIComponent(input.algorithm ?? 'aes-gcm')}` +
    `&k=${input.keyHex}&n=${input.nonceHex}&m=${encodeURIComponent(input.mime)}` +
    (input.size === undefined ? '' : `&s=${input.size}`);
  // Strip any pre-existing fragment on the source URL before appending ours.
  // A double-`#` string would break parseVoiceNote, which splits on the FIRST
  // `#` and would then fail to read our params. Blossom URLs don't normally
  // carry a fragment, but a foreign/unexpected URL might.
  const base = input.url.split('#')[0];
  // `!== undefined`, not truthiness: a kind-15 with an empty `x` tag has
  // *declared* a (bad) hash. Dropping it here would turn it into "no hash"
  // and skip the cache's ciphertext check (#1500 M9).
  const dimensions = input.dim ? `&dim=${encodeURIComponent(input.dim)}` : '';
  const hash = input.sha256 !== undefined ? `&x=${encodeURIComponent(input.sha256)}` : '';
  return `${base}#${frag}${hash}${dimensions}${input.filename ? `&f=${encodeURIComponent(input.filename)}` : ''}`;
}

// --- Marmot encrypted media (MIP-04 `encrypted-media-v1` / `-v2`) ---
//
// Marmot photos are ChaCha20-Poly1305 blobs whose key is derived from the
// MLS group's epoch secret, not a random key in the message. The session
// derives the key(s) on receipt (one candidate per retained epoch — the
// `imeta` tag doesn't say which epoch) and folds them, plus the fields the
// AEAD binds, into the same `#lpe=1…` fragment (`alg` = the media version)
// so the renderer needs no group state. Lives here for the same
// dependency-free reason as above.
export const MARMOT_MEDIA_VERSIONS = ['encrypted-media-v1', 'encrypted-media-v2'] as const;
export type MarmotMediaVersion = (typeof MARMOT_MEDIA_VERSIONS)[number];

export const isMarmotMediaVersion = (alg: string): alg is MarmotMediaVersion =>
  (MARMOT_MEDIA_VERSIONS as readonly string[]).includes(alg);

export interface MarmotMediaUrlParams {
  url: string;
  version: MarmotMediaVersion;
  mime: string;
  /** Candidate 32-byte file keys (hex), tried in order. */
  keysHex: string[];
  nonceHex: string;
  filename: string;
  plaintextSha256: string;
  ciphertextSha256: string;
  name?: string;
  size?: number;
}

export function encodeMarmotMediaUrl(input: MarmotMediaUrlParams): string {
  const frag =
    `${LPE_MARKER}&alg=${input.version}&k=${input.keysHex.join(',')}&n=${input.nonceHex}` +
    `&m=${encodeURIComponent(input.mime)}&f=${encodeURIComponent(input.filename)}` +
    `&ps=${input.plaintextSha256}&cs=${input.ciphertextSha256}`;
  const metadata =
    `&name=${encodeURIComponent(input.name ?? input.filename)}` +
    (input.size !== undefined ? `&size=${input.size}` : '');
  return `${input.url.split('#')[0]}#${frag}${metadata}`;
}
