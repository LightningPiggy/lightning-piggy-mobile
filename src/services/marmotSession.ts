import { maintainDiscoverableKeyPackage } from './marmotKeyPackageDiscovery';
import { previewInvitationWelcome } from './marmotInvitationPreview';
// One Marmot (MLS-over-Nostr) client per signed-in account.
//
// Owns the marmot-ts `MarmotClient`: loads + connects every group, keeps an
// unused key package published, and exposes the handful of operations the
// app needs (send, create DM/group, invite, remove, rename, set admins,
// leave, accept an invite). Decrypted application messages are fanned out to
// listeners as plain rumors — `marmotInbox` decides where they're stored.
//
// Conventions shared with White Noise (interop):
//   - a DM is a 2-member group with an EMPTY name where both people are admins;
//   - chat text is kind 9 (Marmot's default chat kind);
//   - key packages (kind 30443) live on NIP-65 + well-known Marmot relays;
//     Welcomes are gift-wrapped to the invitee's kind-10050 inbox relays.

import {
  MarmotClient,
  createApplicationMessageIntent,
  deserializeApplicationData,
  getGroupMembers,
  getPubkeyLeafNodeIndexes,
  Proposals,
  GroupRumorHistory,
  type MarmotGroup,
} from '@internet-privacy/marmot-ts';
import type { EventSigner } from 'applesauce-core';
import { bytesToHex } from '@noble/hashes/utils.js';
import { type Event as NostrEvent } from 'nostr-tools';
import { buildMarmotRumor } from './marmotRumor';
import { getInstallationSignatureKeyPair } from './marmotSignatureKey';

import type { SignerType } from '../types/nostr';
import { LastAdminError, normaliseAdmins } from '../utils/groupAdmins';
import { installMarmotCryptoProvider, marmotCryptoProvider } from './marmotCryptoProvider';
import {
  candidateMediaStates,
  encryptMarmotMedia,
  allAttachments,
  type MarmotMediaKeys,
} from './marmotMedia';
import { forgetMarmotDeletionsForGroup } from './marmotDeletionStore';
import { forgetMediaKeys, loadOrDeriveMediaKeys, rememberMediaKeys } from './marmotMediaKeyStore';
import {
  advertisesMediaV2,
  ensureKeyPackageSlot,
  monotonicKeyPackageSigner,
  SingleFlight,
  trackKeyPackageAcceptance,
} from './marmotKeyPackageLifecycle';
import { startPendingWelcomeRetries } from './marmotPendingWelcomes';
import { retryPendingRetirement } from './marmotKeyPackageRetire';
import { MarmotDeviceTracker } from './marmotDeviceTracker';
import { MarmotDmDeviceSync } from './marmotDmDeviceSync';
import { installMarmotSameClientRule } from './marmotSameClient';
import {
  fetchDevices,
  fetchKeyPackageEvents,
  inviteDevices,
  MarmotWelcomeDeliveryError,
  resolveInvitees,
} from './marmotInvitees';
import { KeyPackageRefreshRequests } from './marmotKeyRefresh';
import { KeyPackageReplenisher } from './marmotKeyPackageReplenisher';
import { alignCommitForMdk, spreadProposals } from './marmotProposals';
import { MarmotWelcomeOutbox } from './marmotWelcomeOutbox';
import { MarmotWelcomePayloads } from './marmotWelcomePayloads';
import { boundGroupQueries } from './marmotGroupBackfill';
import { createMarmotGroupConnections } from './marmotGroupConnections';
import { submitWhenSettled, type GroupSendIntent } from './marmotSendGate';
import { marmotSendReceipt, type MarmotSendReceipt } from './marmotSendReceipt';
import { createMarmotNetwork, createPushTransport } from './marmotNetwork';
import {
  PUSH_TOKEN_LIST_KIND,
  PUSH_TOKEN_REMOVAL_KIND,
  PUSH_TOKEN_UPDATE_KIND,
  PUSH_TRIGGERING_KINDS,
} from './marmotPush';
import type { SignedProof } from './marmotPushEntries';
import { MarmotPushNotifier, toPushGroup } from './marmotPushNotifier';
import { MarmotPushRegistrar } from './marmotPushRegistrar';
import { isMarmotMessageKind } from './marmotKinds';
import { noteMarmotCommit, noteMarmotGroupTraffic, setMarmotCatchingUp } from './marmotPushWake';
import { createMarmotSigner } from './marmotSigner';
import * as fence from './marmotSessionFence';
import { MarmotWelcomeJoin } from './marmotWelcomeJoin';
import {
  loadFailedInvites,
  reverifyWelcomeOutcomes,
  type KeyPackageLookup,
} from './marmotWelcomeOutcomes';
import { clearFailedMarmotInvites, publishFailedMarmotInvites } from './marmotFailedInvitesStore';
import {
  createMarmotKvStore,
  createSqliteMarmotBackend,
  type MarmotKvBackend,
} from './marmotStore';
import { isTransientMarmotKind, transientFreeHistoryFactory } from './marmotTransientRumors';
import type { Rumor } from 'applesauce-common/helpers/gift-wrap';

export { buildMarmotRumor } from './marmotRumor';

