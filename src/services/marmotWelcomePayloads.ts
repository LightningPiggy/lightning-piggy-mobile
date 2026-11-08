// Preserve the Welcome before the remote signer can fail. The Add is already
// canonical: retry this rumor, never another Add or a refreshed key package.
import type { MarmotGroup, NostrWelcomeDelivery } from '@internet-privacy/marmot-ts';
import { GiftWrapFactory } from 'applesauce-common/factories/gift-wrap';
import type { Rumor } from 'applesauce-common/helpers/gift-wrap';
import type { Event as NostrEvent } from 'nostr-tools';

import type { MarmotDmDeviceSync } from './marmotDmDeviceSync';
import { watchMarmotResume } from './marmotResume';
import type { MarmotKvBackend } from './marmotStore';
import {
  nextRetryBackoff,
  WELCOME_OUTBOX_TTL_SECS,
  WELCOME_RETRY_BACKOFF_MAX_MS,
  WELCOME_RETRY_BACKOFF_MS,
  type MarmotWelcomeOutbox,
} from './marmotWelcomeOutbox';
import { amberFailureKind } from './amberErrors';
import { NostrConnectError, SignerTimeoutError } from './signerErrors';
import {
  MarmotNoWelcomeRelaysError,
  welcomeRelays,
  type NoWelcomeRelaysReason,
} from './marmotWelcomeRelays';

const NS = 'welcomePayloads';
/** Cap on stored Welcomes awaiting a signature; the oldest go first. */
export const MAX_PENDING_WELCOME_PAYLOADS = 50;
/** A Welcome with nowhere to go is retried no sooner than this, doubling up
 * to the max, so every open / send doesn't redo the lookup (#1402). */
export const NO_RELAYS_RETRY_MS = WELCOME_RETRY_BACKOFF_MS;
export const NO_RELAYS_RETRY_MAX_MS = WELCOME_RETRY_BACKOFF_MAX_MS;
const signerReason = (r: WelcomeWaitReason | undefined) =>
  r === 'signerDenied' || r === 'signerTimeout';
/** Session start's (and each resume's) retry waits this long, like other
 * non-urgent resume work (#554). */
export const WELCOME_RETRY_DELAY_MS = 3_000;

/**
 * Where an invitee's Welcome stands, for the chat's member list:
 * `needsSigner` — our signer declined or didn't answer; asked again on a send;
 * `pending` — queued for another reason (network, a lookup) and retried;
 * `waitingForRelays` — they publish no inbox relays yet (confirmed).
 */
export type InviteStatus = 'needsSigner' | 'pending' | 'waitingForRelays';
/** Most urgent first: what a person's several devices report as one status. */
const STATUS_RANK: Record<InviteStatus, number> = {
  needsSigner: 0,
  pending: 1,
  waitingForRelays: 2,
};

/**
 * Why a queued Welcome hasn't gone out: no destination yet (`noRelays` /
 * `unknown`, see marmotWelcomeRelays), or the signer declined it /
 * didn't answer in time (`signerDenied` / `signerTimeout`) after the Add
 * had committed — the invitee is a member, so it waits here for a retry.
 */
export type WelcomeWaitReason = NoWelcomeRelaysReason | 'signerDenied' | 'signerTimeout';

/** A signer refusal / timeout while sealing a Welcome, or null. */
export function signerFailureReason(e: unknown): 'signerDenied' | 'signerTimeout' | null {
  if (e instanceof WelcomeSignerSkippedError) return e.reason;
  if (e instanceof SignerTimeoutError || amberFailureKind(e) === 'no-response')
    return 'signerTimeout';
  if (
    (e instanceof NostrConnectError && e.kind === 'permission') ||
    amberFailureKind(e) === 'declined'
  )
    return 'signerDenied';
  return null;
}

/** Not asked: the signer declined / went quiet on an earlier Welcome of the
 * same batch, so this one is recorded the same way (one wait per batch). */
export class WelcomeSignerSkippedError extends Error {
  constructor(readonly reason: 'signerDenied' | 'signerTimeout') {
    super(
      `Welcome not signed: the signer ${reason === 'signerDenied' ? 'declined' : 'timed out'} on this invite`,
    );
    this.name = 'WelcomeSignerSkippedError';
  }
}

/** The people an invite didn't reach yet, and why (#1402). */
export interface InviteOutcome {
  undelivered: string[];
  /** …who publish no inbox relays yet. */
  waitingForRelays: string[];
  /** …whose Welcome our signer declined or didn't answer. */
  needsSigner: string[];
}

type PendingPayload = {
  groupId: string;
  rumor: Rumor;
  keyPackage: NostrEvent;
  /** The group's relays. Kept in the stored shape; never a Welcome destination
   * (the invitee reads them only after joining — see marmotWelcomeRelays). */
  relays: string[];
  queuedAt: number;
  /** Why the last attempt found nowhere to send it (#1402). */
  reason?: WelcomeWaitReason;
};

