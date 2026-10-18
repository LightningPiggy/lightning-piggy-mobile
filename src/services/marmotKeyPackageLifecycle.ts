// Keeping this install's Marmot key package (kind 30443) fresh, and deciding
// how long the private material of the ones it replaces is kept.
//
//  - One publication slot (`d`) per account per install; every refresh reuses
//    it, so relays replace the old event instead of piling up stale ones.
//  - The key package is refreshed weekly (#1210) — or sooner, once half its
//    lifetime has passed — so it never silently expires on relays.
//  - Once a replacement is confirmed published, USED replaced secrets are
//    deleted at once (spec); UNUSED ones are kept until their own expiry
//    (`not_after`, at most 84 days), like MDK / White Noise — see the
//    retention policy on shouldDeleteReplacedKeyPackage.

import {
  getKeyPackageLifetime,
  GROUP_ENCRYPTED_MEDIA_V2_COMPONENT_ID,
  type KeyPackageManager,
} from '@internet-privacy/marmot-ts';
import type { EventSigner } from 'applesauce-core';
import type { Event as NostrEvent } from 'nostr-tools';

import { keyPackageSlotTimestamp, rememberKeyPackageTimestamp } from './marmotInstallationSlot';

export { ensureKeyPackageSlot } from './marmotInstallationSlot';

type ListedKeyPackage = Awaited<ReturnType<KeyPackageManager['list']>>[number];

const DAY_SECS = 24 * 60 * 60;
/** Refresh our published key package at least this often (#1210). */
export const KEY_PACKAGE_REFRESH_SECS = 7 * DAY_SECS;
/** Clock-skew grace before an expired key package's secret is dropped. */
const EXPIRY_GRACE_SECS = 60 * 60;
/**
 * Upper bound for keeping an UNUSED replaced key package whose lifetime we
 * can't read: MDK / White Noise's longest key package lifetime.
 */
export const UNUSED_REPLACED_KEY_MAX_RETENTION_SECS = 84 * DAY_SECS;
/** A valid `d` slot: 32 random bytes, hex (transports/nostr.md). */
export const SLOT_ID_HEX = /^[0-9a-f]{64}$/;

const MEDIA_V2_COMPONENT_TAG = `0x${GROUP_ENCRYPTED_MEDIA_V2_COMPONENT_ID.toString(16)}`;
/** White Noise requires every invitee to support encrypted media v2 (0x800b). */
export const advertisesMediaV2 = (events: NostrEvent[]) =>
  events.some((e) =>
    e.tags.some((t) => t[0] === 'app_components' && t.includes(MEDIA_V2_COMPONENT_TAG)),
  );

export interface KeyPackageLifetimeSecs {
  notBefore: number;
  notAfter: number;
}

/** The MLS lifetime of a stored key package, in unix seconds. */
export function keyPackageLifetime(kp: ListedKeyPackage): KeyPackageLifetimeSecs | undefined {
  const event = latestPublished(kp);
  const fromEvent = event ? getKeyPackageLifetime(event) : undefined;
  const leaf = kp.publicPackage?.leafNode as
    | { lifetime?: { notBefore: bigint; notAfter: bigint } }
    | undefined;
  const lifetime = fromEvent ?? leaf?.lifetime;
  if (!lifetime) return undefined;
  return { notBefore: Number(lifetime.notBefore), notAfter: Number(lifetime.notAfter) };
}

function latestPublished(kp: ListedKeyPackage): NostrEvent | undefined {
  const events = (kp.published ?? []) as NostrEvent[];
  return events.reduce<NostrEvent | undefined>(
    (newest, e) => (!newest || e.created_at > newest.created_at ? e : newest),
    undefined,
  );
}

/** When the key package was last published (unix seconds), if ever. */
export function publishedAt(kp: ListedKeyPackage): number | undefined {
  return latestPublished(kp)?.created_at;
}

/**
 * The key package peers should be inviting: this install's NEWEST published
 * one (in `slot`, when given) — undefined if there is none, or if that newest
 * one is consumed or not current-profile, so a new one must be published.
 * Deliberately not "the newest unused one": a retained older key package
 * must never hide that the one relays now advertise was just consumed.
 */
export function currentKeyPackage(
  list: ListedKeyPackage[],
  slot?: string,
): ListedKeyPackage | undefined {
  const newest = list
    .filter((kp) => publishedAt(kp) !== undefined)
    .filter(
      (kp) =>
        slot === undefined ||
        (kp.identifier ?? latestPublished(kp)?.tags.find((t) => t[0] === 'd')?.[1]) === slot,
    )
    .sort((a, b) => (publishedAt(b) ?? 0) - (publishedAt(a) ?? 0))[0];
  return newest && !newest.used && !newest.nonCurrent ? newest : undefined;
}

/** Whether `kp` is due a refresh: a week old, or past half its lifetime. */
export function needsRefresh(kp: ListedKeyPackage, nowSecs: number): boolean {
  const at = publishedAt(kp);
  if (at === undefined || nowSecs - at >= KEY_PACKAGE_REFRESH_SECS) return true;
  const lifetime = keyPackageLifetime(kp);
  if (!lifetime) return true;
  const half = lifetime.notBefore + (lifetime.notAfter - lifetime.notBefore) / 2;
  return nowSecs >= half;
}

