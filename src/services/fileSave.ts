import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform } from 'react-native';
import * as FS from 'expo-file-system/legacy';
import { sanitizeAttachmentText, type FileAttachment } from '../utils/fileAttachment';
import {
  captureDecryptedMediaSession,
  retainDecryptedFile,
  resolveDecryptedMedia,
  verifiedFileMetadata,
} from './decryptedMediaCache';
import { shareFileAttachment } from './fileShare';

export function sanitizeSaveFilename(name: string): string {
  return (
    sanitizeAttachmentText(name)
      .replace(/[<>:"|?*]/g, '_')
      .replace(/^[. ]+|[. ]+$/g, '')
      .slice(0, 180) || 'attachment.bin'
  );
}

export function savedFolderName(uri: string): string {
  const path = decodeURIComponent(uri).split('/').pop() ?? '';
  return path.split(':').pop() || path;
}

/** Export only to an explicit user destination; all intermediate bytes stay in the account cache. */
export async function saveFileAttachment(
  file: FileAttachment,
  confirmSave: () => Promise<boolean>,
  onVerified: (metadata: { size: number; mime: string }) => void,
  onSaved: (folder: string) => void,
): Promise<void> {
  if (Platform.OS !== 'android') return shareFileAttachment(file, confirmSave, onVerified);
  const session = captureDecryptedMediaSession();
  session.assertCurrent();
  if (!file.available) throw new Error('File unavailable');
  if (file.dangerous && !(await confirmSave())) return;
  session.assertCurrent();
  const uri = await resolveDecryptedMedia(
    { ...file, size: file.plainUrl ? undefined : file.size, kind: 'file' },
    session.owner,
  );
  session.assertCurrent();
  const release = retainDecryptedFile(uri);
  let destination: string | undefined;
  try {
    const metadata = verifiedFileMetadata(uri);
    if (metadata) onVerified(metadata);
    session.assertCurrent();
    const generic = file.dangerous || (file.plainUrl && metadata?.mime !== file.mime);
    const name = sanitizeSaveFilename(generic ? 'attachment.bin' : file.name);
    const mime = generic
      ? 'application/octet-stream'
      : (metadata?.mime ?? 'application/octet-stream');
    const bytes = await FS.readAsStringAsync(uri, { encoding: FS.EncodingType.Base64 });
    session.assertCurrent();
    const write = async (directory: string) => {
      session.assertCurrent();
      destination = await FS.StorageAccessFramework.createFileAsync(directory, name, mime);
      session.assertCurrent();
      await FS.writeAsStringAsync(destination, bytes, { encoding: FS.EncodingType.Base64 });
      session.assertCurrent();
    };
    const key = `file-save-directory:${session.owner}`;
    let directory = await AsyncStorage.getItem(key);
    session.assertCurrent();
    if (directory) {
      try {
        await write(directory);
      } catch {
        if (destination) {
          await FS.deleteAsync(destination, { idempotent: true }).catch(() => {});
          destination = undefined;
        }
        session.assertCurrent();
        await AsyncStorage.removeItem(key);
        directory = null;
      }
      session.assertCurrent();
    }
    if (!directory) {
      session.assertCurrent();
      const permission = await FS.StorageAccessFramework.requestDirectoryPermissionsAsync();
      session.assertCurrent();
      if (!permission.granted) return;
      directory = permission.directoryUri;
      await AsyncStorage.setItem(key, directory);
      session.assertCurrent();
      await write(directory);
    }
    onSaved(savedFolderName(directory));
    destination = undefined;
  } finally {
    // Remove incomplete exports, including a write that completed after an account switch.
    if (destination) await FS.deleteAsync(destination, { idempotent: true }).catch(() => {});
    release();
  }
}
