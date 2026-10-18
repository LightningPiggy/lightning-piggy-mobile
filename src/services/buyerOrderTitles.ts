import { isSellerAccountForgotten } from './sellerEventStore';
// Item titles for orders I placed, recorded at checkout. A Gamma order only
// carries `30402:<pubkey>:<d>` refs — no titles — so My orders would
// otherwise show raw listing ids. Device-local, per account, bounded.
import AsyncStorage from '@react-native-async-storage/async-storage';

const MAX_ORDERS = 300;
const key = (pubkey: string) => `market-buyer-order-titles:${pubkey}`;
let writeChain: Promise<unknown> = Promise.resolve();
const generations = new Map<string, number>();
const retired = new Set<string>();
export const buyerOrderTitleGeneration = (pubkey: string) => generations.get(pubkey) ?? 0;

/** Invalidate checkout work synchronously, before any account cleanup awaits. */
export function retireBuyerOrderTitles(pubkey: string): void {
  retired.add(pubkey);
  generations.set(pubkey, buyerOrderTitleGeneration(pubkey) + 1);
}

/** Called only on account activation; old checkout generations stay invalid. */
export function reviveBuyerOrderTitles(pubkey: string): void {
  retired.delete(pubkey);
}

/** Drain queued writes before deleting account caches. */
export function waitForBuyerOrderTitleWrites(): Promise<void> {
  return writeChain.then(() => undefined);
}

/** orderId → (item ref → title). */
export type BuyerOrderTitles = Record<string, Record<string, string>>;

export async function loadBuyerOrderTitles(pubkey: string): Promise<BuyerOrderTitles> {
  try {
    const raw = await AsyncStorage.getItem(key(pubkey));
    const parsed: unknown = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== 'object') return {};
    const out: BuyerOrderTitles = {};
    for (const [orderId, refs] of Object.entries(parsed as Record<string, unknown>)) {
      if (!refs || typeof refs !== 'object') continue;
      const clean: Record<string, string> = {};
      for (const [ref, title] of Object.entries(refs as Record<string, unknown>)) {
        if (typeof title === 'string' && title) clean[ref] = title.slice(0, 200);
      }
      out[orderId] = clean;
    }
    return out;
  } catch {
    return {};
  }
}

export function recordBuyerOrderTitles(
  pubkey: string,
  orderId: string,
  titles: Record<string, string>,
  generation = buyerOrderTitleGeneration(pubkey),
): Promise<void> {
  const canWrite = () => !retired.has(pubkey) && buyerOrderTitleGeneration(pubkey) === generation;
  const run = writeChain.then(async () => {
    if (!canWrite()) return;
    if (isSellerAccountForgotten(pubkey)) return;
    const all = await loadBuyerOrderTitles(pubkey);
    if (isSellerAccountForgotten(pubkey)) return;
    delete all[orderId];
    const kept = [[orderId, titles] as const, ...Object.entries(all)].slice(0, MAX_ORDERS);
    if (!canWrite()) return;
    await AsyncStorage.setItem(key(pubkey), JSON.stringify(Object.fromEntries(kept)));
  });
  writeChain = run.catch(() => undefined);
  return run;
}

export async function drainBuyerOrderTitleWrites(): Promise<void> {
  await writeChain;
}
