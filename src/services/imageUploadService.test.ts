import { deleteAsync } from 'expo-file-system/legacy';
import { discardScrubbedCopy } from './imageUploadService';

jest.mock('expo-file-system/legacy', () => ({
  deleteAsync: jest.fn(() => Promise.resolve()),
  readAsStringAsync: jest.fn(),
}));
jest.mock('expo-image-manipulator', () => ({ manipulateAsync: jest.fn(), SaveFormat: {} }));
jest.mock('./walletStorageService', () => ({ getBlossomServers: jest.fn() }));
jest.mock('./blossomService', () => ({
  uploadEncryptedBlobToBlossom: jest.fn(),
  uploadToBlossomServers: jest.fn(),
}));
jest.mock('./encryptedFile', () => ({ encryptFile: jest.fn() }));

const mockDelete = deleteAsync as jest.Mock;

beforeEach(() => mockDelete.mockClear());

describe('discardScrubbedCopy', () => {
  it('deletes the re-encoded copy', async () => {
    await discardScrubbedCopy(
      'file:///cache/lp-share/share-1.jpg',
      'file:///cache/ImageManipulator/2.jpg',
    );
    expect(mockDelete).toHaveBeenCalledWith('file:///cache/ImageManipulator/2.jpg', {
      idempotent: true,
    });
  });

  it('never deletes the original (a GIF passes through as itself)', async () => {
    await discardScrubbedCopy('file:///cache/a.gif', 'file:///cache/a.gif');
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('swallows a failed delete', async () => {
    mockDelete.mockRejectedValueOnce(new Error('gone'));
    await expect(discardScrubbedCopy('file:///a.jpg', 'file:///b.jpg')).resolves.toBeUndefined();
  });
});
