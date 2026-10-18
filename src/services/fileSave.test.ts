import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as FS from 'expo-file-system/legacy';
import { saveFileAttachment, sanitizeSaveFilename } from './fileSave';
import { shareFileAttachment } from './fileShare';
import {
  captureDecryptedMediaSession,
  resolveDecryptedMedia,
  retainDecryptedFile,
  verifiedFileMetadata,
} from './decryptedMediaCache';
import type { FileAttachment } from '../utils/fileAttachment';

jest.mock('@react-native-async-storage/async-storage', () => ({
  getItem: jest.fn(),
  setItem: jest.fn(),
  removeItem: jest.fn(),
}));
jest.mock('expo-file-system/legacy', () => ({
  EncodingType: { Base64: 'base64' },
  readAsStringAsync: jest.fn(),
  writeAsStringAsync: jest.fn(),
  deleteAsync: jest.fn(),
  StorageAccessFramework: {
    requestDirectoryPermissionsAsync: jest.fn(),
    createFileAsync: jest.fn(),
  },
}));
jest.mock('./fileShare', () => ({ shareFileAttachment: jest.fn() }));
const mockRelease = jest.fn();
jest.mock('./decryptedMediaCache', () => ({
  captureDecryptedMediaSession: jest.fn(),
  resolveDecryptedMedia: jest.fn(),
  retainDecryptedFile: jest.fn(() => mockRelease),
  verifiedFileMetadata: jest.fn(() => ({ mime: 'application/pdf', size: 9 })),
}));
const file = { available: true, name: '../invoice.pdf', mime: 'application/pdf' } as FileAttachment;
const saf = FS.StorageAccessFramework;
let current = true;
const saved = jest.fn();
const save = () => saveFileAttachment(file, async () => true, jest.fn(), saved);
beforeEach(() => {
  jest.resetAllMocks();
  // resetAllMocks clears implementations as well as calls.
  jest.mocked(retainDecryptedFile).mockReturnValue(mockRelease);
  jest.mocked(verifiedFileMetadata).mockReturnValue({ mime: 'application/pdf', size: 9 });
  Object.defineProperty(Platform, 'OS', { value: 'android', configurable: true });
  current = true;
  jest.mocked(captureDecryptedMediaSession).mockReturnValue({
    owner: 'alice',
    assertCurrent: () => {
      if (!current) throw new Error('session cancelled');
    },
  });
  jest.mocked(resolveDecryptedMedia).mockResolvedValue('file:///account-cache/a.pdf');
  jest.mocked(AsyncStorage.getItem).mockResolvedValue(null);
  jest
    .mocked(saf.requestDirectoryPermissionsAsync)
    .mockResolvedValue({ granted: true, directoryUri: 'content://tree/primary%3ADownload' });
  jest.mocked(saf.createFileAsync).mockResolvedValue('content://saved');
  jest.mocked(FS.readAsStringAsync).mockResolvedValue('cGRm');
  jest.mocked(FS.deleteAsync).mockResolvedValue();
});
it('remembers a chosen directory per account and writes verified base64 bytes', async () => {
  await save();
  expect(resolveDecryptedMedia).toHaveBeenCalledWith(
    expect.objectContaining({ kind: 'file' }),
    'alice',
  );
  expect(AsyncStorage.setItem).toHaveBeenCalledWith(
    'file-save-directory:alice',
    'content://tree/primary%3ADownload',
  );
  expect(saf.createFileAsync).toHaveBeenCalledWith(
    'content://tree/primary%3ADownload',
    'invoice.pdf',
    'application/pdf',
  );
  expect(FS.writeAsStringAsync).toHaveBeenCalledWith('content://saved', 'cGRm', {
    encoding: 'base64',
  });
  expect(saved).toHaveBeenCalledWith('Download');
  expect(mockRelease).toHaveBeenCalled();
});
it('reuses the account permission without prompting', async () => {
  jest.mocked(AsyncStorage.getItem).mockResolvedValue('content://remembered');
  await save();
  expect(saf.requestDirectoryPermissionsAsync).not.toHaveBeenCalled();
  expect(saf.createFileAsync).toHaveBeenCalledWith(
    'content://remembered',
    'invoice.pdf',
    'application/pdf',
  );
});
it.each(['create', 'write'])(
  'asks again if the remembered permission fails during %s',
  async (stage) => {
    jest.mocked(AsyncStorage.getItem).mockResolvedValue('content://expired');
    if (stage === 'create')
      jest.mocked(saf.createFileAsync).mockRejectedValueOnce(new Error('permission'));
    else jest.mocked(FS.writeAsStringAsync).mockRejectedValueOnce(new Error('permission'));
    await save();
    expect(AsyncStorage.removeItem).toHaveBeenCalledWith('file-save-directory:alice');
    expect(saf.requestDirectoryPermissionsAsync).toHaveBeenCalledTimes(1);
    expect(saved).toHaveBeenCalledWith('Download');
  },
);
it('does not export when the picker is cancelled', async () => {
  jest.mocked(saf.requestDirectoryPermissionsAsync).mockResolvedValue({ granted: false });
  await save();
  expect(saf.createFileAsync).not.toHaveBeenCalled();
  expect(saved).not.toHaveBeenCalled();
});
it.each(['download', 'read', 'storage', 'picker', 'remember', 'create', 'write'])(
  'aborts if the owner session changes during %s',
  async (stage) => {
    const change = async <T>(value: T) => {
      current = false;
      return value;
    };
    if (stage === 'download')
      jest
        .mocked(resolveDecryptedMedia)
        .mockImplementationOnce(() => change('file:///account-cache/a.pdf'));
    if (stage === 'read')
      jest.mocked(FS.readAsStringAsync).mockImplementationOnce(() => change('cGRm'));
    if (stage === 'storage')
      jest.mocked(AsyncStorage.getItem).mockImplementationOnce(() => change(null));
    if (stage === 'picker')
      jest
        .mocked(saf.requestDirectoryPermissionsAsync)
        .mockImplementationOnce(() => change({ granted: true, directoryUri: 'content://chosen' }));
    if (stage === 'remember')
      jest.mocked(AsyncStorage.setItem).mockImplementationOnce(() => change(undefined));
    if (stage === 'create')
      jest.mocked(saf.createFileAsync).mockImplementationOnce(() => change('content://saved'));
    if (stage === 'write')
      jest.mocked(FS.writeAsStringAsync).mockImplementationOnce(() => change(undefined));
    await expect(save()).rejects.toThrow('session cancelled');
    expect(saved).not.toHaveBeenCalled();
    if (stage !== 'write') expect(FS.writeAsStringAsync).not.toHaveBeenCalled();
    if (['create', 'write'].includes(stage))
      expect(FS.deleteAsync).toHaveBeenCalledWith('content://saved', { idempotent: true });
  },
);
it('uses the existing share sheet for iOS Save', async () => {
  Object.defineProperty(Platform, 'OS', { value: 'ios', configurable: true });
  await save();
  expect(shareFileAttachment).toHaveBeenCalled();
  expect(saf.requestDirectoryPermissionsAsync).not.toHaveBeenCalled();
});
it.each([
  ['../invoice.pdf', 'invoice.pdf'],
  ['..\\invoice.pdf', 'invoice.pdf'],
  ['\u202Eevil\u0000?.pdf', 'evil _.pdf'],
  ['... ', 'attachment.bin'],
  ['<a>:b|c*', '_a__b_c_'],
])('sanitises %s', (name, expected) => expect(sanitizeSaveFilename(name)).toBe(expected));
