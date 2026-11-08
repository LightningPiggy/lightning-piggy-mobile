const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * `messageBubble.attachmentUnavailable` / `messageBubble.unsupportedAttachment`
 * in every catalogue. Copied here rather than read from the catalogues
 * because only the active locale's catalogue is loaded at runtime (see
 * src/i18n/index.ts), while a stored row may be in any language.
 * attachmentPlaceholder.test.ts fails if a catalogue label is missing here.
 * Append; never remove: rows stored under an older wording must still match.
 */
export const ATTACHMENT_PLACEHOLDER_TEMPLATES: readonly string[] = [
  "Couldn't open attachment: {{name}}",
  'Unsupported attachment: {{name}} ({{type}})',
  'Anhang konnte nicht geöffnet werden: {{name}}',
  'Nicht unterstützter Anhang: {{name}} ({{type}})',
  'No se pudo abrir el adjunto: {{name}}',
  'Adjunto no compatible: {{name}} ({{type}})',
  'A mellékletet nem sikerült megnyitni: {{name}}',
  'Nem támogatott melléklet: {{name}} ({{type}})',
  'Nie udało się otworzyć załącznika: {{name}}',
  'Nieobsługiwany załącznik: {{name}} ({{type}})',
  'Не вдалося відкрити вкладення: {{name}}',
  'Непідтримуване вкладення: {{name}} ({{type}})',
  'अटैचमेंट नहीं खुल सका: {{name}}',
  'इस अटैचमेंट का सपोर्ट नहीं है: {{name}} ({{type}})',
  'अटॅचमेंट उघडता आली नाही: {{name}}',
  'असमर्थित अटॅचमेंट: {{name}} ({{type}})',
  '无法打开附件：{{name}}',
  '不支持的附件：{{name}}（{{type}}）',
];

// The attachment fallback labels Marmot rows are stored with when the media
// can't be shown (`attachmentFallbackText`), in every locale — the text is
// translated when the message arrives, so a stored row may be in any of them.
const PLACEHOLDER_PATTERNS: RegExp[] = ATTACHMENT_PLACEHOLDER_TEMPLATES.map(
  (template) =>
    new RegExp(`^${escape(template).replace(/\\\{\\\{(?:name|type)\\\}\\\}/g, '.*')}$`, 's'),
);

/**
 * True for a stored message text that is only a stand-in for an attachment:
 * empty (Marmot voice notes received before #1225 were stored blank) or an
 * attachment fallback label. A history replay may repair such a row (#1241).
 */
export function isAttachmentPlaceholderText(text: string): boolean {
  return text === '' || PLACEHOLDER_PATTERNS.some((re) => re.test(text));
}
