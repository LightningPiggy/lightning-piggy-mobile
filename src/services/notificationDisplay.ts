import i18n from '../i18n';
import type { NotificationKind } from './notificationService';

/** Generic title / body to use when the user has lock-screen content
 * disabled. Picked per-kind so the notification still tells the user
 * roughly what happened ("New message" vs "Payment received") without
 * leaking specifics. */
export function genericFor(kind: NotificationKind): { title: string; body: string } {
  switch (kind) {
    case 'market':
      return { title: i18n.t('sellerActivity.generic'), body: '' };
    case 'dm':
      return { title: 'New message', body: 'Open Lightning Piggy to read' };
    case 'group':
      return { title: 'New group message', body: 'Open Lightning Piggy to read' };
    case 'payment':
      return { title: 'Payment received', body: 'Open Lightning Piggy for details' };
    case 'zap':
      return { title: 'Zap received', body: 'Open Lightning Piggy for details' };
    case 'cache':
      return { title: 'New find on your cache', body: 'Open Lightning Piggy to view' };
    // A swap needing action must not be redacted into "Payment received".
    case 'swap':
      return { title: 'Action needed', body: 'Open Lightning Piggy for details' };
  }
}
