import { shareFileAttachment } from './fileShare';
import { parseFileAttachment } from '../utils/fileAttachment';
import * as Sharing from 'expo-sharing';
import {
  captureDecryptedMediaSession,
  namedFileExport,
  retainDecryptedFile,
  resolveDecryptedMedia,
  verifiedFileMetadata,
} from './decryptedMediaCache';
jest.mock('expo-sharing', () => ({
  isAvailableAsync: jest.fn(async () => true),
  shareAsync: jest.fn(async () => {}),
}));
const mockRelease = jest.fn();
jest.mock('./decryptedMediaCache', () => ({
  captureDecryptedMediaSession: jest.fn((owner = 'alice') => ({ owner, assertCurrent: jest.fn() })),
  namedFileExport: jest.fn(
    async (_uri: string, name: string) => `file:///safe.bin.share/${encodeURIComponent(name)}`,
  ),
  resolveDecryptedMedia: jest.fn(async () => 'file:///safe.bin'),
  retainDecryptedFile: jest.fn(() => mockRelease),
  verifiedFileMetadata: jest.fn(() => ({ mime: 'application/pdf', size: 9 })),
}));
const file = (name: string, mime: string) =>
  parseFileAttachment(
    '[FILE]' +
      JSON.stringify({
        name,
        mime,
        url: 'https://example.com/file',
        encrypted: false,
        plaintextSha256: 'aa'.repeat(32),
      }),
  )!;
beforeEach(() => jest.clearAllMocks());
it('requires warning approval before downloading dangerous files and shares generic bytes', async () => {
  const confirm = jest.fn(async () => true);
  await shareFileAttachment(file('invoice.pdf.apk', 'application/pdf'), confirm, jest.fn());
  expect(confirm).toHaveBeenCalled();
  expect(namedFileExport).toHaveBeenCalledWith('file:///safe.bin', 'attachment.bin');
  expect(confirm.mock.invocationCallOrder[0]).toBeLessThan(
    (resolveDecryptedMedia as jest.Mock).mock.invocationCallOrder[0],
  );
  expect(Sharing.shareAsync).toHaveBeenCalledWith(
    'file:///safe.bin.share/attachment.bin',
    expect.objectContaining({ mimeType: 'application/octet-stream' }),
  );
  expect(retainDecryptedFile).toHaveBeenCalledWith('file:///safe.bin');
  expect(mockRelease).toHaveBeenCalled();
});
it('canceling the warning fetches and shares nothing', async () => {
  await shareFileAttachment(file('x.txt', 'text/html'), async () => false, jest.fn());
  expect(resolveDecryptedMedia).not.toHaveBeenCalled();
  expect(Sharing.shareAsync).not.toHaveBeenCalled();
});
it('uses verified MIME and actual size, not sender metadata', async () => {
  const verified = jest.fn();
  await shareFileAttachment(file('invoice.pdf', 'application/attacker'), jest.fn(), verified);
  expect(verified).toHaveBeenCalledWith({ mime: 'application/pdf', size: 9 });
  expect(Sharing.shareAsync).toHaveBeenCalledWith(
    'file:///safe.bin.share/invoice.pdf',
    expect.objectContaining({ mimeType: 'application/pdf' }),
  );
});
it('schedules cleanup even when the chooser fails', async () => {
  (Sharing.shareAsync as jest.Mock).mockRejectedValueOnce(new Error('chooser'));
  await expect(
    shareFileAttachment(file('x.pdf', 'application/pdf'), jest.fn(), jest.fn()),
  ).rejects.toThrow('chooser');
  expect(retainDecryptedFile).toHaveBeenCalledWith('file:///safe.bin');
  expect(mockRelease).toHaveBeenCalled();
});
it('falls back to generic bytes when no verified type exists', async () => {
  (verifiedFileMetadata as jest.Mock).mockReturnValueOnce(undefined);
  await shareFileAttachment(file('x.pdf', 'application/pdf'), jest.fn(), jest.fn());
  expect(Sharing.shareAsync).toHaveBeenCalledWith(
    'file:///safe.bin.share/x.pdf',
    expect.objectContaining({ mimeType: 'application/octet-stream' }),
  );
});

