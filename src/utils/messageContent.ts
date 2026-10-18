import {
  parseFileAttachment,
  parsePlainFileAttachment,
  type FileAttachment,
} from './fileAttachment';
import { checkRemoteUrl } from './remoteUrlPolicy';
import { decode as bolt11Decode } from 'light-bolt11-decoder';
import { decodeProfileReference } from '../services/nostrService';
import { extractGifUrl } from '../services/giphyService';
import { parseGeoMessage, SharedLocation } from '../services/locationService';
import { isPollVoteMessage, parsePoll } from './pollMessage';
import { legacyPollToStored, type DisplayPoll } from './nip88Poll';
import { parseLiveLocationMarker, type LiveLocationMarker } from '../services/liveLocationService';
import { isBitcoinAddress } from '../services/boltzService';
import { parseBip21, ParsedBip21 } from './bip21';
import { isMarmotMediaVersion, type MarmotMediaVersion } from './encryptedFileUrl';

// Bolt11 invoices are self-identifying by their `lnXX` HRP, so detection
// here matches them with or without the `lightning:` prefix.
const INVOICE_REGEX = /\b(?:lightning:)?(ln(?:bc|tb|ts|bs)[0-9a-z]{50,})\b/i;

// Image URLs we render inline in message bubbles. We only match trusted image
// extensions so we don't accidentally fetch arbitrary URLs as images.
const IMAGE_URL_REGEX = /^(https?:\/\/\S+?\.(?:png|jpe?g|gif|webp|heic|heif))(?:\?\S*)?$/i;

// Lightning addresses look like plain email addresses — `alice@example.com`
// — so we only treat a message as a payable LN address when the sender
// explicitly prefixes it with `lightning:`. Otherwise we'd turn every
// shared email into a Pay button and guess wrong.
const LN_ADDRESS_REGEX = /lightning:([a-z0-9._+-]+@[a-z0-9.-]+\.[a-z]{2,})\b/i;

// NIP-21 nostr: URIs carrying a NIP-19 profile reference (npub or nprofile).
// We only treat profile-kind references as contact shares here — note, nevent,
// naddr etc. fall through to plain text rendering.
const NOSTR_PROFILE_URI_REGEX = /nostr:(npub1[0-9a-z]+|nprofile1[0-9a-z]+)/i;

export interface DecodedInvoice {
  raw: string;
  amountSats: number | null;
  description: string | null;
  /** Epoch seconds at which the invoice becomes invalid. `null` = unknown. */
  expiresAt: number | null;
  /** 32-byte payment hash (hex). Used to poll NWC for paid status. */
  paymentHash: string | null;
}

export interface SharedContactRef {
  pubkey: string;
  relays: string[];
}

export type BitcoinUri = ParsedBip21;

// Magic string that triggers the "Toggle Secret Mode" inline card in
// chat. Only Lightning Piggy installs render the card — other Nostr
// clients show it as a plain text line, which is fine because to
// non-LP clients it's a meaningless word. Case-insensitive match,
// must be the entire trimmed body so users can still discuss the
// trigger word without firing it.
const SECRET_MODE_TRIGGER = 'secretthreewords';

export function isSecretModeTrigger(text: string): boolean {
  if (!text) return false;
  return text.trim().toLowerCase() === SECRET_MODE_TRIGGER;
}

export function extractImageUrl(text: string): string | null {
  if (!text) return null;
  // Only treat a message as an image when the entire body is the URL. This
  // avoids silently dropping surrounding text like "check this https://…jpg".
  const trimmed = text.trim();
  const match = trimmed.match(IMAGE_URL_REGEX);
  return match ? match[0] : null;
}

// Audio / voice-note URLs (#235). Same "entire body is the URL" rule as
// images so surrounding text isn't swallowed. Our recorder emits AAC
// (.m4a); Blossom servers commonly serve it back as `.mp4` (Primal does),
// so accept both, plus the other common audio extensions for notes from
// other clients.
const AUDIO_URL_REGEX = /^(https?:\/\/\S+?\.(?:m4a|mp4|aac|mp3|ogg|opus|wav))(?:\?\S*)?$/i;

