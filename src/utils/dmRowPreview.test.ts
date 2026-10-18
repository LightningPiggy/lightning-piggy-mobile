import { dmRowPreview } from './dmRowPreview';
import i18n from '../i18n';

describe('dmRowPreview — Marmot (#1140)', () => {
  const MLS = 'AAEAAwABQJggd1eNN8W4RwiOszLjR'; // serialized MLS Welcome (base64)

  it('labels a Marmot group invite instead of showing its raw payload', () => {
    const preview = dmRowPreview(MLS, 444);
    expect(preview).toBe('🔒 Marmot chat invite');
    expect(preview).not.toContain(MLS);
  });

  it('labels other Marmot wire kinds generically', () => {
    expect(dmRowPreview(MLS, 443)).toBe('🔒 Marmot message');
    expect(dmRowPreview(MLS, 445)).toBe('🔒 Marmot message');
  });

  it("uses the app's language for the label", () => {
    i18n.locale = 'es';
    try {
      expect(dmRowPreview(MLS, 444)).toBe('🔒 Invitación a chat de Marmot');
    } finally {
      i18n.locale = 'en';
    }
  });

  it('leaves ordinary chat text unchanged', () => {
    expect(dmRowPreview('Hello!', 14)).toBe('Hello!');
  });
});

describe('dmRowPreview — encrypted attachments', () => {
  const frag = (mime: string) =>
    `https://b.example/x.bin#lpe=1&alg=encrypted-media-v2&k=${'aa'.repeat(32)}&n=bb&m=${encodeURIComponent(mime)}`;

  it('calls a voice note a voice message and never leaks its key', () => {
    const preview = dmRowPreview(frag('audio/mp4'), 15);
    expect(preview).toBe('🎤 Voice message');
    expect(preview).not.toContain('aa'.repeat(8));
  });

  it('keeps the generic label for other encrypted files', () => {
    expect(dmRowPreview(frag('image/jpeg'), 15)).toBe('📎 Attachment');
  });
});

describe('dmRowPreview — stored file payloads', () => {
  const payload =
    '[FILE]' +
    JSON.stringify({
      url: 'https://blossom.example/invoice.pdf?token=secret-access-token',
      name: 'Invoice.pdf',
      mime: 'application/pdf',
      encrypted: false,
      caption: 'Private invoice',
    });

  it.each([payload, '[FILE]{"url":"https://example.com/?token=secret"'])(
    'redacts file metadata and URLs even when the payload is malformed',
    (content) => {
      expect(dmRowPreview(content, 15)).toBe('📎 File');
    },
  );

  it('localizes the file label', () => {
    i18n.locale = 'es';
    try {
      expect(dmRowPreview(payload, 15)).toBe('📎 Archivo');
    } finally {
      i18n.locale = 'en';
    }
  });
});

it('never previews raw unknown-kind JSON, phishing text or marker payloads', () => {
  for (const content of [
    '{"url":"https://phishing.example"}',
    'Urgent: send your keys',
    'geo:1,2',
  ]) {
    expect(dmRowPreview(content, 1234)).toBe('Unsupported message type (kind 1234)');
  }
  i18n.locale = 'es';
  try {
    expect(dmRowPreview('secret', 1234)).not.toContain('secret');
  } finally {
    i18n.locale = 'en';
  }
});

it.each([9, 1234, 99999])('redacts every stored kind outside the renderable set (%s)', (kind) => {
  expect(dmRowPreview('phishing text', kind)).toBe(`Unsupported message type (kind ${kind})`);
});

it.each([4, 14])('redacts plain document URLs and access tokens in kind %s previews', (kind) => {
  const preview = dmRowPreview('https://example.com/invoice.pdf?token=private', kind);
  expect(preview).not.toContain('private');
  expect(preview).not.toContain('https://');
  expect(preview).toContain('📎');
});
