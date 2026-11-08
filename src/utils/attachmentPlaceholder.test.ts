import { loadAllCatalogues } from '../i18n';
import {
  ATTACHMENT_PLACEHOLDER_TEMPLATES,
  isAttachmentPlaceholderText,
} from './attachmentPlaceholder';

const catalogues = Object.values(loadAllCatalogues());

describe('isAttachmentPlaceholderText', () => {
  it('carries exactly the fallback labels of every catalogue', () => {
    const fromCatalogues = catalogues.flatMap((cat) => [
      cat.messageBubble.attachmentUnavailable,
      cat.messageBubble.unsupportedAttachment,
    ]);
    // If this fails, a catalogue's label changed: copy it into
    // ATTACHMENT_PLACEHOLDER_TEMPLATES (attachmentPlaceholder.ts).
    expect([...ATTACHMENT_PLACEHOLDER_TEMPLATES].sort()).toEqual(
      [...new Set(fromCatalogues)].sort(),
    );
  });

  it('matches blank text and the fallback labels in every locale', () => {
    expect(isAttachmentPlaceholderText('')).toBe(true);
    for (const cat of catalogues) {
      const unavailable = cat.messageBubble.attachmentUnavailable.replace('{{name}}', 'a b.m4a');
      const unsupported = cat.messageBubble.unsupportedAttachment
        .replace('{{name}}', 'clip.mov')
        .replace('{{type}}', 'video/quicktime');
      expect(isAttachmentPlaceholderText(unavailable)).toBe(true);
      expect(isAttachmentPlaceholderText(unsupported)).toBe(true);
    }
  });

  it('does not match ordinary messages', () => {
    expect(isAttachmentPlaceholderText('hello')).toBe(false);
    expect(isAttachmentPlaceholderText("I couldn't open attachment: x — can you resend?")).toBe(
      false,
    );
  });
});