export function extractAudioUrl(text: string): string | null {
  if (!text) return null;
  const trimmed = text.trim();
  const match = trimmed.match(AUDIO_URL_REGEX);
  return match ? match[0] : null;
}

// Encrypted voice-note URL encoder (#235). Lives in ./encryptedFileUrl (a
// dependency-free module) so nip17Unwrap can use it without pulling in this
// file's heavier graph; re-exported here for existing importers.
export { encodeEncryptedFileUrl } from './encryptedFileUrl';

export interface ParsedVoiceNote {
  /** Fetch URL with the fragment stripped. */
  url: string;
  mime: string;
  encrypted: boolean;
  blocked?: boolean;
  size?: number;
  sha256?: string;
  keyHex?: string;
  nonceHex?: string;
  /** Set for a Marmot (MIP-04) voice note — decrypted with these instead of AES-GCM. */
  marmot?: MarmotImageParams;
}

/**
 * Detect a voice note: either an `#lpe=1` encrypted-file URL whose mime is
 * `audio/*` (new path), or a plain audio URL (legacy / unencrypted / other
 * clients). Returns null for anything else. Backward-compatible — plaintext
 * audio URLs already in threads keep working.
 */
export function parseVoiceNote(text: string): ParsedVoiceNote | null {
  if (!text) return null;
  const trimmed = text.trim();
  const hashIdx = trimmed.indexOf('#');
  if (hashIdx >= 0) {
    const params = new URLSearchParams(trimmed.slice(hashIdx + 1));
    // Require `lpe` to equal exactly '1'. A substring test would also fire
    // on unrelated fragments like `#lpe=10` and try to decrypt them.
    if (params.get('lpe') === '1') {
      const url = trimmed.slice(0, hashIdx);
      const blocked = !checkRemoteUrl(url, { kind: 'media' }).ok;
      const size = params.has('s') ? Number(params.get('s')) : undefined;
      const keyHex = params.get('k') ?? undefined;
      const nonceHex = params.get('n') ?? undefined;
      const mime = params.get('m') ?? 'application/octet-stream';
      // We only implement AES-GCM (see encryptedFile.ts). If a kind-15 file
      // arrives with a different `alg`, bail to plain-text rendering rather
      // than show a voice-note card that would fail when the user hits play.
      // `alg` is always emitted by our encoder, so absence is tolerated.
      const alg = params.get('alg') ?? 'aes-gcm';
      if (isMarmotMediaVersion(alg)) {
        const marmot = parseMarmotMedia(alg, mime, nonceHex, params, 'audio/');
        return (
          marmot && {
            url,
            mime,
            encrypted: true,
            nonceHex,
            marmot,
            ...(blocked ? { blocked } : {}),
            size,
          }
        );
      }
      if (alg !== 'aes-gcm') return null;
      // Only audio here — encrypted images are handled separately (#688).
      if (!keyHex || !nonceHex || !mime.startsWith('audio/')) return null;
      return {
        url,
        mime,
        encrypted: true,
        keyHex,
        nonceHex,
        ...(blocked ? { blocked } : {}),
        size,
        ...(params.has('x') ? { sha256: params.get('x')! } : {}),
      };
    }
  }
  const plain = extractAudioUrl(trimmed);
  return plain
    ? {
        url: plain,
        mime: 'audio/mp4',
        encrypted: false,
        ...(!checkRemoteUrl(plain, { kind: 'media' }).ok ? { blocked: true } : {}),
      }
    : null;
}

/**
 * Derive the NIP-17 wire kind for a group message from its stored text.
 *
 * Group sends split two ways (see `useGroupComposerActions`): a text/chat
 * message goes out as kind-14, while a voice/image file goes out as an
 * encrypted kind-15 (`createGroupFileRumor`) whose payload is folded into the
 * message text as an `#lpe=1` encrypted-file URL. So a stored group message
 * whose text parses as an *encrypted* file is kind-15; everything else
 * (including plain audio/image URLs pasted as chat text) is kind-14.
 *
 * The info sheet uses this instead of a hard-coded 14 so it reports the real
 * kind for kind-15 file bubbles.
 */
