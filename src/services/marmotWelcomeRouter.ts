// The DM unwrap engine is the sole owner of kind-1059 inbox subscriptions.
// Route kind-444 BEFORE its DM follow gate; consent lives in encrypted MLS KV.
import { getEventHash } from 'nostr-tools';
import { t } from '../i18n';
import { MARMOT_WELCOME_KIND } from '../utils/dmProtocol';
import type { DecodedRumor } from '../utils/nip17Unwrap';
import { getMarmotSession, subscribeMarmotSession, type MarmotRumor } from './marmotSession';
import { MarmotPendingInvitations, type PendingMarmotInvitation } from './marmotPendingInvitations';
import { createSqliteMarmotBackend } from './marmotStore';
import { createStopGate, fenceBackend, trackStoppedSession } from './marmotSessionFence';
import { fireMessageNotification } from './notificationService';
import { claimWrapNotification } from './dmWrapNotificationDedupe';
import { getActivePubkey, subscribeActivePubkey } from './walletStorageService';

const controllers = new Map<string, MarmotPendingInvitations>();
const gates = new Map<string, ReturnType<typeof createStopGate>>();
const listeners = new Set<() => void>();
const snapshots = new Map<string, readonly PendingMarmotInvitation[]>();
const timers = new Map<string, ReturnType<typeof setTimeout>>();
type ResumeWork = { timer?: ReturnType<typeof setTimeout>; running: boolean; dirty: boolean };
const resumeWork = new Map<string, ResumeWork>();
export const EMPTY_INVITATIONS: readonly PendingMarmotInvitation[] = [];

function changed(owner: string) {
  if (timers.has(owner)) return;
  // Coalesce relay bursts before notifying React consumers.
  timers.set(
    owner,
    setTimeout(() => {
      timers.delete(owner);
      const current = controller(owner);
      void current
        .list()
        .then((invites) => {
          if (controllers.get(owner) !== current) return;
          snapshots.set(owner, invites);
          for (const listener of listeners) listener();
        })
        .catch(reportFailure);
    }, 150),
  );
}
function controller(owner: string): MarmotPendingInvitations {
  let c = controllers.get(owner);
  if (!c) {
    const gate = createStopGate();
    // Also fenced by the existing account-wipe lifecycle, including writes
    // initiated during the delayed Marmot session's cold-start window.
    trackStoppedSession(owner, gate);
    gates.set(owner, gate);
    c = new MarmotPendingInvitations(
      fenceBackend(createSqliteMarmotBackend(owner), gate),
      () => (controllers.get(owner) === c ? changed(owner) : undefined),
      (record) => {
        if (!claimWrapNotification(record.id) && !record.replacesContentlessAlert) return;
        void fireMessageNotification({
          owner,
          kind: 'group',
          threadId: `invite:${record.id}`,
          title: t('marmotInvitation.notification'),
          body: t('marmotInvitation.notification'),
          data: { groupInvitation: true, senderPubkey: record.rumor.pubkey },
        }).catch(reportFailure);
      },
    );
    controllers.set(owner, c);
  }
  return c;
}
function reportFailure(error: unknown) {
  if (__DEV__) console.warn('[Marmot] invitation processing failed:', error);
}
function sessionFor(owner: string) {
  const session = getMarmotSession();
  const activeOwner = getActivePubkey();
  return session?.pubkey === owner && (!activeOwner || activeOwner === owner) ? session : null;
}
function resume(owner: string) {
  if (!sessionFor(owner)) return;
  let work = resumeWork.get(owner);
  if (!work) {
    work = { running: false, dirty: false };
    resumeWork.set(owner, work);
  }
  work.dirty = true;
  if (work.running || work.timer) return;
  const currentWork = work;
  currentWork.timer = setTimeout(() => {
    currentWork.timer = undefined;
    currentWork.dirty = false;
    const session = sessionFor(owner);
    if (!session) return;
    const current = controller(owner);
    currentWork.running = true;
    void current
      .resume(session, () => controllers.get(owner) === current && sessionFor(owner) === session)
      .catch(reportFailure)
      .finally(() => {
        currentWork.running = false;
        // Deliveries during MLS work request one follow-up pass, never one
        // queued namespace scan per wrap. Retired owners cannot re-arm work.
        if (resumeWork.get(owner) === currentWork && currentWork.dirty) resume(owner);
      });
  }, 150);
}
function cancelResume(owner: string) {
  clearTimeout(resumeWork.get(owner)?.timer);
  resumeWork.delete(owner);
}

/**
 * True for any Welcome (including own/malformed ones): never send it to DM
 * storage. `followed` no longer decides anything: every invitation waits for
 * the user (kept so the ingest paths' calls don't change).
 */
export async function routeMarmotWelcome(
  rumor: DecodedRumor,
  owner: string,
  wrapId: string,
  followed: boolean,
  isFresh = false,
  shouldAbort: () => boolean = () => false,
  replacesContentlessAlert = false,
): Promise<boolean> {
  if (rumor.kind !== MARMOT_WELCOME_KIND) return false;
  if (shouldAbort() || rumor.pubkey.toLowerCase() === owner.toLowerCase()) return true;
  let full: MarmotRumor;
  try {
    full = { ...rumor, id: getEventHash(rumor) };
  } catch {
    return true;
  }
  await controller(owner).receive(wrapId, full, isFresh, replacesContentlessAlert);
  if (shouldAbort()) return true;
  // Do not hold the relay decrypt queue while MLS starts or joins.
  resume(owner);
  return true;
}
export function getPendingMarmotInvitations(owner: string | null) {
  return (owner && snapshots.get(owner)) || EMPTY_INVITATIONS;
}
export function subscribePendingMarmotInvitations(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function loadPendingMarmotInvitations(owner: string) {
  changed(owner);
}
export async function acceptMarmotInvitation(owner: string, id: string) {
  const session = sessionFor(owner);
  if (!session) throw new Error('marmot: session not ready');
  const current = controller(owner);
  const group = await current.accept(id, session, () => sessionFor(owner) === session);
  if (!group && (await current.list()).some((r) => r.id === id && r.error))
    throw new Error('marmot: invitation is no longer usable');
  return group;
}
export function declineMarmotInvitation(owner: string, id: string) {
  return controller(owner).decline(id);
}

let previousOwner: string | null = null;
subscribeMarmotSession((session) => {
  if (previousOwner && previousOwner !== session?.pubkey) {
    snapshots.delete(previousOwner);
    controllers.delete(previousOwner);
    cancelResume(previousOwner);
    gates.get(previousOwner)?.fence();
    gates.delete(previousOwner);
    const timer = timers.get(previousOwner);
    if (timer) clearTimeout(timer);
    timers.delete(previousOwner);
    for (const listener of listeners) listener();
  }
  previousOwner = session?.pubkey ?? null;
  if (!session) return;
  changed(session.pubkey);
  resume(session.pubkey);
});

// Account changes can precede the delayed Marmot session (including logout
// before it starts). Retire cold-start controllers too, preventing stale
// snapshots or fenced controllers being reused on the next login.
subscribeActivePubkey?.((owner) => {
  for (const oldOwner of controllers.keys()) {
    if (oldOwner === owner) continue;
    gates.get(oldOwner)?.fence();
    gates.delete(oldOwner);
    controllers.delete(oldOwner);
    cancelResume(oldOwner);
    snapshots.delete(oldOwner);
    const timer = timers.get(oldOwner);
    if (timer) clearTimeout(timer);
    timers.delete(oldOwner);
  }
  for (const listener of listeners) listener();
});