it('holds the file lease while the chooser is open', async () => {
  let settle!: () => void;
  (Sharing.shareAsync as jest.Mock).mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        settle = resolve;
      }),
  );
  const share = shareFileAttachment(file('a.pdf', 'application/pdf'), jest.fn(), jest.fn());
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(retainDecryptedFile).toHaveBeenCalledWith('file:///safe.bin');
  expect(mockRelease).not.toHaveBeenCalled();
  settle();
  await share;
  expect(mockRelease).toHaveBeenCalledTimes(1);
});
it('rejects unavailable hashless files before downloading or opening the chooser', async () => {
  await expect(
    shareFileAttachment(
      { ...file('a.pdf', 'application/pdf'), available: false, plaintextSha256: undefined },
      jest.fn(),
      jest.fn(),
    ),
  ).rejects.toThrow('File unavailable');
  expect(resolveDecryptedMedia).not.toHaveBeenCalled();
  expect(Sharing.shareAsync).not.toHaveBeenCalled();
});

it.each(['invoice.pdf', 'report.csv', 'budget.xlsx'])(
  'passes the sanitized recipient filename %s in the URI',
  async (name) => {
    await shareFileAttachment(file(`../${name}`, 'application/octet-stream'), jest.fn(), jest.fn());
    expect(namedFileExport).toHaveBeenCalledWith('file:///safe.bin', name);
    expect(Sharing.shareAsync).toHaveBeenCalledWith(
      `file:///safe.bin.share/${name}`,
      expect.any(Object),
    );
  },
);

it('keeps plain-URL downloads independent of advertised size', async () => {
  const { parsePlainFileAttachment } = jest.requireActual('../utils/fileAttachment');
  await shareFileAttachment(
    parsePlainFileAttachment('https://example.com/invoice.pdf')!,
    jest.fn(),
    jest.fn(),
  );
  expect(resolveDecryptedMedia).toHaveBeenCalledWith(
    expect.objectContaining({ size: undefined, plainUrl: true, kind: 'file' }),
    'alice',
  );
  expect(Sharing.shareAsync).toHaveBeenCalledWith(
    'file:///safe.bin.share/invoice.pdf',
    expect.objectContaining({ mimeType: 'application/pdf' }),
  );
});

it('exports mismatched plain-URL content as generic bytes and reports the verified type', async () => {
  const { parsePlainFileAttachment } = jest.requireActual('../utils/fileAttachment');
  jest
    .mocked(verifiedFileMetadata)
    .mockReturnValueOnce({ mime: 'application/octet-stream', size: 9 });
  const verified = jest.fn();
  await shareFileAttachment(
    parsePlainFileAttachment('https://example.com/invoice.pdf')!,
    jest.fn(),
    verified,
  );
  expect(verified).toHaveBeenCalledWith({ mime: 'application/octet-stream', size: 9 });
  expect(namedFileExport).toHaveBeenCalledWith('file:///safe.bin', 'attachment.bin');
  expect(Sharing.shareAsync).toHaveBeenCalledWith(
    'file:///safe.bin.share/attachment.bin',
    expect.objectContaining({ mimeType: 'application/octet-stream' }),
  );
});

it.each(['confirmation', 'availability', 'download', 'export'])(
  'cancels sharing when the session changes during %s',
  async (stage) => {
    let current = true;
    jest.mocked(captureDecryptedMediaSession).mockReturnValueOnce({
      owner: 'alice',
      assertCurrent: () => {
        if (!current) throw new Error('session cancelled');
      },
    });
    const changed = async () => {
      current = false;
      return true;
    };
    if (stage === 'availability')
      jest.mocked(Sharing.isAvailableAsync).mockImplementationOnce(changed);
    if (stage === 'download')
      jest.mocked(resolveDecryptedMedia).mockImplementationOnce(async () => {
        current = false;
        return 'file:///safe.bin';
      });
    if (stage === 'export')
      jest.mocked(namedFileExport).mockImplementationOnce(async () => {
        current = false;
        return 'file:///safe.bin.share/a.pdf';
      });
    await expect(
      shareFileAttachment(
        file('a.pdf', stage === 'confirmation' ? 'text/html' : 'application/pdf'),
        changed,
        jest.fn(),
      ),
    ).rejects.toThrow('session cancelled');
    expect(Sharing.shareAsync).not.toHaveBeenCalled();
    if (['confirmation', 'availability'].includes(stage))
      expect(resolveDecryptedMedia).not.toHaveBeenCalled();
    else expect(resolveDecryptedMedia).toHaveBeenCalledWith(expect.any(Object), 'alice');
  },
);