const sameKeyPackage = (a: ListedKeyPackage, b: ListedKeyPackage) =>
  a.keyPackageRef.join() === b.keyPackageRef.join();

/**
 * RETENTION POLICY (Ben, #1230; extended on 2026-10-14 to match MDK / White
 * Noise): whether a key package that `current` (our newest published one in
 * the slot) replaced can lose its private material now.
 *
 * - USED (consumed) key packages follow the spec: deleted as soon as the
 *   replacement is confirmed published.
 * - UNUSED ones are kept until their own `not_after` (plus a clock-skew grace,
 *   handled by retiredKeyPackages) — at most 84 days. Relays and peers can keep
 *   serving the previous key package after our weekly refresh, and someone
 *   offline for a week may only now receive a Welcome made with it; deleting
 *   it would make that invite fail for good ("No matching key"). Keeping it
 *   until expiry stays within the spec's bound (foundation/key-packages.md:
 *   retention must not extend past the key package's lifetime).
 */
export function shouldDeleteReplacedKeyPackage(
  kp: ListedKeyPackage,
  current: ListedKeyPackage,
  nowSecs: number = Math.floor(Date.now() / 1000),
): boolean {
  const currentAt = publishedAt(current);
  if (sameKeyPackage(kp, current) || currentAt === undefined) return false; // no confirmed replacement
  const at = publishedAt(kp);
  // Newer than "current" (e.g. its publish failed): not replaced.
  if (at !== undefined && at > currentAt) return false;
  if (kp.used || at === undefined) return true;
  if (keyPackageLifetime(kp) !== undefined) return false; // expiry decides
  return nowSecs - at >= UNUSED_REPLACED_KEY_MAX_RETENTION_SECS;
}

/**
 * Key packages whose private material can go: past their lifetime, or replaced by `current` per the retention policy. `current` is
 * never returned; without one only expiry applies.
 */
export function retiredKeyPackages(
  list: ListedKeyPackage[],
  nowSecs: number,
  current?: ListedKeyPackage,
): ListedKeyPackage[] {
  return list.filter((kp) => {
    if (current && sameKeyPackage(kp, current)) return false;
    const lifetime = keyPackageLifetime(kp);
    if (lifetime !== undefined && nowSecs > lifetime.notAfter + EXPIRY_GRACE_SECS) return true;
    return current !== undefined && shouldDeleteReplacedKeyPackage(kp, current, nowSecs);
  });
}

/** Thrown when maintenance is abandoned because the session stopped. */
export class KeyPackageMaintenanceCancelled extends Error {
  constructor() {
    super('marmot: key package maintenance cancelled');
    this.name = 'KeyPackageMaintenanceCancelled';
  }
}

export interface MaintainKeyPackageOptions {
  relays: string[];
  /** This install's publication slot (`d`) for the account. */
  slot: string;
  client: string;
  /** Whether a published key package already advertises everything peers need. */
  isUpToDate: (published: NostrEvent[]) => boolean;
  /**
   * Whether at least one relay accepted a key-package event we just
   * published (see trackKeyPackageAcceptance). Undefined = not tracked.
   */
  wasAccepted?: (eventId: string) => boolean;
  /** Checked after every await: true once the session stopped (sign-out). */
  cancelled?: () => boolean;
  nowSecs?: number;
}

/**
 * Make sure peers can invite this install: publish a key package into our
 * slot when there is none, when ours is due its weekly refresh, or when it
 * lacks a capability peers require. Once the replacement is confirmed
 * published, retire what it replaced (retention policy above) and anything
 * expired. 'failed' when no relay accepted the replacement (nothing deleted).
 */