export class MarmotWelcomePayloads {
  private readonly deliveries = new Map<string, NostrWelcomeDelivery>();
  private readonly running = new Map<string, ReturnType<NostrWelcomeDelivery['deliver']>>();
  /** Payloads that had nowhere to go: when to try them again (in memory). */
  private readonly backoff = new Map<string, { at: number; delayMs: number }>();
  /** Welcome signatures run one at a time (the signer queue is serial anyway). */
  private signing: Promise<unknown> = Promise.resolve();
  /** Per chat: the signer declined / timed out at `at` (seconds); its Welcomes
   * queued no later aren't asked again until the user's next send (`retry`). */
  private readonly signerGaveUp = new Map<
    string,
    { reason: 'signerDenied' | 'signerTimeout'; at: number }
  >();

  constructor(
    private readonly backend: MarmotKvBackend,
    private readonly outbox: MarmotWelcomeOutbox,
    private readonly devices: MarmotDmDeviceSync,
    private readonly stopped: () => boolean,
    /** An invitee's NIP-65 read relays — a hint when they publish no 10050. */
    private readonly readRelays: (pubkey: string) => Promise<string[]> = async () => [],
  ) {}

  attach(group: Pick<MarmotGroup, 'idStr' | 'runtime'>): void {
    const delivery = group.runtime.welcomeDelivery;
    this.deliveries.set(group.idStr, delivery);
    delivery.deliver = async (options) => {
      const generation = this.generation(group.idStr);
      const item: PendingPayload = {
        groupId: group.idStr,
        rumor: delivery.createRumor(options),
        keyPackage: options.recipient.keyPackageEvent,
        relays: options.groupRelays,
        queuedAt: Math.floor(Date.now() / 1000),
      };
      // Persist before signing/encryption, including before a session stop.
      await this.prune();
      this.ensureCurrent(item.groupId, generation);
      await this.backend.set(NS, this.id(item), JSON.stringify(item));
      this.outbox.changes.notify(item.groupId);
      return this.send(item, delivery, generation);
    };
  }

  /** Drop expired / unreadable entries and make room for one more. */
  private async prune(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const live: { id: string; queuedAt: number }[] = [];
    for (const id of await this.backend.keys(NS)) {
      const raw = await this.backend.get(NS, id);
      let queuedAt: number | undefined;
      try {
        queuedAt = raw ? (JSON.parse(raw) as PendingPayload).queuedAt : undefined;
      } catch {
        queuedAt = undefined;
      }
      if (typeof queuedAt !== 'number' || now - queuedAt > WELCOME_OUTBOX_TTL_SECS) {
        await this.backend.remove(NS, id);
        this.backoff.delete(id);
      } else {
        live.push({ id, queuedAt });
      }
    }
    live.sort((a, b) => a.queuedAt - b.queuedAt);
    for (const entry of live.slice(
      0,
      Math.max(0, live.length - MAX_PENDING_WELCOME_PAYLOADS + 1),
    )) {
      await this.backend.remove(NS, entry.id);
      this.backoff.delete(entry.id);
    }
  }

  private id(item: PendingPayload): string {
    return `${item.groupId}:${item.keyPackage.id}`;
  }

  /** The chat's drop generation (shared with the signed queue): a delivery
   * started before a drop abandons its work at the next step, so a left /
   * removed chat's Welcome isn't signed, queued or published after all. */
  private generation(groupId: string): number {
    return this.outbox.generation(groupId);
  }

  /** Throws once the session stopped or `groupId` was dropped since `generation`. */
  private ensureCurrent(groupId: string, generation: number): void {
    if (this.stopped()) throw new Error('Marmot session stopped');
    if (this.generation(groupId) !== generation) throw new Error('Marmot invitation dropped');
  }

  private send(
    item: PendingPayload,
    delivery: NostrWelcomeDelivery,
    generation = this.generation(item.groupId),
  ) {
    const id = this.id(item);
    const existing = this.running.get(id);
    if (existing) return existing;
    const run = this.deliver(item, delivery, generation)
      .then(
        (response) => (this.backoff.delete(id), response),
        async (e: unknown) => {
          // Recorded before the invite reports back, so the session and the
          // member list can say why (not guess from an error message).
          if (e instanceof MarmotNoWelcomeRelaysError) await this.noteWaiting(id, item, e.reason);
          const signer = signerFailureReason(e);
          if (signer) await this.noteWaiting(id, item, signer);
          throw e;
        },
      )
      .finally(() => this.running.delete(id));
    this.running.set(id, run);
    return run;
  }