export function deriveGroupWireKind(text: string): 14 | 15 {
  const isEncryptedFile =
    parseVoiceNote(text)?.encrypted === true ||
    parseImageMessage(text)?.encrypted === true ||
    parseFileAttachment(text)?.encrypted === true;
  return isEncryptedFile ? 15 : 14;
}

export interface ParsedImageMessage {
  dim?: string;
  /** Fetch URL with the fragment stripped. */
  url: string;
  mime: string;
  encrypted: boolean;
  blocked?: boolean;
  size?: number;
  sha256?: string;
  keyHex?: string;
  nonceHex?: string;
  /** Set for a Marmot (MIP-04) photo — decrypted with these instead of AES-GCM. */
  marmot?: MarmotImageParams;
}

/** The MIP-04 fields a Marmot photo / voice note needs to decrypt (see encodeMarmotMediaUrl). */
export interface MarmotImageParams {
  version: MarmotMediaVersion;
  keysHex: string[];
  filename: string;
  plaintextSha256: string;
  ciphertextSha256: string;
}

/**
 * Detect an image message (#688): either an `#lpe=1` encrypted-file URL whose
 * mime is `image/*` (NIP-17 kind-15, fetch ciphertext + AES-256-GCM decrypt),
 * or a plain image URL (legacy / unencrypted / other clients — rendered
 * directly). Returns null for anything else. Mirrors `parseVoiceNote`; the
 * plain branch preserves today's `extractImageUrl` behaviour so DMs already in
 * threads keep rendering.
 */
export function parseImageMessage(text: string): ParsedImageMessage | null {
  if (!text) return null;
  const trimmed = text.trim();
  const hashIdx = trimmed.indexOf('#');
  if (hashIdx >= 0) {
    const params = new URLSearchParams(trimmed.slice(hashIdx + 1));
    // Require `lpe` to equal exactly '1' — a substring test would also fire
    // on unrelated fragments like `#lpe=10` and try to decrypt them.
    if (params.get('lpe') === '1') {
      const url = trimmed.slice(0, hashIdx);
      const blocked = !checkRemoteUrl(url, { kind: 'media' }).ok;
      const size = params.has('s') ? Number(params.get('s')) : undefined;
      const keyHex = params.get('k') ?? undefined;
      const nonceHex = params.get('n') ?? undefined;
      const mime = params.get('m') ?? 'application/octet-stream';
      const alg = params.get('alg') ?? 'aes-gcm';
      if (isMarmotMediaVersion(alg)) {
        const marmot = parseMarmotMedia(alg, mime, nonceHex, params, 'image/');
        return (
          marmot && {
            url,
            mime,
            encrypted: true,
            nonceHex,
            marmot,
            ...(blocked ? { blocked } : {}),
            dim: params.get('dim') ?? undefined,
            size,
          }
        );
      }
      // Otherwise we only implement AES-GCM (see encryptedFile.ts). A kind-15
      // file with a different `alg` falls back to plain rendering rather than
      // show an image card that fails to decrypt. `alg` is always emitted by
      // our encoder, so absence is tolerated.
      if (alg !== 'aes-gcm') return null;
      // Only images here — encrypted audio is handled by parseVoiceNote.
      if (!keyHex || !nonceHex || !mime.startsWith('image/')) return null;
      return {
        url,
        mime,
        encrypted: true,
        keyHex,
        nonceHex,
        ...(blocked ? { blocked } : {}),
        dim: params.get('dim') ?? undefined,
        size,
        ...(params.has('x') ? { sha256: params.get('x')! } : {}),
      };
    }
  }
  const plain = extractImageUrl(trimmed);
  return plain
    ? {
        url: plain,
        mime: 'image/jpeg',
        encrypted: false,
        ...(!checkRemoteUrl(plain, { kind: 'media' }).ok ? { blocked: true } : {}),
      }
    : null;
}

/** The MIP-04 fields of a `#lpe=1&alg=encrypted-media-v*` fragment, or null
 * if incomplete or `mime` isn't of the wanted family (`image/` / `audio/`). */