/** Marmot's default chat-message kind (foundation/application-messages.md). */
export const MARMOT_CHAT_KIND = 9;
/** App-level group id prefix, distinguishing Marmot groups from NIP-17 ones. */
export const MARMOT_GROUP_ID_PREFIX = 'marmot:';
/** Marks our key packages (`client` tag) — NOT the slot id; see ensureKeyPackageSlot. */
const CLIENT_NAME = 'Lightning Piggy';
const DELIVERED_CACHE_SIZE = 2_000;
// Startup replay window + retained history per group (see replayHistory).
const HISTORY_REPLAY_SECS = 7 * 24 * 60 * 60;
const HISTORY_KEEP = 500;
const historyNamespace = (groupIdHex: string) => `history:${groupIdHex}`;
type SessionGroup = MarmotGroup<GroupRumorHistory>;
type CommitProposals = ReturnType<typeof spreadProposals>;
// Sign-out waits at most this long for an in-flight key-package publish.
const KEY_PACKAGE_DRAIN_MS = 5_000;
// A manual Refresh gives up after this (one run ahead of it + a signer prompt).
const KEY_PACKAGE_REFRESH_TIMEOUT_MS = 90_000;

export interface MarmotRumor {
  id: string;
  pubkey: string;
  created_at: number;
  kind: number;
  tags: string[][];
  content: string;
}

export interface MarmotGroupSummary {
  /** App group id: `marmot:<mls group id hex>`. */
  id: string;
  name: string;
  description: string;
  /** Members other than the viewer. */
  memberPubkeys: string[];
  adminPubkeys: string[];
  /** White Noise DM convention: two members, empty name. */
  isDm: boolean;
  /** Relays the group's kind-445 traffic is published to. */
  relays: string[];
  /** When this device first saw the group (ms) — MLS carries no creation time. */
  createdAt: number;
}

export interface MarmotMessageEvent {
  group: MarmotGroupSummary;
  rumor: MarmotRumor;
  /** File keys for the rumor's photos (MIP-04), derived when it arrived. */
  mediaKeys?: MarmotMediaKeys;
}

export interface MarmotSessionListener {
  onMessage?: (event: MarmotMessageEvent) => void;
  onGroupsChanged?: (groups: MarmotGroupSummary[]) => void;
  /** Invitations sent so far (each one is a signer approval on Amber / NIP-46). */
  onInviteProgress?: (progress: { done: number; total: number }) => void;
}

export interface MarmotSessionOptions {
  pubkey: string;
  signerType: SignerType;
  /** The viewer's NIP-65 write relays (key packages + new groups live here). */
  getWriteRelays: () => string[];
  /** Relays to look up other users' relay lists on. */
  getLookupRelays: () => string[];
  /** Test seam: defaults to the SQLCipher-backed store + the shared pool. */
  backend?: MarmotKvBackend;
  signer?: EventSigner;
  network?: ReturnType<typeof createMarmotNetwork>;
  /** Test seam: kind-445 backfill page size (default 500). */
  groupBackfillPageSize?: number;
  /** Test seam: sign-out's wait for a key-package publish (default 5 s). */
  keyPackageDrainMs?: number;
  /** Test seam: a send's wait for adding a 1:1's new devices (default 5 s). */
  dmDeviceSyncWaitMs?: number;
}

export const toAppGroupId = (mlsGroupIdHex: string) => `${MARMOT_GROUP_ID_PREFIX}${mlsGroupIdHex}`;
export const isMarmotGroupId = (id: string) => id.startsWith(MARMOT_GROUP_ID_PREFIX);
const toMlsGroupId = (appGroupId: string) => appGroupId.slice(MARMOT_GROUP_ID_PREFIX.length);

export class MarmotSession {
  readonly pubkey: string;
  private readonly opts: MarmotSessionOptions;
  private readonly backend: MarmotKvBackend;
  private readonly client: MarmotClient<GroupRumorHistory>;
  private readonly listeners = new Set<MarmotSessionListener>();
  private readonly wiredGroups = new Set<string>();
  private readonly watermarks = new Map<string, number>();
  private readonly firstSeen = new Map<string, number>();
  private readonly creatingDms = new Map<string, Promise<MarmotGroupSummary>>();
  private readonly welcomeJoins: MarmotWelcomeJoin;
  private readonly deliveredRumors = new Set<string>();
  private readonly push: MarmotPushNotifier;
  private readonly outbox: MarmotWelcomeOutbox;
  private readonly welcomePayloads: MarmotWelcomePayloads;
  /** MIP-05: announcing THIS device's push token in our groups. */
  readonly pushRegistration: MarmotPushRegistrar;
  private stopWelcomeRetries: (() => void) | null = null;
  private readonly connection = createMarmotGroupConnections(() =>
    this.client.groups.connectAll({ fallbackRelays: this.opts.getWriteRelays() }),
  );
  // Single-flight: start-up, resume, a new chat and a join can all ask at
  // once; one asking mid-run (e.g. a join just spent our key) gets a rerun.
  private readonly keyPackageRuns = new SingleFlight(() => this.maintainKeyPackages());
  // Hands this account's failed invites to the Messages UI (#1269); one
  // reload at a time, so an older read can't overwrite a newer one.
  private readonly failedInvites = new SingleFlight(async () => {
    const invites = await loadFailedInvites(this.backend).catch(() => null);
    if (invites && !this.gate.stopped) publishFailedMarmotInvites(this.pubkey, invites);
  });
  private readonly gate = fence.createStopGate();
  private readonly acceptedKeyPackages = new Map<string, string[]>();
  private readonly refreshes = new KeyPackageRefreshRequests();
  private readonly replenisher = new KeyPackageReplenisher(() => this.ensureKeyPackage());
  /** Each chat's devices per person (#1267) — read-only over group state. */
  readonly devices: MarmotDeviceTracker;
  /** Adds devices installed since a 1:1 began (#1559). */
  private readonly dmDevices: MarmotDmDeviceSync;
  private markReady!: () => void;
  /** Resolves once stored groups are loaded — joins must not race loadAll. */
  readonly ready = new Promise<void>((resolve) => (this.markReady = resolve));

