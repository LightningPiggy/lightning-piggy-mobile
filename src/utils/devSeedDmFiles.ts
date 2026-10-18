/** Local-only DM file fixtures. No relay traffic and no identity changes. */
import { utf8ToBytes } from '@noble/hashes/utils.js';
import { encryptFile } from '../services/encryptedFile';
import { upsertDmMessages } from '../services/dmDb';
import { createFileMessageRumor } from '../services/nostrFileMessage';
import { textForRumor } from './nip17Unwrap';
import { isHiddenInProdPubkey } from './testAccounts';
import { DEV_FILE_PEER } from './devSeedMarmotFiles';

export async function seedDevDmFiles(owner: string) {
  if (!__DEV__ || !isHiddenInProdPubkey(owner)) return null;
  const now = Math.floor(Date.now() / 1000);
  const sealed = encryptFile(utf8ToBytes('%PDF-1.4\n%%EOF'));
  const rumor = createFileMessageRumor({
    senderPubkey: DEV_FILE_PEER,
    recipientPubkey: owner,
    url: 'https://blossom.example/dev-dm.pdf',
    mime: 'application/pdf',
    ...sealed,
    size: sealed.ciphertext.length,
    filename: 'invoice-nip17.pdf',
  });
  const base = { owner, conversation: DEV_FILE_PEER, sender: DEV_FILE_PEER, fromMe: false };
  await upsertDmMessages([
    {
      ...base,
      eventId: 'dmfile01'.padEnd(64, '0'),
      createdAt: now - 2,
      wireKind: 15,
      content: textForRumor(rumor),
    },
    {
      ...base,
      eventId: 'dmfile02'.padEnd(64, '0'),
      createdAt: now - 1,
      wireKind: 14,
      content: 'https://example.com/report.docx',
    },
    {
      ...base,
      eventId: 'dmfile03'.padEnd(64, '0'),
      createdAt: now,
      wireKind: 4,
      content: 'https://example.com/invoice-nip04.pdf',
    },
  ]);
  return { pubkey: DEV_FILE_PEER };
}