function parseMarmotMedia(
  version: MarmotMediaVersion,
  mime: string,
  nonceHex: string | undefined,
  params: URLSearchParams,
  mimePrefix: 'image/' | 'audio/',
): MarmotImageParams | null {
  const keysHex = (params.get('k') ?? '').split(',').filter(Boolean);
  const filename = params.get('f');
  const plaintextSha256 = params.get('ps');
  const ciphertextSha256 = params.get('cs');
  if (!mime.startsWith(mimePrefix) || keysHex.length === 0 || !nonceHex) return null;
  if (!filename || !plaintextSha256 || !ciphertextSha256) return null;
  return { version, keysHex, filename, plaintextSha256, ciphertextSha256 };
}

export function extractInvoice(text: string): DecodedInvoice | null {
  if (!text) return null;
  const match = text.match(INVOICE_REGEX);
  if (!match) return null;
  const raw = match[1];
  try {
    const decoded = bolt11Decode(raw);
    let amountSats: number | null = null;
    let description: string | null = null;
    let timestamp: number | null = null;
    // BOLT11's default when no explicit expiry tag is present.
    let expirySeconds = 3600;
    let paymentHash: string | null = null;
    for (const section of decoded.sections) {
      if (section.name === 'amount') {
        amountSats = Math.round(Number(section.value) / 1000);
      } else if (section.name === 'description') {
        description = section.value as string;
      } else if (section.name === 'timestamp') {
        timestamp = section.value as number;
      } else if (section.name === 'expiry') {
        expirySeconds = section.value as number;
      } else if (section.name === 'payment_hash') {
        paymentHash = section.value as string;
      }
    }
    const expiresAt = timestamp !== null ? timestamp + expirySeconds : null;
    return { raw, amountSats, description, expiresAt, paymentHash };
  } catch {
    return { raw, amountSats: null, description: null, expiresAt: null, paymentHash: null };
  }
}

export function extractLightningAddress(text: string): string | null {
  if (!text) return null;
  const match = text.match(LN_ADDRESS_REGEX);
  return match ? match[1] : null;
}

export function extractBitcoinUri(text: string): BitcoinUri | null {
  const parsed = parseBip21(text);
  if (!parsed) return null;
  // parseBip21 only matches the URI shape (`bitcoin:[8+ alnum chars]`).
  // Without an address-checksum check, garbage like `bitcoin:hello12345`
  // would render a Pay button + open SendSheet on an invalid
  // destination. Validate via bitcoinjs-lib's address parse so only
  // well-formed mainnet addresses produce the Pay affordance.
  if (!isBitcoinAddress(parsed.address)) return null;
  return parsed;
}

/**
 * A shared contact card — not an inline @mention (#1295). Every share format
 * (the composer's "Shared contact", ContactProfile's "Share with friend", the
 * OS share text) puts the profile URI on a line of its own, under a label. So:
 * a line that is only a `nostr:nprofile…` URI, or only a `nostr:npub…` URI
 * when the message has another line. A reference inside a sentence — or a
 * message that is just one `nostr:npub…` (a lone mention) — renders as an
 * `@Name` chip in the text instead.
 */
export function extractSharedContact(text: string): SharedContactRef | null {
  if (!text || !NOSTR_PROFILE_URI_REGEX.test(text)) return null;
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  for (const line of lines) {
    const match = line.match(NOSTR_PROFILE_URI_REGEX);
    if (!match || match[0].length !== line.length) continue;
    const isNprofile = /^nostr:nprofile1/i.test(line);
    if (!isNprofile && lines.length < 2) continue;
    return decodeProfileReference(match[0]);
  }
  return null;
}

export function formatTime(epochSeconds: number): string {
  // Message bubbles always show time only — the date context comes from
  // the TODAY / YESTERDAY / date dividers that appear between day groups.
  const d = new Date(epochSeconds * 1000);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  return `${hh}:${mm}`;
}