  constructor(opts: MarmotSessionOptions) {
    installMarmotCryptoProvider();
    installMarmotSameClientRule(); // a device per install, not per account (#1559)
    this.opts = opts;
    this.pubkey = opts.pubkey;
    const backend = opts.backend ?? createSqliteMarmotBackend(opts.pubkey);
    this.backend = fence.fenceBackend(backend, this.gate); // drops writes after a wipe

    const store = <T>(ns: string) => createMarmotKvStore<T>(this.backend, ns);
    this.outbox = new MarmotWelcomeOutbox(this.backend, () => this.gate.stopped);
    const network = this.outbox.wrapNetwork(
      opts.network ??
        createMarmotNetwork(opts.getLookupRelays, this.connection.reconnect, opts.pubkey),
    );
    this.push = new MarmotPushNotifier({
      pubkey: opts.pubkey,
      backend: this.backend,
      // Tests inject a fake network; the app uses strict relay access.
      transport: opts.network
        ? {
            publish: async (relays, event) => void (await network.publish(relays, event)),
            inboxRelays: (pk) => network.getUserInboxRelays(pk),
          }
        : createPushTransport(opts.getLookupRelays, opts.pubkey),
    });
    const signer = opts.signer ?? createMarmotSigner(opts.pubkey, opts.signerType);
    this.pushRegistration = new MarmotPushRegistrar({
      pubkey: opts.pubkey,
      silentSigner: opts.signerType === 'nsec',
      backend: this.backend,
      // A previous session of this account (A → B → A) may still be
      // finishing a publish + write: wait for it before planning anything.
      ready: Promise.all([this.ready, pushDrains.get(opts.pubkey)?.catch(() => undefined)]).then(
        () => undefined,
      ),
      groups: () =>
        this.client.groups.loaded
          .filter((g) => g.status === 'active')
          .map((g) => ({ ...toPushGroup(g), ownLeaf: g.state.privatePath.leafIndex })),
      sign: (template) => signer.signEvent(template) as Promise<SignedProof>,
      send: async (idHex, event) => {
        const rumor = buildMarmotRumor(this.pubkey, event);
        return Object.values(await this.sendRumor(toAppGroupId(idHex), rumor)).some(Boolean);
      },
    });
    // Abandoned on stop: a late Amber / NIP-46 answer can't publish after sign-out.
    const cancelled = () => this.gate.stopped;
    const clientSigner =
      opts.signer ?? createMarmotSigner(this.pubkey, opts.signerType, { cancelled });
    this.dmDevices = new MarmotDmDeviceSync({
      self: opts.pubkey,
      backend: this.backend,
      fetchKeyPackages: (pk) => fetchKeyPackageEvents(network, opts.getLookupRelays(), pk),
      groupState: async (mlsId) => (await this.client.groups.get(mlsId)).state,
      invite: (mlsId, devices) => this.inviteAll(mlsId, devices, { partial: true }),
      silentSigner: opts.signerType === 'nsec',
      stopped: () => this.gate.stopped,
      sendWaitMs: opts.dmDeviceSyncWaitMs,
    });
    this.client = new MarmotClient({
      signer: fence.fenceSigner(monotonicKeyPackageSigner(clientSigner), this.gate),
      network: boundGroupQueries(trackKeyPackageAcceptance(network, this.acceptedKeyPackages), {
        watermarks: this.watermarks,
        persist: (h, createdAt) => void this.backend.set('watermark', h, String(createdAt)),
        pageSize: opts.groupBackfillPageSize,
        onLive: (h) => this.noteGroupLive(h),
      }),
      cryptoProvider: marmotCryptoProvider,
      getSignatureKeyPair: async (ciphersuite) => {
        const slot = await this.installationSlot();
        return this.gate.guard(getInstallationSignatureKeyPair(this.pubkey, slot, ciphersuite));
      },
      groupStateStore: store('groups'),
      keyPackageStore: store('keyPackages'),
      inviteStore: store('invites'),
      lifecycleStore: store('lifecycle'),
      ingestStateStore: store('ingest'),
      rewindStore: store('rewind'),
      removedMarkerStore: store('removed'),
      // Durable per-group message history: the safety net that makes delivery
      // survive the app dying between MLS processing and our own store write.
      // Live-location updates (#1300) are kept out of it (see marmotTransientRumors).
      historyFactory: transientFreeHistoryFactory((groupId) =>
        store<Rumor>(historyNamespace(bytesToHex(groupId))),
      ),
    });
    this.welcomePayloads = new MarmotWelcomePayloads(
      this.backend,
      this.outbox,
      this.dmDevices,
      cancelled,
    );
    this.welcomeJoins = new MarmotWelcomeJoin({
      client: this.client,
      backend: this.backend,
      stopped: () => this.gate.stopped,
      onJoined: () => this.replenisher.request(),
      onFinished: () => void this.failedInvites.run(),
      keyPackageLookup: () => this.keyPackageLookup(),
    });
    this.devices = new MarmotDeviceTracker({
      backend: this.backend,
      groups: () => this.client.groups.loaded,
      fetchKeyPackages: (pk) => fetchKeyPackageEvents(network, opts.getLookupRelays(), pk),
      ownClient: CLIENT_NAME,
    });
  }

