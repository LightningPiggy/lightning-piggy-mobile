import AsyncStorage from '@react-native-async-storage/async-storage';
import { admitOrder, ORDER_WINDOW_MS, type OrderBudget } from '../utils/orderRateLimit';
import { parseOrderEvent } from '../utils/orderEvents';
import { rumorEventId, type DecodedRumor } from '../utils/nip17Unwrap';
import { isSellerAccountForgotten } from './sellerEventStore';

export const orderBudgetKey = (owner: string) => `market-order-budget:${owner.toLowerCase()}`;
let chain: Promise<unknown> = Promise.resolve();
const pending = new Set<string>();
const deliveryKey = (owner: string, rumor: DecodedRumor) =>
  JSON.stringify([owner.toLowerCase(), rumor.pubkey.toLowerCase(), rumorEventId(rumor)]);

/** Release only this delivery's claims after failed persistence or cancellation. */
export function releaseOrderRumors(owner: string, rumors: readonly DecodedRumor[]): void {
  for (const rumor of rumors) pending.delete(deliveryKey(owner, rumor));
}

/** Shared by batch, live and deferred NIP-17 ingest, independent of the Messages follow gate.
 * Serialize persistent reservations so simultaneous deliveries cannot exceed the budget.
 * A storage failure fails closed. No relay-controlled clock or public event is admitted. */
export function acceptOrderRumor(
  owner: string,
  rumor: DecodedRumor,
  fromMe: boolean,
  onBudgetRejected?: () => void,
): Promise<boolean> {
  if (rumor.kind !== 16 && rumor.kind !== 17) return Promise.resolve(true);
  const order = parseOrderEvent(rumor);
  if (!order) return Promise.resolve(false);
  if (fromMe) return Promise.resolve(true);
  const run = chain
    .then(async () => {
      if (isSellerAccountForgotten(owner)) return false;
      const key = deliveryKey(owner, rumor);
      if (pending.has(key)) return false;
      // Every inbound lifecycle rumor uses the same durable budget and completed-id
      // check. A known purchase does not authorize unlimited merchant updates.
      const raw = await AsyncStorage.getItem(orderBudgetKey(owner));
      const now = Date.now();
      let budget: OrderBudget = { accepted: [], dropped: 0, droppedSince: now };
      if (raw) {
        try {
          budget = JSON.parse(raw);
        } catch {
          // Recover a corrupt local window without logging order data.
        }
      }
      // Reservations survive crashes but remain retryable until the encrypted
      // payload write succeeds. A retry consumes no additional budget slot.
      const existing = budget.accepted.find(
        (entry) =>
          entry.id === rumorEventId(rumor) &&
          entry.sender === rumor.pubkey.toLowerCase() &&
          entry.at > now - ORDER_WINDOW_MS,
      );
      if (existing) {
        if (existing.stored === true) return false;
        pending.add(key);
        return true;
      }
      const result = admitOrder(budget, rumor.pubkey, rumorEventId(rumor), now);
      if (isSellerAccountForgotten(owner)) return false;
      await AsyncStorage.setItem(orderBudgetKey(owner), JSON.stringify(result.budget));
      const allowed = !isSellerAccountForgotten(owner) && result.allowed;
      if (allowed) pending.add(key);
      else if (!result.allowed) onBudgetRejected?.();
      return allowed;
    })
    .catch(() => false);
  chain = run;
  return run;
}
/** Await in-flight reservations before account cleanup removes the persisted counters. */
export async function drainOrderAdmission(): Promise<void> {
  await chain;
}

/** Commit only AFTER durable payload persistence; a failed commit is safely retryable. */
export function completeOrderRumors(owner: string, rumors: readonly DecodedRumor[]): Promise<void> {
  if (rumors.length === 0) return Promise.resolve();
  const keys = new Set(rumors.map((rumor) => deliveryKey(owner, rumor)));
  const run = chain
    .then(async () => {
      if (isSellerAccountForgotten(owner)) return;
      const raw = await AsyncStorage.getItem(orderBudgetKey(owner));
      if (!raw) return;
      const budget: OrderBudget = JSON.parse(raw);
      for (const entry of budget.accepted)
        if (keys.has(JSON.stringify([owner.toLowerCase(), entry.sender, entry.id])))
          entry.stored = true;
      if (!isSellerAccountForgotten(owner))
        await AsyncStorage.setItem(orderBudgetKey(owner), JSON.stringify(budget));
    })
    .catch(() => undefined)
    .finally(() => releaseOrderRumors(owner, rumors));
  chain = run;
  return run;
}
