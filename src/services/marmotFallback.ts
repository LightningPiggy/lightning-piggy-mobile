// When a 1:1 Marmot send can't reach the peer (no usable key package), the
// user is asked before the message goes over NIP-17 instead — and, once per
// thread, the peer gets a short note saying we tried Marmot. This module holds
// the decision, the dialog copy and the "note already sent" flag; the composer
// (useConversationComposerActions) does the sending.

import AsyncStorage from '@react-native-async-storage/async-storage';
import type { BrandedAlertButton, BrandedAlertOptions } from '../components/BrandedAlert';
import { t } from '../i18n';
import type { DmProtocol } from '../utils/dmProtocol';

/** Why Marmot can't reach a peer: they published no key package, only ones
 * this library can't use (expired, or an older Marmot format), or no relays an
 * invitation can be delivered to (#1402). */
export type MarmotUnreachableReason = 'noKeyPackage' | 'outdatedKeyPackage' | 'noInbox';

const FALLBACK_TITLE: Record<MarmotUnreachableReason, string> = {
  noKeyPackage: 'marmotFallback.titleNoKeyPackage',
  outdatedKeyPackage: 'marmotFallback.titleOutdated',
  noInbox: 'marmotFallback.titleNoInbox',
};

/** The reason to offer NIP-17 for a failed send, or null when the failure
 * isn't "Marmot can't reach them" (or the thread isn't Marmot at all). */
export function nip17FallbackReason(
  result: { success: boolean; marmotUnreachable?: MarmotUnreachableReason },
  protocol: DmProtocol,
): MarmotUnreachableReason | null {
  if (result.success || protocol !== 'marmot') return null;
  return result.marmotUnreachable ?? null;
}

const NOTE_SENT_PREFIX = 'marmot_fallback_note_sent_v1';

/** Scoped by our own account AND the peer, so another account on this phone
 * (or another thread) still sends its own note. */
export function marmotFallbackNoteKey(myPubkey: string, peerPubkey: string): string {
  return `${NOTE_SENT_PREFIX}:${myPubkey.toLowerCase()}:${peerPubkey.toLowerCase()}`;
}

export async function hasSentMarmotFallbackNote(
  myPubkey: string,
  peerPubkey: string,
): Promise<boolean> {
  try {
    return (await AsyncStorage.getItem(marmotFallbackNoteKey(myPubkey, peerPubkey))) === '1';
  } catch {
    return false;
  }
}

export async function markMarmotFallbackNoteSent(
  myPubkey: string,
  peerPubkey: string,
): Promise<void> {
  try {
    await AsyncStorage.setItem(marmotFallbackNoteKey(myPubkey, peerPubkey), '1');
  } catch {
    // Best effort: worst case they get the note once more next time.
  }
}

/** The note that tells the peer we tried Marmot. */
export function marmotFallbackNoteText(): string {
  return t('marmotFallback.note');
}

export interface MarmotFallbackPromptCopy {
  title: string;
  message: string;
  cancel: string;
  confirm: string;
}

export function marmotFallbackPromptCopy(
  reason: MarmotUnreachableReason,
  name: string,
  noteAlreadySent: boolean,
): MarmotFallbackPromptCopy {
  const body = t('marmotFallback.body');
  return {
    title: t(FALLBACK_TITLE[reason], { name }),
    message: noteAlreadySent ? body : `${body} ${t('marmotFallback.willNotify')}`,
    cancel: t('marmotFallback.cancel'),
    confirm: t('marmotFallback.confirm'),
  };
}

type AlertFn = (
  title: string,
  message?: string,
  buttons?: BrandedAlertButton[],
  options?: BrandedAlertOptions,
) => void;

/** Show the "send with NIP-17 instead?" dialog. Resolves true only for the
 * confirm button; Cancel and a dismiss (backdrop / back) resolve false. The
 * `settled` guard stops `onDismiss` resolving after a button already did. */
export function askMarmotFallback(
  alert: AlertFn,
  copy: MarmotFallbackPromptCopy,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const settle = (value: boolean) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    alert(
      copy.title,
      copy.message,
      [
        { text: copy.cancel, style: 'cancel', onPress: () => settle(false) },
        { text: copy.confirm, style: 'default', onPress: () => settle(true) },
      ],
      { cancelable: true, onDismiss: () => settle(false) },
    );
  });
}