  /** Load + connect every stored group, then keep a key package published. */
  async start(): Promise<void> {
    const groups = this.client.groups;
    for (const evt of ['created', 'joined', 'loaded', 'imported'] as const) {
      groups.on(evt, (g) => {
        this.wireGroup(g);
        this.emitGroupsChanged();
      });
    }
    for (const evt of ['left', 'removed', 'destroyed', 'disbanded'] as const) {
      groups.on(evt, (id: Uint8Array, ..._rest: unknown[]) => {
        // We're out of it: forget what we published there (MIP-05 state)
        // and its "delete for everyone" tombstones.
        this.pushRegistration.forgetGroup(bytesToHex(id));
        void this.welcomePayloads.drop(bytesToHex(id)).catch(() => undefined);
        void forgetMarmotDeletionsForGroup(this.pubkey, toAppGroupId(bytesToHex(id))).catch(
          () => undefined,
        );
        this.emitGroupsChanged();
      });
    }
    groups.on('unloaded', () => this.emitGroupsChanged());
    try {
      // Inside the try: a store failure must still open the `ready` gate, or
      // every send/join awaiting it would hang instead of erroring.
      await this.loadWatermarks();
      const loaded = await groups.loadAll();
      loaded.forEach((g) => this.wireGroup(g));
      for (const g of loaded) {
        await this.replayHistory(g).catch((e) => {
          if (__DEV__) console.warn('[Marmot] history replay failed:', e);
        });
      }
    } finally {
      this.markReady();
    }
    if (this.gate.stopped) return;
    // Push placeholders wait until every loaded group's backfill has drained.
    this.groupsToCatchUp = groups.loaded.length;
    setMarmotCatchingUp(this.pubkey, groups.loaded.length > 0);
    this.connection.start();
    this.emitGroupsChanged();
    // Publishing a key package needs a signature. Local keys sign silently;
    // Amber / NIP-46 would prompt on every app start for an Alpha feature the
    // user may never open — so for them it waits for first Marmot use (or an
    // account that has used Marmot before and needs its package kept fresh).
    void this.keepKeyPackageFresh();
    this.stopWelcomeRetries = startPendingWelcomeRetries(this.backend, (w) =>
      this.acceptWelcome(w),
    );
    void this.outbox.flush().catch(() => undefined);
    if (this.opts.signerType === 'nsec') void this.welcomePayloads.flush().catch(() => undefined);
    void this.failedInvites.run();
    void this.keyPackageLookup()
      .then((lookup) => reverifyWelcomeOutcomes(this.backend, lookup))
      .then((changed) => (changed ? this.failedInvites.run() : undefined))
      .catch(() => undefined);
  }

  /** Read-only preview: does not join or consume the invitation key. */
  async previewWelcome(rumor: MarmotRumor) {
    await this.ready;
    return previewInvitationWelcome(this.client, rumor);
  }

  stop(): void {
    this.gate.stop();
    this.stopWelcomeRetries?.();
    this.replenisher.stop();
    clearFailedMarmotInvites(this.pubkey);
    const run = this.keyPackageRuns.current;
    const pushStopped = Promise.all([this.push.stop(), this.pushRegistration.stop()]);
    fence.trackStoppedSession(this.pubkey, this.gate);
    // Accumulated: an earlier session of the same account (A → B → A) may
    // still be finishing a write the wipe must wait for. A key-package run
    // only gets a bounded wait — its signer was just abandoned.
    const drainMs = this.opts.keyPackageDrainMs ?? KEY_PACKAGE_DRAIN_MS;
    pushDrains.set(
      this.pubkey,
      Promise.all([
        pushDrains.get(this.pubkey),
        fence.settleWithin(run, drainMs),
        pushStopped,
      ]).then(() => undefined),
    );
    this.connection.unsubscribe();
    for (const g of this.client.groups.loaded) {
      g.removeAllListeners('applicationMessage');
      g.removeAllListeners('stateChanged');
    }
    this.listeners.clear();
  }

