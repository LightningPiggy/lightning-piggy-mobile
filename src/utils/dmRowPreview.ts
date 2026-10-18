import { parsePlainFileAttachment } from './fileAttachment';
import { orderPreviewFromContent } from './orderEvents';
import { pollPreviewFromContent } from './nip88Poll';
import { NWC_SHARE_KIND, nwcSharePreviewFromContent } from './nwcShareMessage';
import { isMarmotKind, MARMOT_WELCOME_KIND } from './dmProtocol';
import { t } from '../i18n';
import { liveMarkerPhaseOf } from '../services/liveLocationService';

/**
 * Secret-free inbox / notification preview for a stored DM row, dispatched by
 * `wireKind`. Structured rows carry non-human `content` (order JSON, poll JSON,
 * an NWC connection string) that must never surface raw in a conversation-list
 * preview or a push-notification body:
 *
 *  - NWC wallet share (kind {@link NWC_SHARE_KIND}) → a label that never
 *    includes the bearer connection string.
 *  - Encrypted file message (kind 15) whose content carries the `#lpe=1…`
 *    fragment → a neutral "attachment" label. An AES-GCM voice note / photo is
 *    stored as that URL, whose fragment embeds the decryption key + nonce (see
 *    `encodeEncryptedFileUrl` / `textForRumor`); it must never surface in a
 *    conversation-list preview or a lock-screen notification, so it's redacted
 *    to a label here. Plain kind-15 rows (bare blob URL, no secret) pass through.
 *  - Stored `[FILE]` payload (kind 15) → a localized file label, never JSON
 *    metadata or URLs that may carry access tokens, even if malformed.
 *  - Structured NIP-88 poll / vote (kind 1068/1018) → the poll summary.
 *  - Marketplace order / receipt (kind 16/17) → the order summary.
 *  - Marmot group invite / message (kind 443–445) → a "not supported yet"
 *    label, never the serialized MLS payload (#1140).
 *  - Unknown kinds → a localized unsupported label with the kind number.
 *  - Plain chat text → the content unchanged.
 *
 * Shared by every store → preview projection (inbox refresh, live sub,
 * wrap ingest, background notification) so they redact identically.
 */
export function dmRowPreview(content: string, wireKind: number, locale?: string): string {
  if (
    ![4, 14, 15, 16, 17, 1068, 1018, NWC_SHARE_KIND].includes(wireKind) &&
    !isMarmotKind(wireKind)
  )
    return t('messageBubble.unsupportedText', { kind: wireKind });
  if (wireKind === NWC_SHARE_KIND) return nwcSharePreviewFromContent(content);
  if ([4, 14].includes(wireKind) && parsePlainFileAttachment(content))
    return `📎 ${t('messageBubble.file')}`;
  if (wireKind === 15 && content.startsWith('[FILE]')) return `📎 ${t('messageBubble.file')}`;
  // `#lpe=1` is the encrypted-file fragment marker (see encryptedFileUrl.ts);
  // its `&k=…&n=…` params are the decryption secret, so never let it through.
  if (wireKind === 15 && content.includes('#lpe=1')) {
    // The mime rides in the fragment (`m=audio%2Fmp4`); name voice notes as such.
    const mime = new URLSearchParams(content.slice(content.indexOf('#') + 1)).get('m') ?? '';
    return mime.startsWith('audio/')
      ? `🎤 ${t('messageBubble.voiceMessagePreview')}`
      : '📎 Attachment';
  }
  // Live-location markers: the stored text carries session metadata (and a
  // NIP-17 share's update secret) — show a label, never the raw marker. The
  // raw marker travels in the entry's `renderText` (dmInbox / dmWrapIngest).
  const livePhase = liveMarkerPhaseOf(content);
  if (livePhase) {
    return `\u{1F4CD} ${t(livePhase === 'start' ? 'messageBubble.liveLocation' : 'messageBubble.liveLocationEnded')}`;
  }
  if (isMarmotKind(wireKind))
    return `🔒 ${t(wireKind === MARMOT_WELCOME_KIND ? 'messageBubble.marmotInvitePreview' : 'messageBubble.marmotMessagePreview')}`;
  return (
    pollPreviewFromContent(content, wireKind) ?? orderPreviewFromContent(content, wireKind, locale)
  );
}
