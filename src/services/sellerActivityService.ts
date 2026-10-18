import { perfLog } from '../utils/perfLog';
import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Event, Filter } from 'nostr-tools';
import type { TranslateOptions } from 'i18n-js';
import { pool, trackRelays } from './nostrPool';
import { querySyncAbortable } from './relayQuery';
import { activeAccountRelays } from './testRelayRouting';
import { fetchSellerEvents, loadHiddenListings } from './marketSellerService';
import { reduceSellerSnapshot } from '../utils/marketSellerSnapshot';
import { addressableCoord, getTagValue } from '../utils/productComments';
import { parseReviewEvent } from '../utils/productReviews';
import { parseMarketListing } from '../utils/marketListings';
import {
  stageActivity,
  activityTarget,
  activityFilters,
  activitySince,
  parseActivityCursor,
  type ActivityCursor,
} from '../utils/sellerActivity';
import { fireNotification } from './notificationService';
import { loadSellerActivityEnabled } from './sellerActivityPreference';
import { perAccountKey } from './perAccountStorage';
import { getActivePubkey } from './walletStorageService';
import { createYieldScheduler } from '../contexts/nostrDecryptPacing';
import { shouldMuteNotification } from './mutedSenders';

interface Input {
  owner: string;
  relays: string[];
  friends: ReadonlyMap<string, string>;
  onlyFriends: boolean;
  t: (key: string, options?: TranslateOptions) => string;
  signal: AbortSignal;
}
// Focus and resume share one flight, so cursors/rate limits cannot race.
const running = new Map<string, { cancelled: boolean; settled: Promise<void> }>();

/** Account removal waits for writes already in flight before wiping storage. */
export async function cancelSellerActivity(owner: string): Promise<void> {
  const flight = running.get(owner);
  if (!flight) return;
  flight.cancelled = true;
  await flight.settled;
}
const query = async (
  input: Pick<Input, 'relays' | 'signal'>,
  filter: Filter,
  completedRelays?: Set<string>,
) => {
  const relays = [...new Set(activeAccountRelays(input.relays))];
  const completed = completedRelays ?? new Set<string>();
  const events = await querySyncAbortable(pool, relays, filter, {
    signal: input.signal,
    maxWait: 5000,
    rejectOnAllRelaysFailure: true,
    rejectOnTimeout: true,
    completedRelays: completed,
  });
  if (!completedRelays && completed.size < relays.length)
    throw new Error('Seller activity relay query incomplete');
  return events;
};

/** Inclusive page boundaries retain events sharing the oldest timestamp.
 * Saturated seconds are skipped; a page budget leaves lastSeen unchanged for retry.
 */
async function* activityPages(input: Input, filter: Filter, now: number) {
  let until = now + 120;
  let relays = [...new Set(activeAccountRelays(input.relays))];
  let incomplete = false;
  const finish = () => {
    if (incomplete) throw new Error('Seller activity relay query incomplete');
  };
  const completedRelays = new Set<string>();
  for (let page = 0; page < 25; page++) {
    // Each relay applies limit independently. Keep the globally newest page
    // so an older result from a sparse relay cannot skip a busy relay's tail.
    const events = (await query({ ...input, relays }, { ...filter, until }, completedRelays))
      .filter((event) => event.created_at <= until)
      .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))
      .slice(0, filter.limit);
    incomplete ||= completedRelays.size < relays.length;
    relays = [...completedRelays];
    yield events;
    if (events.length < filter.limit!) return finish();
    const oldest = Math.min(...events.map((event) => event.created_at));
    if (oldest < filter.since!) return finish();
    if (oldest >= until) {
      perfLog(`[SellerActivity] skipped saturated second (${events.length} returned events)`);
      until = oldest - 1;
    } else until = oldest;
    if (until < filter.since!) return finish();
  }
  throw new Error('Seller activity page budget exhausted');
}

