import type { Event } from 'nostr-tools';
import { isTestRelayLockdown } from '../config/testRelayLockdown';
import { enabledAppRelays } from '../services/appRelayPrefs';
import { publishToRelays } from '../services/nostrRelayLists';
import { RELAY_LIST_INDEXERS } from '../utils/relayListEvents';
import type { SignedEvent } from './nostrContextTypes';

/** In-session re-sends of the SAME signed event while it's short of quorum. */
export const RETRY_DELAYS_MS = [5_000, 20_000, 60_000];

const norm = (url: string) => url.trim().replace(/\/+$/, '');

/** Published for good: an indexer has it, or at least two relays (lockdown: the test relay). */
export function reachedQuorum(pk: string, accepted: string[]): boolean {
  if (isTestRelayLockdown(pk)) return accepted.length > 0;
  const indexers = new Set(enabledAppRelays('indexers', RELAY_LIST_INDEXERS).map(norm));
  return accepted.length >= 2 || accepted.some((url) => indexers.has(norm(url)));
}

export interface SendDefaultOptions {
  pk: string;
  event: SignedEvent;
  targets: string[];
  /** Still this account? Retries stop as soon as it isn't. */
  isActive: () => boolean;
  /** Called once, when the first relay accepts it (first attempt or a retry). */
  onLive?: () => Promise<void> | void;
  /** Also retry when no relay took it at all (onboarding); otherwise only short of quorum. */
  retryWhenNone?: boolean;
  retryDelaysMs?: number[];
  publish?: typeof publishToRelays;
}

/**
 * Publish a signed default DM inbox list and, until an indexer or two relays
 * have it, re-send the SAME event to the rest a few times this session, then
 * give up quietly. Nothing is kept across sessions, and nothing is re-signed.
 * Resolves with the first attempt's result; retries carry on in the background.
 */
export async function sendDefault(o: SendDefaultOptions): Promise<{
  accepted: string[];
  done: boolean;
}> {
  const publish = o.publish ?? publishToRelays;
  const accepted = new Set<string>();
  let live = false;
  const attempt = async (): Promise<boolean> => {
    const remaining = o.targets.filter((url) => !accepted.has(url));
    if (remaining.length > 0) {
      const results = await publish(o.event as unknown as Event, remaining).catch(() => []);
      for (const r of results) if (r.ok) accepted.add(r.url);
    }
    if (!live && accepted.size > 0) {
      live = true;
      try {
        await o.onLive?.();
      } catch (e) {
        console.warn('[Nostr] adopting the default DM inbox list failed:', e);
      }
    }
    return reachedQuorum(o.pk, [...accepted]);
  };
  const done = await attempt();
  const first = { accepted: [...accepted], done };
  if (!done && (accepted.size > 0 || o.retryWhenNone) && o.isActive()) {
    void (async () => {
      for (const delay of o.retryDelaysMs ?? RETRY_DELAYS_MS) {
        await new Promise((resolve) => setTimeout(resolve, delay));
        if (!o.isActive() || (await attempt())) return;
      }
    })();
  }
  return first;
}