  /** Back off a Welcome with nowhere to go and record why. */
  private async noteWaiting(id: string, item: PendingPayload, reason: WelcomeWaitReason) {
    // Waiting on our signer: a fixed first step, so "you'll be asked again the
    // next time you send" holds after a minute. Lookups back off, doubling.
    this.backoff.set(id, nextRetryBackoff(signerReason(reason) ? undefined : this.backoff.get(id)));
    await this.recordReason(id, item, reason);
  }

  /** Persist `reason` on a still-queued payload (none: it has a destination now). */
  private async recordReason(id: string, item: PendingPayload, reason?: WelcomeWaitReason) {
    if (item.reason === reason || !(await this.backend.get(NS, id))) return;
    // `undefined` drops the field from the stored JSON.
    await this.backend.set(NS, id, JSON.stringify({ ...item, reason }));
    this.outbox.changes.notify(item.groupId);
  }

  /** Checked after every wait: a group dropped meanwhile (left, removed,
   * destroyed) stops here — before the signer is asked, before anything is
   * queued, before publishing (#1402). */
  private async deliver(item: PendingPayload, delivery: NostrWelcomeDelivery, generation: number) {
    const current = () => this.ensureCurrent(item.groupId, generation);
    current();
    // Decided before the signer is asked: with nowhere to send it, the payload
    // stays queued for a later retry and nobody is prompted for nothing (#1402).
    const relays = await welcomeRelays(delivery.network, item.keyPackage, this.readRelays);
    current();
    const signer = this.devices.observeSigner(delivery.signer, item.groupId, [item.keyPackage]);
    const event = await this.signInTurn(item, current, () =>
      GiftWrapFactory.create(signer, item.keyPackage.pubkey, item.rumor),
    );
    current();
    // Promote to the signed outbox before publishing: further retries need
    // no approval, and a thrown publish cannot lose the invitation either.
    await this.outbox.enqueue(
      item.groupId,
      [{ event, relays, recipient: item.keyPackage.pubkey }],
      generation,
    );
    await this.backend.remove(NS, this.id(item));
    if (this.generation(item.groupId) !== generation) {
      // Dropped while queueing: don't leave the wrap behind for retries.
      await this.outbox.remove(event.id);
      throw new Error('Marmot invitation dropped');
    }
    current();
    const response = await delivery.network.publish(relays, event);
    if (Object.values(response).some((r) => r.ok)) await this.outbox.remove(event.id);
    return response;
  }

  /**
   * One Welcome signature at a time. Once the signer declines or doesn't
   * answer one, the rest of that chat's Welcomes queued no later are recorded
   * the same way without asking: a silent bunker costs one wait per invite
   * batch, not one per device (#1402).
   */
  private signInTurn<T>(item: PendingPayload, current: () => void, sign: () => Promise<T>) {
    const run = this.signing.then(async (): Promise<T> => {
      current(); // dropped / stopped while waiting its turn
      const gaveUp = this.signerGaveUp.get(item.groupId);
      if (gaveUp && item.queuedAt <= gaveUp.at) throw new WelcomeSignerSkippedError(gaveUp.reason);
      try {
        return await sign();
      } catch (e) {
        const reason = signerFailureReason(e);
        const at = Math.floor(Date.now() / 1000);
        if (reason) this.signerGaveUp.set(item.groupId, { reason, at });
        throw e;
      }
    });
    this.signing = run.catch(() => undefined);
    return run;
  }

  /** Forget a group's queued Welcomes — with `outbox`, its signed ones too. */
  async drop(groupId: string, opts: { outbox?: boolean } = {}): Promise<void> {
    this.outbox.markDropped(groupId);
    this.deliveries.delete(groupId);
    for (const id of await this.backend.keys(NS)) {
      if (!id.startsWith(`${groupId}:`)) continue;
      await this.backend.remove(NS, id);
      this.backoff.delete(id);
    }
    if (opts.outbox) await this.outbox.drop(groupId);
    this.outbox.changes.notify(groupId);
  }

  /**
   * A user's open of / send in a chat (#1402): republish its signed Welcomes
   * and retry the ones still waiting for a signature or a destination. The
   * session only calls this from user actions (a remote signer only on a
   * send), so a signer prompt never comes out of nowhere. Never rejects.
   */
  retry(groupId: string): Promise<void> {
    this.signerGaveUp.delete(groupId); // the user's send: ask the signer again
    return Promise.all([this.outbox.flush(groupId), this.flush(groupId)]).then(
      () => undefined,
      () => undefined,
    );
  }