export async function checkSellerActivity(input: Input): Promise<void> {
  const { owner, signal, friends, t } = input;
  const previous = running.get(owner);
  if (previous) {
    await previous.settled;
    if (!signal.aborted) return checkSellerActivity(input);
    return;
  }
  let finish = () => {};
  const flight = {
    cancelled: false,
    settled: new Promise<void>((resolve) => {
      finish = resolve;
    }),
  };
  running.set(owner, flight);
  const current = () => !flight.cancelled && !signal.aborted && getActivePubkey() === owner;
  const startedAt = Date.now();
  perfLog('[PerfBlock] seller activity check start');
  const scheduler = createYieldScheduler({ signal, safetyEvery: 25 });
  let progress: { key: string; cursor: ActivityCursor; dirty: boolean } | undefined;
  try {
    if (!current()) return;
    const now = Math.floor(Date.now() / 1000);
    const storageKey = perAccountKey('seller_activity_cursor_v1', owner);
    const raw = await AsyncStorage.getItem(storageKey);
    const cursor = parseActivityCursor(raw, now);
    progress = { key: storageKey, cursor, dirty: false };
    const seen = new Set(cursor.seen);
    trackRelays(input.relays);
    const [snapshot, hidden, enabled] = await Promise.all([
      fetchSellerEvents({ pubkey: owner, relays: input.relays, signal }),
      loadHiddenListings(owner),
      loadSellerActivityEnabled(owner),
    ]);
    if (!current()) return;
    const listings = reduceSellerSnapshot(snapshot, owner, hidden).listings.filter((e) =>
      parseMarketListing(e),
    );
    const byCoord = new Map(listings.map((e) => [addressableCoord(e), e]));
    const parents = new Map<string, Event>();
    const coords = new Set(byCoord.keys());
    let failure: { error: unknown } | undefined;
    // Sequential chunks and pages bound relay pressure.
    for (const filter of activityFilters(
      [...coords],
      [...parents.keys()],
      activitySince(cursor.lastSeen, now),
      owner,
    )) {
      try {
        for await (const events of activityPages(input, filter, now)) {
          if (!current()) return;
          // Resolve the actual parent, even when it was posted years ago. Never
          // trust a stranger's p-tag to establish that the user wrote the parent.
          const ids = [
            ...new Set(
              events
                .filter((e) => e.kind === 1111)
                .map((e) => getTagValue(e, 'e'))
                .filter((id): id is string => !!id && !parents.has(id)),
            ),
          ];
          for (let i = 0; i < ids.length; i += 25) {
            const chunk = ids.slice(i, i + 25);
            const fetched = await query(input, {
              kinds: [1111],
              authors: [owner],
              ids: chunk,
              since: 0,
              limit: 25,
            });
            for (const parent of fetched)
              if (parent.kind === 1111 && parent.pubkey === owner && chunk.includes(parent.id))
                parents.set(parent.id, parent);
          }
          if (!current()) return;
          for (const event of events.sort(
            (a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id),
          )) {
            const target = activityTarget(event, owner, coords, parents);
            if (!target) continue;
            const review =
              target.tab === 'reviews' ? parseReviewEvent(event, `a:${target.coord}`) : null;
            if (target.tab === 'reviews' && !review) continue;
            const friend = friends.has(event.pubkey);
            // Stage acceptance: cancellation or a failed delivery must not consume
            // the seen ID or stranger quota before history has been recorded.
            const staged = stageActivity(cursor, seen, event, target.coord, friend, now);
            const commit = (consumeQuota = true) => {
              staged.commit(consumeQuota);
              progress!.dirty = true;
            };
            if (!staged.accepted) {
              commit();
              continue;
            }
            const title =
              getTagValue(byCoord.get(target.coord) ?? event, 'title')?.slice(0, 120) ||
              t('sellerActivity.listing');
            const text = target.sellerReply
              ? t('sellerActivity.sellerReplied')
              : target.reply
                ? t('sellerActivity.reply', {
                    name: friends.get(event.pubkey) || event.pubkey.slice(0, 12),
                  })
                : review
                  ? t('sellerActivity.review', { title, stars: review.stars })
                  : t('sellerActivity.comment', { title });
            const data = {
              listingCoord: target.coord,
              feedbackTab: target.tab,
              senderPubkey: event.pubkey,
              owner,
            };
            const muted = await shouldMuteNotification(owner, data, 'market');
            if (!current()) return;
            if (muted) {
              commit(false);
              continue;
            }
            const mayRecord = async () => {
              const settingEnabled = await loadSellerActivityEnabled(owner);
              return current() && enabled && settingEnabled;
            };
            if (!(await mayRecord())) {
              if (!current()) return;
              commit();
              continue;
            }
            let recorded = false;
            await fireNotification({
              kind: 'market',
              title: text,
              body: '',
              data,
              owner,
              historyKey: `market:${event.id}`,
              historyCreatedAt: event.created_at * 1000,
              mayRecord,
              onHistoryRecorded: () => {
                recorded = true;
              },
              shouldSuppress: async () =>
                !current() ||
                !enabled ||
                !(await loadSellerActivityEnabled(owner)) ||
                (input.onlyFriends && !friend) ||
                event.created_at < now - (raw ? 86400 : 120),
            });
            if (!recorded) {
              if (!current()) return;
              throw new Error('Seller activity history was not recorded');
            }
            commit();
            await scheduler.maybeYield();
          }
        }
      } catch (error) {
        if (!current()) return;
        // Retry incomplete ranges next pass without starving later filters.
        failure ??= { error };
      }
    }
    if (failure) throw failure.error;
    if (!current()) return;
    cursor.lastSeen = now;
    progress.dirty = true;
  } finally {
    // Keep completed IDs and quota consumption even if a later chunk fails or
    // the screen blurs. Only a fully successful pass advances lastSeen.
    // Account wipe cancels AND awaits this write before removing the keys.
    try {
      if (progress?.dirty)
        await AsyncStorage.setItem(progress.key, JSON.stringify(progress.cursor));
    } finally {
      perfLog(`[PerfBlock] seller activity check settled in ${Date.now() - startedAt}ms`);
      scheduler.dispose();
      running.delete(owner);
      finish();
    }
  }
}

/** Resolve only after an explicit tap; notification rows never fetch images. */
export async function resolveActivityListing(coord: string, relays: string[], signal: AbortSignal) {
  const [kind, author, ...parts] = coord.split(':');
  if (kind !== '30402' || !/^[a-f0-9]{64}$/i.test(author) || !parts.join(':')) return null;
  trackRelays(relays);
  const events = await query(
    { relays, signal },
    { kinds: [30402], authors: [author], '#d': [parts.join(':')], since: 0, limit: 5 },
    // A tap can use a completed snapshot even if another relay is unavailable.
    new Set<string>(),
  );
  const latest = events
    .filter((e) => addressableCoord(e) === coord)
    .sort((a, b) => b.created_at - a.created_at || a.id.localeCompare(b.id))[0];
  return latest ? parseMarketListing(latest) : null;
}