export function formatRelativeFuture(epochMs: number): string {
  const deltaSec = Math.max(0, Math.floor((epochMs - Date.now()) / 1000));
  if (deltaSec < 60) return 'in <1 min';
  if (deltaSec < 3600) return `in ${Math.floor(deltaSec / 60)} min`;
  if (deltaSec < 86400) return `in ${Math.floor(deltaSec / 3600)}h`;
  return `in ${Math.floor(deltaSec / 86400)}d`;
}

// Discriminated message-content variant that MessageBubble can render.
// The parent classifies a raw `{text, fromMe, createdAt}` once via
// `classifyMessage()` so the renderer doesn't re-parse on every frame.
// "image" / "invoice" / "lnaddr" / "contact" detect-on-fly inside the
// bubble (cheap regex / one bolt11Decode), so they're not pre-bound here
// — they ride on the `text` variant.
export type BubbleContent =
  | { kind: 'file'; file: FileAttachment }
  | { kind: 'text'; text: string }
  | { kind: 'gif'; url: string }
  | { kind: 'location'; location: SharedLocation }
  // `pollId` is the vote target / tally key. Set for a structured NIP-88 poll
  // (the poll rumor id, supplied by the item mapping); undefined for a legacy
  // text poll and for group polls, where the renderer falls back to the
  // message id (votes keyed by it in the text MVP).
  | { kind: 'poll'; poll: DisplayPoll; pollId?: string }
  // Vote messages render as nothing in the conversation list — they're
  // already aggregated into the referenced poll's tally. Marking the kind
  // explicitly (rather than dropping at the items level) lets the parent
  // keep upstream message bookkeeping simple while the bubble decides to
  // render `null`. Foreign clients still see them as plain text.
  | { kind: 'pollVote' }
  | { kind: 'liveLocationMarker'; marker: LiveLocationMarker }
  // Generic, future-proof fallback for an inner Nostr event whose kind the app
  // doesn't render (now or in future). `rawKind` is the numeric Nostr kind so
  // the bubble can say "Unsupported message type (kind N)" instead of leaving a
  // blank bubble. Produced by the normalizer (buildConversationItems) when a
  // stored message's wireKind isn't one we know how to display.
  | { kind: 'unsupported'; rawKind: number };

export function classifyMessageContent(text: string): BubbleContent {
  // Poll detection runs before generic url / geo parsing because the
  // [POLL] header is unambiguous and cheap to check, and we don't want
  // a poll body that happens to mention a GIF URL or `geo:` link to
  // re-route into a different bubble variant.
  const poll = parsePoll(text);
  // Legacy text-encoded poll (the #203 MVP, still read for back-compat): adapt
  // to the shared display shape so one PollBubble renders both wire formats.
  // Structured NIP-88 polls (kind 1068) are routed by wireKind upstream, never
  // through this text classifier. The correlation id (`pollId`) is supplied by
  // the caller — legacy polls key their tally by the message id.
  if (poll) {
    const stored = legacyPollToStored('', poll);
    return {
      kind: 'poll',
      poll: {
        question: stored.question,
        options: stored.options,
        pollType: stored.pollType,
        endsAt: stored.endsAt,
      },
    };
  }
  if (isPollVoteMessage(text)) return { kind: 'pollVote' };
  const gifUrl = extractGifUrl(text);
  if (gifUrl) return { kind: 'gif', url: gifUrl };
  // Live-location marker check MUST precede the plain `geo:` snapshot
  // check — start/end markers also embed a `geo:` URI so they would
  // otherwise classify as a snapshot and lose the live-share metadata.
  const marker = parseLiveLocationMarker(text);
  if (marker) return { kind: 'liveLocationMarker', marker };
  const loc = parseGeoMessage(text);
  if (loc) return { kind: 'location', location: loc };
  return { kind: 'text', text };
}

/** Files are wire-kind bound and must precede caption/filename URL detection. */
export function classifyStoredMessage(text: string, wireKind?: number): BubbleContent {
  const file =
    wireKind === 15
      ? parseFileAttachment(text)
      : wireKind === 4 || wireKind === 14 || wireKind === undefined
        ? parsePlainFileAttachment(text)
        : null;
  return file ? { kind: 'file', file } : classifyMessageContent(text);
}