  /**
   * Background retries after session start and on each foreground resume,
   * staggered and cancelled by backgrounding (watchMarmotResume). Signed
   * Welcomes are republished either way. With `sign` (a local key, which
   * signs silently) queued ones are retried in full. Without it (Amber /
   * NIP-46) they are only re-checked — lookups, no signing — so the member
   * list's status stays true; a remote signer is asked only from a user
   * action in the chat (`retry`). Returns stop.
   */
  scheduleRetries(sign: boolean): () => void {
    const run = () => void this.retryAll(sign);
    const first = setTimeout(run, WELCOME_RETRY_DELAY_MS);
    const stopResume = watchMarmotResume(run);
    return () => {
      clearTimeout(first);
      stopResume();
    };
  }

  private retryAll(sign: boolean): Promise<void> {
    if (this.stopped()) return Promise.resolve();
    return Promise.all([this.outbox.flush(), sign ? this.flush() : this.recheck()]).then(
      () => undefined,
      () => undefined,
    );
  }

  /**
   * Re-decide every queued Welcome's destination and keep its recorded reason
   * current, without signing anything (remote signers' background pass).
   */
  private async recheck(): Promise<void> {
    for (const id of await this.backend.keys(NS)) {
      if (this.stopped()) return;
      if (Date.now() < (this.backoff.get(id)?.at ?? 0)) continue;
      let item: PendingPayload;
      try {
        item = JSON.parse((await this.backend.get(NS, id)) ?? 'null') as PendingPayload;
      } catch {
        continue; // unreadable: prune() drops it
      }
      const delivery = item && this.deliveries.get(item.groupId);
      // Waiting on our signer: only a user's send asks it again.
      if (!delivery || signerReason(item.reason)) continue;
      try {
        await welcomeRelays(delivery.network, item.keyPackage, this.readRelays);
        this.backoff.delete(id);
        await this.recordReason(id, item, undefined);
      } catch (e) {
        if (e instanceof MarmotNoWelcomeRelaysError) await this.noteWaiting(id, item, e.reason);
      }
    }
  }

  /** Per person, the status of their undelivered Welcomes into `groupId`. */
  async inviteStatus(groupId: string): Promise<Map<string, InviteStatus>> {
    const out = new Map<string, InviteStatus>();
    const note = (person: string, status: InviteStatus) => {
      const had = out.get(person);
      if (!had || STATUS_RANK[status] < STATUS_RANK[had]) out.set(person, status);
    };
    for (const w of await this.outbox.pending()) {
      if (w.groupIdHex === groupId) note(w.recipient.toLowerCase(), 'pending');
    }
    for (const item of await this.queued(groupId)) {
      const person = item.keyPackage.pubkey.toLowerCase();
      note(
        person,
        signerReason(item.reason)
          ? 'needsSigner'
          : item.reason === 'noRelays'
            ? 'waitingForRelays'
            : 'pending',
      );
    }
    return out;
  }

  /** `undelivered` with each person's reason, read from the queues. */
  async outcome(groupId: string, undelivered: string[]): Promise<InviteOutcome> {
    const status = await this.inviteStatus(groupId).catch(() => new Map<string, InviteStatus>());
    const by = (s: InviteStatus) => undelivered.filter((p) => status.get(p) === s);
    return {
      undelivered,
      waitingForRelays: by('waitingForRelays'),
      needsSigner: by('needsSigner'),
    };
  }

  private async queued(groupId: string): Promise<PendingPayload[]> {
    const items: PendingPayload[] = [];
    for (const id of await this.backend.keys(NS)) {
      if (!id.startsWith(`${groupId}:`)) continue;
      try {
        const raw = await this.backend.get(NS, id);
        if (raw) items.push(JSON.parse(raw) as PendingPayload);
      } catch {
        // unreadable: prune() drops it
      }
    }
    return items;
  }

  /** Remote signers call this only on send; local signers also retry on start/open. */
  async flush(groupId?: string): Promise<void> {
    for (const id of await this.backend.keys(NS)) {
      if (this.stopped()) return;
      // Check persisted state only once this capture owns the queue: an earlier
      // retry may have delivered the payload or recorded a signer refusal.
      await this.outbox
        .capture(async () => {
          if (this.stopped()) return;
          const raw = await this.backend.get(NS, id);
          if (!raw) return;
          let item: PendingPayload;
          try {
            item = JSON.parse(raw) as PendingPayload;
          } catch {
            await this.backend.remove(NS, id);
            this.backoff.delete(id);
            return;
          }
          if (Math.floor(Date.now() / 1000) - item.queuedAt > WELCOME_OUTBOX_TTL_SECS) {
            await this.backend.remove(NS, id);
            this.backoff.delete(id);
            return;
          }
          if (groupId && item.groupId !== groupId) return;
          if (this.devices.suppressesRetry(item.groupId, item.keyPackage.id)) return;
          if (Date.now() < (this.backoff.get(id)?.at ?? 0)) return;
          const delivery = this.deliveries.get(item.groupId);
          if (delivery) return this.send(item, delivery);
        })
        .catch(() => undefined);
    }
  }
}
