import { deleteAsync } from 'expo-file-system/legacy';
import {
  __resetDecryptedMediaCacheForTests,
  FILE_SHARE_RETENTION_MS,
  ownerDirName,
  publishDecryptedPreview,
  retainDecryptedFile,
  setDecryptedMediaOwner,
} from './decryptedMediaCache';

jest.mock('expo-file-system/legacy', () => ({
  cacheDirectory: 'file:///cache/',
  deleteAsync: jest.fn(async () => {}),
  getInfoAsync: jest.fn(async () => ({ exists: false })),
}));

const OWNER = 'a'.repeat(64);
const fileUri = (name: string) => `file:///cache/decrypted/${ownerDirName(OWNER)}/file-${name}.pdf`;

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  __resetDecryptedMediaCacheForTests();
  setDecryptedMediaOwner(OWNER);
});

afterEach(() => {
  __resetDecryptedMediaCacheForTests();
  jest.useRealTimers();
});

it('previews more than 16 distinct PDFs and leaves all share slots available', async () => {
  for (let i = 0; i < 20; i++) {
    const uri = fileUri(`preview-${i}`);
    await expect(publishDecryptedPreview(uri, async () => `${uri}.preview-480.png`)).resolves.toBe(
      `${uri}.preview-480.png`,
    );
  }
  for (let i = 0; i < 16; i++) retainDecryptedFile(fileUri(`share-${i}`))();
  expect(() => retainDecryptedFile(fileUri('extra'))).toThrow('Too many retained file shares');
  // A full share pool must still allow an unrelated PDF preview.
  await expect(publishDecryptedPreview(fileUri('another'), async () => null)).resolves.toBeNull();
  await jest.advanceTimersByTimeAsync(FILE_SHARE_RETENTION_MS);
  expect(deleteAsync).not.toHaveBeenCalledWith(
    expect.stringContaining('file-preview-'),
    expect.anything(),
  );
});

it('releases failed preview leases without using share slots or scheduling file deletion', async () => {
  for (let i = 0; i < 20; i++) {
    await expect(
      publishDecryptedPreview(fileUri(`failed-${i}`), async () => {
        throw new Error('render failed');
      }),
    ).rejects.toThrow('render failed');
  }
  for (let i = 0; i < 16; i++) retainDecryptedFile(fileUri(`share-${i}`))();
  await jest.advanceTimersByTimeAsync(FILE_SHARE_RETENTION_MS);
  expect(deleteAsync).not.toHaveBeenCalledWith(
    expect.stringContaining('file-failed-'),
    expect.anything(),
  );
});

it.each(['preview', 'share'] as const)(
  'preserves share retention when the %s lease is acquired first',
  async (first) => {
    const uri = fileUri('overlap');
    let finish!: () => void;
    let started!: () => void;
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const render = () =>
      publishDecryptedPreview(uri, () => {
        started();
        return new Promise<string>((resolve) => {
          finish = () => resolve(`${uri}.preview-480.png`);
        });
      });
    let release: () => void;
    let preview: Promise<string | null>;
    if (first === 'share') {
      release = retainDecryptedFile(uri);
      release();
      preview = render();
    } else {
      preview = render();
      await ready;
      release = retainDecryptedFile(uri);
      release();
    }
    await ready;
    await jest.advanceTimersByTimeAsync(FILE_SHARE_RETENTION_MS);
    expect(deleteAsync).not.toHaveBeenCalledWith(uri, expect.anything());
    finish();
    await preview;
    await jest.advanceTimersByTimeAsync(FILE_SHARE_RETENTION_MS - 1);
    expect(deleteAsync).not.toHaveBeenCalledWith(uri, expect.anything());
    await jest.advanceTimersByTimeAsync(1);
    expect(deleteAsync).toHaveBeenCalledWith(uri, { idempotent: true });
    expect(deleteAsync).toHaveBeenCalledWith(`${uri}.preview-480.png`, { idempotent: true });
  },
);
