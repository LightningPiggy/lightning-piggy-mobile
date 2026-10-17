import type React from 'react';
import { useEffect } from 'react';
import { subscribeDmDeletions } from '../services/dmDb';
import { loadInboxEntries } from '../services/dmInbox';
import type { DmInboxEntry } from '../utils/conversationSummaries';
import { DM_INBOX_CAP, mergeInboxEntries } from './nostrDmCache';

type InboxSetterFor = (
  owner: string | null,
) => React.Dispatch<React.SetStateAction<DmInboxEntry[]>>;

/**
 * Drop deleted DM rows (e.g. a misfiled NIP-171 ticket moved out by the
 * ticket repair) from the in-memory inbox. One update per deletion batch:
 * the store's latest-per-conversation read is merged back in so a thread
 * whose newest row went still shows its previous message. Owner-scoped via
 * `inboxSetterFor`, which drops writes for an account that isn't active.
 */
export function useDmInboxDeletions(inboxSetterFor: InboxSetterFor): void {
  useEffect(() => {
    let active = true;
    // Every id deleted while a read is still pending, per owner: reads can
    // finish out of order, and an older one may still hold a row a newer
    // deletion removed. Cleared once the owner has no read in flight.
    const pending = new Map<string, { ids: Set<string>; reads: number }>();
    const unsubscribe = subscribeDmDeletions((owner, eventIds) => {
      const slot = pending.get(owner) ?? { ids: new Set<string>(), reads: 0 };
      pending.set(owner, slot);
      for (const id of eventIds) slot.ids.add(id);
      slot.reads++;
      void loadInboxEntries(owner)
        .catch(() => [] as DmInboxEntry[])
        .then((fresh) => {
          const deleted = new Set(slot.ids);
          if (--slot.reads === 0) pending.delete(owner);
          if (!active) return;
          const keep = (e: DmInboxEntry) => !deleted.has(e.id);
          inboxSetterFor(owner)((prev) =>
            prev.some((e) => deleted.has(e.id))
              ? mergeInboxEntries(prev.filter(keep), fresh.filter(keep), DM_INBOX_CAP)
              : prev,
          );
        });
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [inboxSetterFor]);
}
