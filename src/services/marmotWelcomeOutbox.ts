// Invitations (Welcomes) that no relay accepted, kept so they can be sent
// again WITHOUT another Add commit and without asking the signer again.
//
// A Welcome reaches each invited device as a NIP-59 gift wrap that is fully
// signed (by a throwaway key) before it's published, so republishing the
// very same event later is a valid retry. The Add commit has already made
// the person a member — re-inviting them isn't possible (they're filtered
// out as "already a member") and wouldn't be needed: only delivery failed.
//
// Lifecycle: the session's network publish is wrapped so failed gift wraps
// are captured while an invite runs; the invite retries them once straight
// away, then persists what's still undelivered here and retries it — after
// session start / resume and on a send in its chat — until a relay accepts it
// or it expires. Each wrap backs off between retries (1 min doubling to
// 30 min) and is never republished twice at once (#1402).

import type { NostrNetworkInterface } from '@internet-privacy/marmot-ts';
import type { Event as NostrEvent } from 'nostr-tools';

import type { MarmotKvBackend } from './marmotStore';

const GIFT_WRAP_KIND = 1059;
const OUTBOX_NS = 'welcomeOutbox';
/** Give up after this long — the invited key package will have rotated. */
export const WELCOME_OUTBOX_TTL_SECS = 14 * 24 * 60 * 60;
/** Bound on stored wraps (oldest dropped first). */
const OUTBOX_MAX = 100;
/** A queued invitation is retried no sooner than this after a failed attempt,
 * doubling up to the max (#1402). Shared with the unsigned queue. */
export const WELCOME_RETRY_BACKOFF_MS = 60_000;
export const WELCOME_RETRY_BACKOFF_MAX_MS = 30 * 60_000;
/** Queue changes in a burst are reported once per chat, at most this often. */
export const INVITE_CHANGE_COALESCE_MS = 150;

/** The next backoff after a failed attempt (`previous` = the last one, if any). */
export function nextRetryBackoff(previous: { delayMs: number } | undefined, now = Date.now()) {
  const delayMs = Math.min(
    (previous?.delayMs ?? WELCOME_RETRY_BACKOFF_MS / 2) * 2,
    WELCOME_RETRY_BACKOFF_MAX_MS,
  );
  return { at: now + delayMs, delayMs };
}

/**
 * "A chat's queued invitations changed" (queued, reason changed, delivered,
 * dropped), coalesced: a burst of queue writes becomes one call per chat
 * (MLS group id hex), so a member list reloads its status once (#1402).
 */
export class InviteChanges {
  private readonly listeners = new Set<(groupIdHex: string) => void>();
  private readonly changed = new Set<string>();
  private timer: ReturnType<typeof setTimeout> | null = null;

  notify(groupIdHex: string): void {
    this.changed.add(groupIdHex);
    this.timer ??= setTimeout(() => {
      this.timer = null;
      const ids = [...this.changed];
      this.changed.clear();
      for (const id of ids) for (const listener of this.listeners) listener(id);
    }, INVITE_CHANGE_COALESCE_MS);
  }

