import { useLocale } from '../contexts/LocaleContext';
import { useMemo } from 'react';
import type { WalletState } from '../types/wallet';
import type { DmProtocol } from '../utils/dmProtocol';
import {
  buildConversationItems,
  buildZapItems,
  type ConversationMessageInput,
  type DeviceNoticeInput,
  type Item,
} from '../utils/conversationItems';
import { useResolvedDmDeliveries } from './useDmDeliveryStatuses';
import { useStableRows } from './useStableRows';
import { useOutgoingOrderHistory } from './useOutgoingOrderHistory';
import { useFailedMarmotInvites } from './useFailedMarmotInvites';
import { failedInvitesFrom } from '../utils/marmotInviteRows';

const NO_NOTICES: readonly DeviceNoticeInput[] = [];
const itemKey = (item: Item) => item.id;

/** Assemble the thread timeline with delivery ticks and verified payment amounts. */
export function useConversationTimeline(
  messages: ConversationMessageInput[],
  wallets: WalletState[],
  owner: string | null,
  partner: string,
  protocol: DmProtocol,
  // Alpha-only Marmot device notices (#1267); empty unless the switch is on.
  deviceNotices: readonly DeviceNoticeInput[] = NO_NOTICES,
  clearBoundary = 0,
) {
  const { formatLocale } = useLocale();
  const zapItems = useMemo(
    () => (protocol === 'nip17' ? buildZapItems(wallets, partner) : []),
    [wallets, partner, protocol],
  );
  // Event-id keyed delivery ticks survive the optimistic-row → relay-echo swap.
  const resolvedMessages = useResolvedDmDeliveries(messages);
  // Targeted history read verifies payment requests for orders outside the loaded slice.
  const olderOrderAmounts = useOutgoingOrderHistory(owner, partner, resolvedMessages);
  // Marmot invites from this partner that couldn't be opened (#1269).
  const failedInvites = useFailedMarmotInvites(protocol === 'nip17' ? owner : null);
  const partnerInvites = useMemo(
    () => failedInvitesFrom(failedInvites, partner),
    [failedInvites, partner],
  );
  const items = useMemo(
    () =>
      buildConversationItems(
        resolvedMessages,
        zapItems,
        olderOrderAmounts,
        partnerInvites,
        formatLocale,
        deviceNotices,
        clearBoundary,
      ),
    [
      resolvedMessages,
      zapItems,
      olderOrderAmounts,
      partnerInvites,
      formatLocale,
      deviceNotices,
      clearBoundary,
    ],
  );
  // Unchanged rows keep their identity, so the memoised bubbles skip re-rendering.
  return useStableRows(items, itemKey);
}