export async function maintainKeyPackage(
  keyPackages: KeyPackageManager,
  opts: MaintainKeyPackageOptions,
): Promise<'published' | 'unchanged' | 'failed'> {
  const now = opts.nowSecs ?? Math.floor(Date.now() / 1000);
  const step = async <T>(p: Promise<T>): Promise<T> => {
    const value = await p;
    if (opts.cancelled?.()) throw new KeyPackageMaintenanceCancelled();
    return value;
  };
  if (opts.cancelled?.()) throw new KeyPackageMaintenanceCancelled();
  const list = await step(keyPackages.list());
  // Upgrade from builds whose monotonic signer only remembered this session.
  for (const kp of list) {
    for (const event of kp.published ?? []) await step(rememberKeyPackageTimestamp(event));
  }
  let current = currentKeyPackage(list, opts.slot);
  const stale =
    !current ||
    needsRefresh(current, now) ||
    !opts.isUpToDate((current.published ?? []) as NostrEvent[]);
  let outcome: 'published' | 'unchanged' = 'unchanged';
  if (stale) {
    // NOT keyPackages.rotate(): that deletes the old private material at
    // once, before the replacement is known to have reached any relay.
    const created = await step(
      keyPackages.create({ relays: opts.relays, identifier: opts.slot, client: opts.client }),
    );
    const ref = created.keyPackageRef.join();
    const fresh = (await step(keyPackages.list())).find((kp) => kp.keyPackageRef.join() === ref);
    const event = fresh ? latestPublished(fresh) : undefined;
    if (!fresh || !event || (opts.wasAccepted && !opts.wasAccepted(event.id))) {
      // No relay took it: nobody can invite it. Keep everything else.
      await step(keyPackages.remove(created.keyPackageRef));
      return 'failed';
    }
    current = fresh;
    outcome = 'published';
  }
  // Only locally stored publication records establish ownership. Never
  // retire siblings discovered from public packages or a matching client tag.
  const all = await step(keyPackages.list());
  const legacy = all.filter(
    (kp) =>
      !sameKeyPackage(kp, current!) &&
      kp.published?.some((e) => e.tags.find((t) => t[0] === 'd')?.[1] !== opts.slot),
  );
  for (const kp of retiredKeyPackages(all, now, current)) {
    if (legacy.some((old) => sameKeyPackage(old, kp))) continue;
    // Same slot: replacement already retires the publication. A slot-wide
    // NIP-09 here would also delete the fresh key we just confirmed. Erase
    // these secrets before a legacy retirement can fail or await a signer.
    await step(keyPackages.remove(kp.keyPackageRef));
  }
  if (legacy.length > 0) {
    // A relay that rejects or ignores the NIP-09 retirement must not turn a
    // confirmed publication into a failed run: a manual Refresh would report
    // failure and (for local keys) the replenisher would retry every few
    // minutes. Keep the legacy rows — purge() leaves them when the deletion
    // isn't accepted — and retire them on the next scheduled maintenance.
    try {
      await step(keyPackages.purge(legacy.map((kp) => kp.keyPackageRef)));
    } catch (e) {
      if (e instanceof KeyPackageMaintenanceCancelled) throw e;
      if (opts.cancelled?.()) throw new KeyPackageMaintenanceCancelled();
      if (__DEV__) console.warn('[Marmot] legacy key package retirement deferred:', e);
    }
  }
  return outcome;
}

type PublishingNetwork = {
  publish(relays: string[], event: NostrEvent): Promise<Record<string, { ok: boolean }>>;
};

/** Record accepted kind-30443 events; a Map also retains destination acknowledgements. */
export function trackKeyPackageAcceptance<N extends PublishingNetwork>(
  network: N,
  accepted: Set<string> | Map<string, string[]>,
): N {
  return {
    ...network,
    async publish(relays: string[], event: NostrEvent) {
      const result = await network.publish(relays, event);
      const ok = Object.values(result).some((r) => r.ok);
      if (event.kind === 30443 && ok) {
        if (accepted instanceof Map)
          accepted.set(
            event.id,
            Object.entries(result)
              .filter(([, r]) => r.ok)
              .map(([url]) => url),
          );
        else accepted.add(event.id);
      }
      // purge() otherwise ignores relay rejection and drops the only local
      // ownership records. Keep legacy rows so the next maintenance retries.
      if (event.kind === 5 && !ok) throw new Error('marmot: key retirement not accepted');
      return result;
    },
  };
}

/**
 * Runs `task` one at a time. A request while it runs queues exactly ONE more
 * run (shared by every such request), so state that changed mid-run — e.g. a
 * key package spent by a join — is never missed.
 */
export class SingleFlight {
  private running: Promise<void> | null = null;
  private queued: Promise<void> | null = null;
  constructor(private readonly task: () => Promise<void>) {}

  /** The run (or queued rerun) in progress, if any. */
  get current(): Promise<void> | null {
    return this.queued ?? this.running;
  }

  run(): Promise<void> {
    if (!this.running) {
      this.running = this.task().finally(() => (this.running = null));
      return this.running;
    }
    const again = () => {
      this.queued = null;
      return this.run();
    };
    this.queued ??= this.running.then(again, again);
    return this.queued;
  }
}

/**
 * `signer`, but each kind-30443 event it signs is dated strictly after the
 * previous one in the same `d` slot. Relays keep the LOWER event id on a
 * same-second addressable replace, so a replacement published in the same
 * second as the key package it replaces (e.g. right after a join spent it)
 * could lose — and relays would keep advertising a key whose private
 * material we then delete.
 */
export function monotonicKeyPackageSigner(signer: EventSigner): EventSigner {
  const lastBySlot = new Map<string, number>();
  return {
    ...signer,
    signEvent: async (draft) => {
      const slot = draft.tags.find((t) => t[0] === 'd')?.[1];
      if (draft.kind !== 30443 || slot === undefined) return signer.signEvent(draft);
      const owner = await signer.getPublicKey();
      const persisted = await keyPackageSlotTimestamp(owner, slot);
      const createdAt = Math.max(draft.created_at, persisted + 1, (lastBySlot.get(slot) ?? 0) + 1);
      lastBySlot.set(slot, createdAt);
      const signed = await signer.signEvent({ ...draft, created_at: createdAt });
      await rememberKeyPackageTimestamp(signed);
      return signed;
    },
  };
}