  subscribe(listener: (groupIdHex: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

export interface PendingWelcome {
  /** The signed kind-1059 gift wrap, ready to republish. */
  event: NostrEvent;
  /** The recipient's inbox relays it was meant for. */
  relays: string[];
  /** Recipient account (the wrap's `p`). */
  recipient: string;
  /** MLS group id (hex) it invites to. */
  groupIdHex: string;
  queuedAt: number;
}

type Publish = NostrNetworkInterface['publish'];
type CapturedWrap = Pick<PendingWelcome, 'event' | 'relays' | 'recipient'>;

const accepted = (res: Awaited<ReturnType<Publish>>) => Object.values(res).some((r) => r.ok);
const recipientOf = (e: NostrEvent) => e.tags.find((t) => t[0] === 'p')?.[1]?.toLowerCase() ?? '';

export class MarmotWelcomeOutbox {
  private readonly captures = new Set<{ failed: CapturedWrap[]; onWrap?: () => void }>();
  private publishRaw: Publish | null = null;
  /** Captures run one at a time: gift wraps are encrypted, so a failed one
   * can't be traced to its group — two invites at once would swap them. */
  private captureChain: Promise<unknown> = Promise.resolve();
  /** Per wrap (event id): when it may be retried again (in memory). */
  private readonly backoff = new Map<string, { at: number; delayMs: number }>();
  /** Per wrap: the republish in flight, shared by concurrent flushes. */
  private readonly retrying = new Map<string, Promise<boolean>>();
  /** Both invitation queues report their changes here. */
  readonly changes = new InviteChanges();
  /** Per chat, bumped when its invitations are dropped (see `markDropped`). */
  private readonly generations = new Map<string, number>();

  constructor(
    private readonly backend: MarmotKvBackend,
    /** The session has stopped (sign-out / switch): nothing more is published. */
    private readonly isStopped: () => boolean = () => false,
  ) {}

  /** The network with its publish observed: failed gift wraps are captured
   * (while an invite runs) and every wrap reports progress. */
  wrapNetwork<N extends Pick<NostrNetworkInterface, 'publish'>>(network: N): N {
    const publish = network.publish.bind(network) as Publish;
    this.publishRaw = publish;
    return {
      ...network,
      publish: async (relays: string[], event: NostrEvent) => {
        const res = await publish(relays, event);
        if (event.kind === GIFT_WRAP_KIND && this.captures.size > 0) {
          const ok = accepted(res);
          for (const c of this.captures) {
            if (!ok) c.failed.push({ event, relays, recipient: recipientOf(event) });
            c.onWrap?.();
          }
        }
        return res;
      },
    } as N;
  }

  /** Run `fn` (after any capture already running), collecting the gift
   * wraps no relay accepted meanwhile. */
  capture<T>(
    fn: () => Promise<T>,
    onWrap?: () => void,
  ): Promise<{ result: T; failed: CapturedWrap[] }> {
    const run = this.captureChain.then(async () => {
      const c = { failed: [] as CapturedWrap[], onWrap };
      this.captures.add(c);
      try {
        return { result: await fn(), failed: c.failed };
      } finally {
        this.captures.delete(c);
      }
    });
    this.captureChain = run.catch(() => undefined);
    return run;
  }

  /**
   * A chat's drop generation (MLS group id hex). Work on its invitations that
   * started before a drop — an invite's captured failures, a retry — passes
   * the generation it saw, and stops once it has moved on (#1402).
   */
  generation(groupIdHex: string): number {
    return this.generations.get(groupIdHex) ?? 0;
  }

  /** The chat was left, removed or destroyed: its in-flight resends and
   * enqueues stop (called by `drop` and the unsigned queue's drop). */
  markDropped(groupIdHex: string): void {
    this.generations.set(groupIdHex, this.generation(groupIdHex) + 1);
  }

  private isDropped(guard?: { groupIdHex: string; generation: number }): boolean {
    return !!guard && this.generation(guard.groupIdHex) !== guard.generation;
  }

  /** Republish each wrap once; returns those still not accepted (all of
   * them, unpublished, once the session has stopped or — with `guard` —
   * their chat was dropped since `guard.generation`). */
  async resend<W extends CapturedWrap>(
    wraps: W[],
    guard?: { groupIdHex: string; generation: number },
  ): Promise<W[]> {
    const publish = this.publishRaw;
    if (!publish || this.isStopped() || this.isDropped(guard)) return wraps;
    const results = await Promise.all(
      wraps.map((w) => publish(w.relays, w.event).then(accepted, () => false)),
    );
    return wraps.filter((_, i) => !results[i]);
  }

  /** Keep undelivered wraps for retry. They were just attempted, so the
   * first retry waits out the first backoff step. */
  async enqueue(groupIdHex: string, wraps: CapturedWrap[], generation?: number): Promise<void> {
    // A chat dropped since the caller's `generation`: nothing to keep.
    if (generation !== undefined && this.isDropped({ groupIdHex, generation })) return;
    const queuedAt = Math.floor(Date.now() / 1000);
    const started = this.generation(groupIdHex);
    const written: PendingWelcome[] = [];
    for (const w of wraps) {
      // Dropped part-way (left / destroyed): stop, and take back what we wrote.
      if (this.generation(groupIdHex) !== started) break;
      const item: PendingWelcome = { ...w, groupIdHex, queuedAt };
      await this.backend.set(OUTBOX_NS, w.event.id, JSON.stringify(item));
      this.backoff.set(w.event.id, nextRetryBackoff(this.backoff.get(w.event.id)));
      written.push(item);
    }
    if (this.generation(groupIdHex) !== started) {
      for (const item of written) await this.forget(item);
      return;
    }
    if (wraps.length > 0) this.changes.notify(groupIdHex);
    if ((await this.backend.keys(OUTBOX_NS)).length <= OUTBOX_MAX) return;
    const oldestFirst = (await this.pending()).sort((a, b) => a.queuedAt - b.queuedAt);
    for (const item of oldestFirst.slice(0, oldestFirst.length - OUTBOX_MAX)) {
      await this.forget(item); // its chat's members sheet updates too
    }
  }

  /** Forget `recipient`'s queued wraps into a chat (they were removed from it). */
  async dropRecipient(groupIdHex: string, recipient: string): Promise<void> {
    for (const item of await this.pending()) {
      if (item.groupIdHex === groupIdHex && item.recipient.toLowerCase() === recipient) {
        await this.forget(item);
      }
    }
  }

  /** Forget a group's queued wraps (the group was destroyed / left). */
  async drop(groupIdHex: string): Promise<void> {
    this.markDropped(groupIdHex);
    for (const item of await this.pending()) {
      if (item.groupIdHex === groupIdHex) await this.forget(item);
    }
  }

  /**
   * Retry queued wraps — only `groupIdHex`'s when given (a send in that chat),
   * every chat's otherwise (the scheduled retry). A wrap still backing off is
   * skipped; one already being republished is shared, not sent twice.
   * Delivered and expired ones are removed.
   */
  async flush(groupIdHex?: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    // Generations as of the start: a chat dropped while this flush reads the
    // queue or works through earlier wraps isn't republished.
    const started = new Map(this.generations);
    for (const item of await this.pending()) {
      if (this.isStopped()) return;
      if (groupIdHex && item.groupIdHex !== groupIdHex) continue;
      if (now - item.queuedAt > WELCOME_OUTBOX_TTL_SECS) {
        await this.forget(item);
        continue;
      }
      if (Date.now() < (this.backoff.get(item.event.id)?.at ?? 0)) continue;
      const guard = { groupIdHex: item.groupIdHex, generation: started.get(item.groupIdHex) ?? 0 };
      if (await this.retryOnce(item, guard)) await this.forget(item);
    }
  }

  private retryOnce(
    item: PendingWelcome,
    guard: { groupIdHex: string; generation: number },
  ): Promise<boolean> {
    const id = item.event.id;
    const running = this.retrying.get(id);
    if (running) return running;
    const run = this.resend([item], guard)
      .then((still) => {
        if (still.length > 0) this.backoff.set(id, nextRetryBackoff(this.backoff.get(id)));
        return still.length === 0;
      })
      .finally(() => this.retrying.delete(id));
    this.retrying.set(id, run);
    return run;
  }

  private async forget(item: PendingWelcome): Promise<void> {
    await this.backend.remove(OUTBOX_NS, item.event.id);
    this.backoff.delete(item.event.id);
    this.changes.notify(item.groupIdHex);
  }

  async remove(eventId: string): Promise<void> {
    const raw = await this.backend.get(OUTBOX_NS, eventId);
    await this.backend.remove(OUTBOX_NS, eventId);
    this.backoff.delete(eventId);
    try {
      if (raw) this.changes.notify((JSON.parse(raw) as PendingWelcome).groupIdHex);
    } catch {
      // unreadable: nothing to report
    }
  }

  async pending(): Promise<PendingWelcome[]> {
    const items: PendingWelcome[] = [];
    for (const id of await this.backend.keys(OUTBOX_NS)) {
      const raw = await this.backend.get(OUTBOX_NS, id);
      try {
        if (raw) items.push(JSON.parse(raw) as PendingWelcome);
      } catch {
        await this.backend.remove(OUTBOX_NS, id);
      }
    }
    return items;
  }
}