  refreshRelaySubscriptions = () => this.connection.reconnect();
  subscribe(listener: MarmotSessionListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Publish an unused key package so others can start chats with us. */
  ensureKeyPackage(): Promise<void> {
    return this.gate.stopped ? Promise.resolve() : this.keyPackageRuns.run();
  }

  /** Manual Refresh (#1236): publish a new key package now. True once a relay took it. */
  refreshInvitationKey(): Promise<boolean> {
    if (this.gate.stopped) return Promise.resolve(false);
    const answer = this.refreshes.request(KEY_PACKAGE_REFRESH_TIMEOUT_MS);
    void this.keyPackageRuns.run(); // queues behind a run in flight, never beside it
    return this.gate.guard(answer);
  }

  /** Start-up / app resume: refresh, but never a first remote-signer prompt. */
  async keepKeyPackageFresh(): Promise<void> {
    if (this.opts.signerType === 'nsec' || (await this.client.keyPackages.count()) > 0) {
      await this.ensureKeyPackage();
    }
  }

  private async maintainKeyPackages(): Promise<void> {
    if (this.gate.stopped) return; // a rerun queued before sign-out
    const refresh = this.refreshes.claim(); // a manual Refresh forces a publish
    try {
      // Weekly maintenance also updates key-package relay discovery when changed.
      const cancelled = () => this.gate.stopped;
      const slot = await this.installationSlot();
      const outcome = await maintainDiscoverableKeyPackage(this.client, this.backend, this.pubkey, {
        relays: this.writeRelays(),
        slot,
        client: CLIENT_NAME,
        isUpToDate: refresh.forced ? () => false : advertisesMediaV2,
        wasAccepted: (id) => this.acceptedKeyPackages.has(id),
        acceptedRelays: (id) => this.acceptedKeyPackages.get(id) ?? [],
        cancelled,
      });
      refresh.settle(outcome === 'published');
      if (outcome === 'failed') this.retryReplenish();
      else this.replenisher.resetBackoff();
      // A sign-out of this account here whose relay cleanup failed: retry it
      // now the account's signer is back (and already in use).
      await retryPendingRetirement({
        owner: this.pubkey,
        keepSlot: slot,
        cancelled,
        sign: (t) => this.client.signer.signEvent(t) as Promise<NostrEvent>,
      });
    } catch (e) {
      refresh.settle(false); // no-op if it already succeeded
      this.retryReplenish();
      if (__DEV__) console.warn('[Marmot] key package publish failed:', e);
    }
  }

  /**
   * Retry a failed publish with backoff — for local keys only. A remote
   * signer (Amber / NIP-46) must sign each attempt, so a loop would re-prompt
   * the user every 30 s–5 min while offline or after they dismissed it; those
   * accounts wait for the next trigger (join, resume, start) as before.
   */
  private retryReplenish(): void {
    if (this.opts.signerType === 'nsec') this.replenisher.retry();
  }

  /** This install's kind-30443 `d` slot for this account (survives sign-out). */
  private installationSlot(): Promise<string> {
    return this.gate.guard(ensureKeyPackageSlot(this.backend, this.pubkey, this.opts.backend));
  }

  listGroups(): MarmotGroupSummary[] {
    return this.client.groups.loaded
      .filter((g) => g.status === 'active')
      .map((g) => this.summarise(g));
  }

  getGroup(appGroupId: string): MarmotGroupSummary | undefined {
    return this.listGroups().find((g) => g.id === appGroupId);
  }

  /** The DM group with `peer`, if one exists. */
  findDm(peer: string): MarmotGroupSummary | undefined {
    const p = peer.toLowerCase();
    // Newest wins: if the peer lost their MLS state (reinstall, new device)
    // and started a fresh DM, the old group is a dead end they can't read.
    return this.listGroups()
      .filter((g) => g.isDm && g.memberPubkeys[0] === p)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
  }

  /** Whether `peer` has published a Marmot key package we could invite. */
  async canMessage(peer: string): Promise<boolean> {
    const lookup = this.opts.getLookupRelays();
    return (await fetchDevices(this.client.network, lookup, peer).catch(() => [])).length > 0;
  }

  async getOrCreateDm(peer: string): Promise<MarmotGroupSummary> {
    // Stored groups must be loaded first, or an existing DM is missed and a
    // duplicate MLS group gets created for the same peer.
    await this.ready;
    const p = peer.toLowerCase();
    const existing = this.findDm(p);
    if (existing) return existing;
    // Single-flight per peer: creating + inviting takes several relay round
    // trips, and a second quick send must not create a second DM group.
    const inFlight = this.creatingDms.get(p);
    if (inFlight) return inFlight;
    const creating = this.createGroup('', [p], { adminPubkeys: [this.pubkey, p] }).finally(() =>
      this.creatingDms.delete(p),
    );
    this.creatingDms.set(p, creating);
    return creating;
  }

  async createGroup(
    name: string,
    members: string[],
    opts: { description?: string; adminPubkeys?: string[] } = {},
  ): Promise<MarmotGroupSummary & { undelivered: string[] }> {
    await this.ready;
    // First Marmot use: become reachable ourselves BEFORE resolving the
    // invitees — otherwise two remote-signer accounts that both deferred
    // publishing could never bootstrap a chat (each fails on the other's
    // missing key package). Not awaited: the invite doesn't depend on it.
    void this.ensureKeyPackage();
    // Resolve every invitee's devices first so a missing one fails before we
    // create an orphan group. Every device of each person, 1:1s included.
    const devices = await this.invitees(members);
    const group = await this.client.groups.create(name, {
      description: opts.description ?? '',
      relays: this.writeRelays(),
      adminPubkeys: opts.adminPubkeys ?? [this.pubkey],
    });
    try {
      const { undelivered } = await this.inviteAll(group.idStr, devices);
      // Nobody can join: drop it so a retry starts clean (no queued Welcomes).
      if (undelivered.length === devices.size) throw new MarmotWelcomeDeliveryError(undelivered);
      return { ...this.summarise(group), undelivered };
    } catch (e) {
      // Don't leave an empty, invisible group (and its relay sub) behind —
      // a retry would otherwise create another one each time.
      await this.client.groups.destroy(group.id).catch(() => undefined);
      await this.outbox.drop(group.idStr).catch(() => undefined);
      await this.welcomePayloads.drop(group.idStr).catch(() => undefined);
      this.emitGroupsChanged();
      throw e;
    }
  }

  /** Invite `members`' devices; resolves with the people not reached yet
   * (their invitations are retried automatically — no re-invite needed). */
  async addMembers(appGroupId: string, members: string[]): Promise<string[]> {
    const devices = await this.invitees(members);
    const { undelivered } = await this.inviteAll(toMlsGroupId(appGroupId), devices);
    this.emitGroupsChanged();
    return undelivered;
  }

  private async inviteAll(
    mlsId: string,
    devices: Map<string, NostrEvent[]>,
    opts: { partial?: boolean } = {},
  ) {
    const progress = (done: number, total: number) =>
      this.listeners.forEach((l) => l.onInviteProgress?.({ done, total }));
    const groups = {
      get: (id: string) => this.client.groups.get(id),
      send: (id: string, intent: GroupSendIntent) => this.sendIntent(id, intent),
    };
    void this.devices.rememberKeyPackages([...devices.values()].flat()).catch(() => undefined);
    const result = await inviteDevices(
      groups,
      this.outbox,
      mlsId,
      this.pubkey,
      devices,
      progress,
      opts,
    );
    await this.dmDevices.noteInvited(mlsId, result.invited).catch(() => undefined);
    return result;
  }

  /** Before a send / on open: add devices the 1:1's contact installed
   * since it began (#1559). Bounded; never throws, never blocks for long. */
  async syncDmDevices(appGroupId: string, reason: 'send' | 'open' = 'send'): Promise<void> {
    const dm = this.getGroup(appGroupId);
    // Adds are admin-only; in a DM both people are admins.
    if (!dm?.isDm || !dm.memberPubkeys[0] || !dm.adminPubkeys.includes(this.pubkey.toLowerCase()))
      return;
    if (reason === 'send' || this.opts.signerType === 'nsec') {
      void this.outbox.flush().catch(() => undefined);
      void this.welcomePayloads.flush(toMlsGroupId(appGroupId)).catch(() => undefined);
    }
    await this.dmDevices.sync(toMlsGroupId(appGroupId), dm.memberPubkeys[0], reason);
  }

  /** Every outbound group intent goes through here: never queued inside
   * marmot-ts, where a misfired settle check could strand it (#1280). */
  private async sendIntent(mlsId: string, intent: GroupSendIntent, timeoutMs?: number) {
    // Commits (invites included) realign the group for White Noise (#1309).
    return submitWhenSettled(await this.client.groups.get(mlsId), alignCommitForMdk(intent), {
      timeoutMs,
      cancelled: () => this.gate.stopped,
    });
  }

  private async commit(mlsId: string, extraProposals: CommitProposals): Promise<void> {
    const actorPubkey = await this.client.signer.getPublicKey();
    await this.sendIntent(mlsId, { kind: 'commit', actorPubkey, extraProposals });
  }

  async removeMember(appGroupId: string, member: string): Promise<void> {
    const mlsId = toMlsGroupId(appGroupId);
    const pk = member.toLowerCase();
    // One Remove per device leaf the member holds. (Removing an admin also
    // drops them from `admins`: marmot-ts splices that update in itself.)
    const leaves = getPubkeyLeafNodeIndexes((await this.client.groups.get(mlsId)).state, pk);
    if (leaves.length === 0) return;
    await this.commit(mlsId, spreadProposals(Proposals.proposeRemoveUser(pk), leaves.length));
    this.emitGroupsChanged();
  }

  /**
   * Change the group's admin set (MIP-01 `admin_pubkeys`) — admins only.
   * `update` maps the current set to the new one and runs as the commit is
   * built, after the send gate settles, so a concurrent change by another
   * admin is built upon rather than overwritten with a stale list.
   */
  async setAdmins(appGroupId: string, update: (current: string[]) => string[]): Promise<void> {
    // An admin-only update yields exactly one admin-policy proposal.
    const proposal = spreadProposals(async (ctx) => {
      const members = new Set(getGroupMembers(ctx.state).map((p) => p.toLowerCase()));
      const admins = normaliseAdmins(update(normaliseAdmins(ctx.groupData.adminPubkeys)));
      if (admins.length === 0) throw new LastAdminError();
      if (admins.some((p) => !members.has(p))) throw new Error('marmot: an admin must be a member');
      return Proposals.proposeUpdateMetadata({ adminPubkeys: admins })(ctx);
    }, 1);
    await this.commit(toMlsGroupId(appGroupId), proposal);
    this.emitGroupsChanged();
  }

  async rename(appGroupId: string, name: string): Promise<void> {
    // A name-only update yields exactly one group-profile proposal.
    await this.commit(
      toMlsGroupId(appGroupId),
      spreadProposals(Proposals.proposeUpdateMetadata({ name }), 1),
    );
    this.emitGroupsChanged();
  }

  async leave(appGroupId: string): Promise<void> {
    await this.client.groups.leave(toMlsGroupId(appGroupId));
    this.emitGroupsChanged();
  }

  /** Encrypt a photo (MIP-04) under the group's current epoch. */
  async encryptMedia(appGroupId: string, plaintext: Uint8Array, mime: string, filename: string) {
    const group = await this.client.groups.get(toMlsGroupId(appGroupId));
    return encryptMarmotMedia(group, plaintext, mime, filename);
  }

  /**
   * Every event in a group's durable history (ours included), optionally
   * narrowed to `kinds`. Reactions arrive once over MLS like every app event,
   * so a reopened thread reads them back from here. Callers filter further
   * themselves: the history backend only honours kinds/authors/time bounds,
   * not tag filters such as `#e`.
   */
  async queryHistory(appGroupId: string, kinds?: number[]): Promise<MarmotRumor[]> {
    await this.ready;
    const group = this.client.groups.loaded.find((g) => g.idStr === toMlsGroupId(appGroupId));
    if (!group?.history) return [];
    return (await group.history.queryRumors(kinds ? { kinds } : {})) as MarmotRumor[];
  }

  /** Every DM group with `peer`, newest first — once stored groups have loaded.
   * (A peer who lost their MLS state leaves older DMs behind; messages there
   * still belong to the same conversation.) */
  async dmGroupIdsWith(peer: string): Promise<string[]> {
    await this.ready;
    const p = peer.toLowerCase();
    return this.listGroups()
      .filter((g) => g.isDm && g.memberPubkeys[0] === p)
      .sort((a, b) => b.createdAt - a.createdAt)
      .map((g) => g.id);
  }

  /** The group's current MLS epoch (a photo's key is bound to one). */
  async mediaEpoch(appGroupId: string): Promise<bigint> {
    return (await this.client.groups.get(toMlsGroupId(appGroupId))).state.groupContext.epoch;
  }

  /** Record the key of a photo we're sending, so its row reads back the
   * same when the startup replay re-delivers our own message. */
  async rememberMediaKeys(appGroupId: string, rumorId: string, keys: MarmotMediaKeys) {
    await rememberMediaKeys(this.backend, toMlsGroupId(appGroupId), rumorId, keys);
  }

  /** Send an app event; resolves with relay URL → accepted. Rejects with
   * MarmotGroupNotReadyError if the group is still mid-change (#1280).
   * `onSent` gets a receipt to check later whether a slow relay stored it. */
  async sendRumor(
    appGroupId: string,
    rumor: MarmotRumor,
    opts: { settleTimeoutMs?: number; onSent?: (receipt: MarmotSendReceipt) => void } = {},
  ): Promise<Record<string, boolean>> {
    const results = await this.sendIntent(
      toMlsGroupId(appGroupId),
      createApplicationMessageIntent(rumor),
      opts.settleTimeoutMs,
    );
    opts.onSent?.(marmotSendReceipt(results, this.pubkey));
    const byRelay: Record<string, boolean> = {};
    for (const r of results) {
      for (const [url, res] of Object.entries(r.response)) byRelay[url] = byRelay[url] || res.ok;
    }
    const ok = Object.values(byRelay).filter(Boolean).length;
    if (__DEV__)
      console.log(`[Marmot] sent kind ${rumor.kind}: ${ok}/${Object.keys(byRelay).length}`);
    // MIP-05: wake the other members' devices (best-effort, off the send path).
    const sent = this.client.groups.loaded.find((g) => g.idStr === toMlsGroupId(appGroupId));
    if (
      sent &&
      PUSH_TRIGGERING_KINDS.includes(rumor.kind) &&
      Object.values(byRelay).some(Boolean)
    ) {
      this.push.trigger(toPushGroup(sent));
      this.pushRegistration.onUserSend(sent.idStr);
    }
    return byRelay;
  }

  /** Run one of our own sent events through the listeners, as if received:
   * MLS never echoes our sends back, so this applies them via the inbound path. */
  deliverOwn(appGroupId: string, rumor: MarmotRumor): void {
    const g = this.client.groups.loaded.find((x) => x.idStr === toMlsGroupId(appGroupId));
    if (g) this.deliver(g, rumor);
  }

  /** Drop an event from the group history (it's saved before publishing), so a
   * send no relay accepted doesn't replay and apply locally at next start. */
  async forgetRumor(appGroupId: string, rumorId: string): Promise<void> {
    await this.backend.remove(historyNamespace(toMlsGroupId(appGroupId)), rumorId);
  }

  /**
   * Join from a decrypted kind-444 Welcome rumor (delivered gift-wrapped and
   * already unwrapped by the NIP-17 inbox path). Returns null when the
   * Welcome isn't for a key package we hold (e.g. an old invite).
   */
  async acceptWelcome(welcomeRumor: MarmotRumor): Promise<MarmotGroupSummary | null> {
    await this.ready;
    const group = await this.welcomeJoins.accept(welcomeRumor);
    return group ? this.summarise(group) : null;
  }

  /** Where to check whose invitation key a Welcome named (#1269). */
  private async keyPackageLookup(): Promise<KeyPackageLookup> {
    return {
      network: this.client.network,
      relays: [...new Set([...this.writeRelays(), ...this.opts.getLookupRelays()])],
      owner: this.pubkey,
      ownSlot: await this.backend.get('meta', 'keyPackageSlot'),
    };
  }

  // --- internals -----------------------------------------------------------

  private writeRelays(): string[] {
    return this.opts.getWriteRelays();
  }

  /** Each invitee's devices; throws for anyone with none we can invite. */
  private invitees(members: string[]) {
    const lookup = this.opts.getLookupRelays();
    return resolveInvitees(this.client.network, lookup, this.pubkey, members);
  }

  private summarise(g: SessionGroup): MarmotGroupSummary {
    const view = g.groupData;
    const me = this.pubkey.toLowerCase();
    const members = getGroupMembers(g.state).map((p) => p.toLowerCase());
    const others = members.filter((p) => p !== me);
    const name = view?.name ?? '';
    return {
      id: toAppGroupId(g.idStr),
      name,
      description: view?.description ?? '',
      memberPubkeys: others,
      adminPubkeys: (view?.adminPubkeys ?? []).map((p) => p.toLowerCase()),
      // White Noise DM: unnamed, two ACCOUNTS — `members` is distinct pubkeys,
      // so a contact on several devices (3+ leaves) is still a DM. ≤2 so a DM
      // mid-creation (just us, invite not yet committed) never flashes up as
      // a 1-member group.
      isDm: name === '' && members.length <= 2,
      relays: g.relays ?? [],
      createdAt: this.firstSeen.get(g.idStr) ?? Date.now(),
    };
  }

  private wireGroup(g: SessionGroup): void {
    if (this.wiredGroups.has(g.idStr)) return;
    this.wiredGroups.add(g.idStr);
    this.welcomePayloads.attach(g);
    this.devices.watch(g);
    // Membership / name changes (ours or another member's commit) move the epoch.
    g.on('stateChanged', () => {
      noteMarmotCommit(); // covers a push wake for it (never settles a placeholder)
      this.emitGroupsChanged();
      // A member left → drop their push records (MIP-05 "Record state").
      void this.push.reconcile(toPushGroup(g)).catch(() => undefined);
    });
    if (!this.firstSeen.has(g.idStr)) {
      const now = Date.now();
      this.firstSeen.set(g.idStr, now);
      void this.backend.set('firstSeen', g.idStr, String(now));
    }
    g.on('applicationMessage', (data: Uint8Array) => {
      let rumor: MarmotRumor;
      try {
        rumor = deserializeApplicationData(data) as MarmotRumor;
      } catch (e) {
        if (__DEV__) console.warn('[Marmot] undecodable app payload:', e);
        return;
      }
      this.deliver(g, rumor);
    });
  }

  private deliver(g: SessionGroup, rumor: MarmotRumor): void {
    // The same app event can surface twice (relay replay across a reconnect,
    // or the startup history replay); deliver it once so listeners never
    // double-notify. Keyed per group: an identical rumor sent into two
    // groups shares an id.
    // Live state (#1300) skips the cache: duplicates are harmless, keys aren't.
    if (isTransientMarmotKind(rumor.kind)) return this.emit(g, rumor);
    const deliveryKey = `${g.idStr}:${rumor.id}`;
    if (this.deliveredRumors.has(deliveryKey)) return;
    this.deliveredRumors.add(deliveryKey);
    if (this.deliveredRumors.size > DELIVERED_CACHE_SIZE) {
      this.deliveredRumors.delete(this.deliveredRumors.values().next().value as string);
    }
    if (
      rumor.kind === PUSH_TOKEN_UPDATE_KIND ||
      rumor.kind === PUSH_TOKEN_LIST_KIND ||
      rumor.kind === PUSH_TOKEN_REMOVAL_KIND
    ) {
      // MIP-05 token gossip: kept as local push state, never a chat row.
      void this.push.ingest(toPushGroup(g), rumor.kind, rumor.content).catch(() => undefined);
    }
    if (rumor.kind === MARMOT_CHAT_KIND && allAttachments(rumor.tags).length > 0) {
      // Capture the epochs NOW: the photo or voice note's key comes from the epoch it was
      // sent in, and retained epochs are pruned as the group moves on.
      const states = candidateMediaStates(g);
      void loadOrDeriveMediaKeys(this.backend, g, rumor, states).then((mediaKeys) =>
        this.emit(g, rumor, mediaKeys),
      );
      return;
    }
    this.emit(g, rumor);
  }

  private emit(g: SessionGroup, rumor: MarmotRumor, mediaKeys?: MarmotMediaKeys): void {
    const event = { group: this.summarise(g), rumor, ...(mediaKeys ? { mediaKeys } : {}) };
    if (__DEV__) console.log(`[Marmot] recv kind ${rumor.kind} in ${g.idStr.slice(0, 8)}`);
    for (const l of this.listeners) l.onMessage?.(event);
    // Authenticated traffic: covers a push wake, and settles its placeholder.
    noteMarmotGroupTraffic(this.pubkey, {
      createdAtSec: rumor.created_at,
      fromMe: rumor.pubkey.toLowerCase() === this.pubkey.toLowerCase(),
      message: isMarmotMessageKind(rumor.kind),
      messageId: rumor.id,
      groupId: event.group.id,
      ...(event.group.isDm ? { conversationPubkey: event.group.memberPubkeys[0] } : {}),
    });
  }

  /**
   * MLS delivers an app event exactly once: marmot-ts durably marks it
   * processed before emitting it, so if the app dies before its own stores
   * persist the message it is never re-delivered. The library saves it to
   * the (durable) group history first, though — so on start, replay recent
   * history into the listeners (their stores upsert idempotently by id; old
   * messages are past the notification window). Also prunes the history.
   */
  private async replayHistory(g: SessionGroup): Promise<void> {
    if (!g.history) return;
    const since = Math.floor(Date.now() / 1000) - HISTORY_REPLAY_SECS;
    const recent = (await g.history.queryRumors({ since })) as MarmotRumor[];
    recent.sort((a, b) => a.created_at - b.created_at).forEach((r) => this.deliver(g, r));
    const ns = historyNamespace(g.idStr);
    const ids = await this.backend.keys(ns);
    if (ids.length <= HISTORY_KEEP) return;
    const all = (await g.history.queryRumors({})) as MarmotRumor[];
    all.sort((a, b) => b.created_at - a.created_at);
    for (const old of all.slice(HISTORY_KEEP)) {
      await this.backend.remove(ns, old.id);
      await forgetMediaKeys(this.backend, g.idStr, old.id);
    }
  }

  private readonly liveGroups = new Set<string>();
  private groupsToCatchUp = 0;
  private noteGroupLive(h: string): void {
    this.liveGroups.add(h);
    if (this.liveGroups.size >= this.groupsToCatchUp) setMarmotCatchingUp(this.pubkey, false);
  }

  private emitGroupsChanged(): void {
    this.pushRegistration.schedule();
    const groups = this.listGroups();
    for (const l of this.listeners) l.onGroupsChanged?.(groups);
  }

  private async loadWatermarks(): Promise<void> {
    for (const [ns, map] of [
      ['watermark', this.watermarks],
      ['firstSeen', this.firstSeen],
    ] as const) {
      for (const key of await this.backend.keys(ns)) {
        const v = Number(await this.backend.get(ns, key));
        if (Number.isFinite(v)) map.set(key, v);
      }
    }
  }
}

export {
  isUsableKeyPackage,
  MarmotNoKeyPackageError,
  MarmotUnusableKeyPackageError,
} from './marmotKeyPackages';

// --- active-session registry ---------------------------------------------------

let active: MarmotSession | null = null;
const activeListeners = new Set<(s: MarmotSession | null) => void>();
// Per-owner promise for a stopped session's push work to settle.
const pushDrains = new Map<string, Promise<void>>();

/**
 * Before wiping `owner`'s Marmot storage: stop their session if it is still
 * active and wait for its queued push-state writes to settle, so none lands
 * after the wipe.
 */
export async function quiesceMarmotSession(owner: string): Promise<void> {
  if (active?.pubkey === owner) active.stop();
  await pushDrains.get(owner)?.catch(() => undefined);
  pushDrains.delete(owner);
  // Anything still running past the bounded wait must not touch the wipe.
  fence.fenceStoppedSessions(owner);
}

export function getMarmotSession(): MarmotSession | null {
  return active;
}

export function setMarmotSession(session: MarmotSession | null): void {
  if (active && active !== session) active.stop();
  active = session;
  for (const l of activeListeners) l(session);
}

/** Listen for the active session; fires immediately with the current one. */
export function subscribeMarmotSession(listener: (s: MarmotSession | null) => void): () => void {
  activeListeners.add(listener);
  listener(active);
  return () => activeListeners.delete(listener);
}
