import * as Sharing from 'expo-sharing';
import type { FileAttachment } from '../utils/fileAttachment';
import {
  captureDecryptedMediaSession,
  namedFileExport,
  retainDecryptedFile,
  resolveDecryptedMedia,
  verifiedFileMetadata,
} from './decryptedMediaCache';

/** Confirmation precedes fetching; the chooser never receives sender-declared MIME. */
export async function shareFileAttachment(
  file: FileAttachment,
  confirmSave: () => Promise<boolean>,
  onVerified: (metadata: { size: number; mime: string }) => void,
): Promise<void> {
  const session = captureDecryptedMediaSession();
  session.assertCurrent();
  if (!file.available) throw new Error('File unavailable');
  if (file.dangerous && !(await confirmSave())) return;
  session.assertCurrent();
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing unavailable');
  session.assertCurrent();
  const uri = await resolveDecryptedMedia(
    {
      ...file,
      size: file.plainUrl ? undefined : file.size,
      kind: 'file',
    },
    session.owner,
  );
  session.assertCurrent();
  const release = retainDecryptedFile(uri);
  try {
    const metadata = verifiedFileMetadata(uri);
    if (metadata) onVerified(metadata);
    session.assertCurrent();
    const generic = file.dangerous || (file.plainUrl && metadata?.mime !== file.mime);
    const exportUri = await namedFileExport(uri, generic ? 'attachment.bin' : file.name);
    session.assertCurrent();
    await Sharing.shareAsync(exportUri, {
      mimeType: generic
        ? 'application/octet-stream'
        : (metadata?.mime ?? 'application/octet-stream'),
      dialogTitle: file.name,
    });
  } finally {
    release();
  }
}
