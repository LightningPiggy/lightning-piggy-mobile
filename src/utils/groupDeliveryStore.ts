import { useSyncExternalStore } from 'react';
import { failedDelivery, type DeliveryStatus } from './dmDeliveryStatus';

/**
 * Delivery status of group messages sent THIS session — the group twin of
 * `dmDeliveryStore`, keyed by the optimistic row's id (`local_…`), which a row
 * keeps as `localId` when it is re-keyed to its Marmot id or replaced by its
 * NIP-17 self-wrap echo. In memory only: after a restart a sent group message
 * shows no tick (untracked), and a failed one is still marked by the row's
 * persisted `sendFailed` flag.
 *
 * A send writes at most three times (pending, settled, a late final), so
 * listeners are notified per write — there is no per-relay-event churn.
 */
const statuses = new Map<string, DeliveryStatus>();
const listeners = new Set<() => void>();
let snapshot: ReadonlyMap<string, DeliveryStatus> = new Map();

/** At most this many sends are remembered (oldest dropped first). */
export const MAX_GROUP_DELIVERY_STATUSES = 500;

export function setGroupDeliveryStatus(rowId: string, status: DeliveryStatus): void {
  if (!rowId) return;
  const existing = statuses.get(rowId);
  // A settled send never goes back to "sending" (a late pending write loses).
  if (existing && !existing.pending && status.pending) return;
  if (existing === status) return;
  statuses.delete(rowId);
  statuses.set(rowId, status);
  if (statuses.size > MAX_GROUP_DELIVERY_STATUSES) {
    const oldest = statuses.keys().next().value;
    if (oldest !== undefined) statuses.delete(oldest);
  }
  snapshot = new Map(statuses);
  for (const listener of listeners) listener();
}

export function getGroupDeliveryStatus(rowId: string | undefined): DeliveryStatus | undefined {
  return rowId ? statuses.get(rowId) : undefined;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const getSnapshot = () => snapshot;

/** The session's group delivery statuses; a new map whenever one changes. */
export function useGroupDeliveryStatuses(): ReadonlyMap<string, DeliveryStatus> {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/**
 * A settled group send's status. "Sent" means the send succeeded — for a
 * gift-wrap group, every member's wrap reached at least one relay — and the
 * per-relay results drive the tick as in a 1:1 chat. A failed send (including
 * a partial one, where some members got nothing) is all-failed: the bubble
 * shows the red mark, whatever a relay did with the other members' wraps.
 */
export function settledGroupDelivery(
  result: { success: boolean; delivery?: DeliveryStatus },
  meta: { eventId?: string; kind?: number; relays?: string[] },
): DeliveryStatus {
  const { delivery } = result;
  if (!result.success || !delivery) {
    const relays = delivery ? Object.keys(delivery.relayResults) : meta.relays;
    return failedDelivery({
      eventId: delivery?.eventId ?? meta.eventId,
      kind: delivery?.kind ?? meta.kind,
      relays,
    });
  }
  return {
    ...delivery,
    pending: undefined,
    eventId: delivery.eventId ?? meta.eventId,
    kind: delivery.kind ?? meta.kind,
  };
}

/** Shown for a failed send restored from storage (its session status is gone). */
const RESTORED_FAILED: DeliveryStatus = failedDelivery();

/** The tick for one of our group rows: this session's status, else the
 * persisted failed mark, else none (sent before this session: untracked). */
export function groupRowDelivery(
  row: { id: string; localId?: string; sendFailed?: boolean },
  statuses: ReadonlyMap<string, DeliveryStatus>,
): DeliveryStatus | undefined {
  return (
    statuses.get(row.localId ?? row.id) ??
    statuses.get(row.id) ??
    (row.sendFailed ? RESTORED_FAILED : undefined)
  );
}

export function __resetGroupDeliveryStore(): void {
  statuses.clear();
  listeners.clear();
  snapshot = new Map();
}
