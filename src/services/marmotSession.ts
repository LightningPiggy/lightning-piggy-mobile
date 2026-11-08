import { MarmotDmRelayTopUp } from './marmotDmRelayTopUp';
import { DmSuperseded } from './marmotDmSuperseded';
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
import { loadOrDeriveMediaKeys, rememberMediaKeys } from './marmotMediaKeyStore';
import { historyNamespace, replayGroupHistory } from './marmotHistoryReplay';
import { MarmotStateSaves } from './marmotStateSaves';
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
import * as dmChoice from './marmotDmChoice';
import { summariseGroup, type MarmotGroupSummary } from './marmotGroupSummary';
import { installMarmotSameClientRule } from './marmotSameClient';
import { inviteDevices, keyPackageDiscovery } from './marmotInvitees';
import { marmotPeerLists, NO_PEER_LISTS } from './marmotPeerRelayLists';
import { KeyPackageRefreshRequests } from './marmotKeyRefresh';
import { KeyPackageReplenisher } from './marmotKeyPackageReplenisher';
import { alignCommitForMdk, spreadProposals } from './marmotProposals';
import { MarmotWelcomeOutbox } from './marmotWelcomeOutbox';
import { MarmotWelcomePayloads, type InviteOutcome } from './marmotWelcomePayloads';
import { boundGroupQueries } from './marmotGroupBackfill';
import { createMarmotGroupConnections } from './marmotGroupConnections';
import { submitWhenSettled, type GroupSendIntent } from './marmotSendGate';
import { marmotSendReceipt, type MarmotSendReceipt } from './marmotSendReceipt';
import { createMarmotNetwork, createPushTransport, verifyMarmotEvent } from './marmotNetwork';
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
import { pushDrains } from './marmotSessionRegistry';
import { toAppGroupId, toMlsGroupId } from './marmotGroupIds';
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
  loadNumberMap,
  type MarmotKvBackend,
} from './marmotStore';
import { isTransientMarmotKind, transientFreeHistoryFactory } from './marmotTransientRumors';
import type { Rumor } from 'applesauce-common/helpers/gift-wrap';

export { buildMarmotRumor } from './marmotRumor';

/** Marmot's default chat-message kind (foundation/application-messages.md). */
export const MARMOT_CHAT_KIND = 9;
/** Marks our key packages (`client` tag) — NOT the slot id; see ensureKeyPackageSlot. */
const CLIENT_NAME = 'Lightning Piggy';
const DELIVERED_CACHE_SIZE = 2_000;
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

export type { MarmotGroupSummary } from './marmotGroupSummary';

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
  /** Test seam: backoff between retries of a failed group-state save (#1754). */
  stateSaveRetryMs?: readonly number[];
}

export type { InviteOutcome } from './marmotWelcomePayloads';

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
  private readonly superseded: DmSuperseded;
  private readonly relayTopUps = new MarmotDmRelayTopUp(
    (id, proposals) => this.commit(id, proposals),
    () => this.emitGroupsChanged(),
    () => this.opts.dmDeviceSyncWaitMs,
  );
  // Authenticated per-group activity: which 1:1 group is "the" chat (marmotDmChoice).
  private readonly activity = new dmChoice.GroupActivity(
    (id, ms) => void this.backend.set('dmActivity', id, String(ms)),
  );
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
  readonly stateSaves: MarmotStateSaves; // confirmed commits whose save failed (#1754)
  private readonly discovery: ReturnType<typeof keyPackageDiscovery>;
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
    this.superseded = new DmSuperseded(this.backend);
    this.stateSaves = new MarmotStateSaves({
      owner: opts.pubkey,
      backend: this.backend,
      stopped: () => this.gate.stopped,
      retryMs: opts.stateSaveRetryMs,
    });

    const store = <T>(ns: string) => createMarmotKvStore<T>(this.backend, ns);
    this.outbox = new MarmotWelcomeOutbox(this.backend, () => this.gate.stopped);
    const network = this.outbox.wrapNetwork(
      opts.network ??
        createMarmotNetwork(opts.getLookupRelays, this.connection.reconnect, opts.pubkey),
    );
    // Peers' relay lists from the shared cache (none on a test's injected network).
    const peers = opts.network ? NO_PEER_LISTS : marmotPeerLists(opts.pubkey, opts.getLookupRelays);
    this.discovery = keyPackageDiscovery(network, opts.getLookupRelays, peers);
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
      fetchKeyPackages: this.discovery.events,
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
      verifyEvent: verifyMarmotEvent, // the pool's verified-event cache, not a 2nd Schnorr
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
      peers.read,
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
      fetchKeyPackages: this.discovery.events,
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
        void this.stateSaves.forget(bytesToHex(id));
        void this.welcomePayloads.drop(bytesToHex(id), { outbox: true }).catch(() => undefined);
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
      await loadNumberMap(this.backend, 'watermark', this.watermarks);
      await loadNumberMap(this.backend, 'firstSeen', this.firstSeen);
      await loadNumberMap(this.backend, 'dmActivity', this.activity.map);
      await this.superseded.load();
      const loaded = await groups.loadAll();
      loaded.forEach((g) => this.wireGroup(g));
      await this.stateSaves.load(loaded).catch(() => undefined);
      const replay = { backend: this.backend, activity: this.activity, viewer: this.pubkey };
      for (const g of loaded) {
        await replayGroupHistory(g, { ...replay, deliver: (r) => this.deliver(g, r) }).catch(
          (e) => {
            if (__DEV__) console.warn('[Marmot] history replay failed:', e);
          },
        );
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
    const stopJoins = startPendingWelcomeRetries(this.backend, (w) => this.acceptWelcome(w));
    // Invitations we send, staggered after start and on each resume (#1402);
    // a remote signer's are only re-checked here, never signed.
    const stopInvites = this.welcomePayloads.scheduleRetries(this.opts.signerType === 'nsec');
    this.stopWelcomeRetries = () => (stopJoins(), stopInvites());
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
    this.stateSaves.stop();
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

  /** The DM with `peer`: prefer Repair, then authenticated activity (marmotDmChoice). */
  findDm(peer: string): MarmotGroupSummary | undefined {
    const p = peer.toLowerCase();
    return dmChoice.pickDm(
      this.listGroups().filter((g) => g.isDm && g.memberPubkeys[0] === p),
      (id) => this.superseded.has(id),
    );
  }

  /** Whether `peer` has a key package to invite; throws on a failed lookup / only unusable keys. */
  async canMessage(peer: string): Promise<boolean> {
    return (await this.discovery.devices(peer)).length > 0;
  }

  async getOrCreateDm(peer: string): Promise<MarmotGroupSummary> {
    // Stored groups must be loaded first, or an existing DM is missed and a
    // duplicate MLS group gets created for the same peer.
    await this.ready;
    return this.findDm(peer) ?? this.restartDm(peer, false);
  }

  /** A fresh 1:1 with `peer` ("Repair secure chat"); first use (`repair` false) marks nothing. */
  restartDm(peer: string, repair = true): Promise<MarmotGroupSummary> {
    const p = peer.toLowerCase();
    // Single-flight per peer: creating + inviting takes several relay round
    // trips, and a second quick send must not create a second DM group.
    const inFlight = this.creatingDms.get(p);
    if (inFlight) return inFlight;
    const creating = (async () => {
      await this.ready;
      const fresh = await this.superseded.restart(
        repair ? this.listGroups().filter((g) => g.isDm && g.memberPubkeys[0] === p) : [],
        () => this.createGroup('', [p], { adminPubkeys: [this.pubkey, p] }),
      );
      this.emitGroupsChanged();
      return fresh;
    })().finally(() => this.creatingDms.delete(p));
    this.creatingDms.set(p, creating);
    return creating;
  }

  async createGroup(
    name: string,
    members: string[],
    opts: { description?: string; adminPubkeys?: string[] } = {},
  ): Promise<MarmotGroupSummary & InviteOutcome> {
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
      relays: dmChoice.groupRelaysFor(
        this.writeRelays(),
        dmChoice.groupRelayFallbacks(this.pubkey),
      ),
      adminPubkeys: opts.adminPubkeys ?? [this.pubkey],
    });
    try {
      // Undelivered Welcomes stay queued (with their reason) and are retried:
      // the chat is kept, its members sheet shows who hasn't joined (#1402).
      const outcome = await this.inviteKept(group.idStr, devices);
      this.activity.note(group.idStr, Date.now()); // we just made it: it's the live one here
      return { ...this.summarise(group), ...outcome };
    } catch (e) {
      // Only an Add that never committed gets here: undo it, leaving no empty group.
      await this.client.groups.destroy(group.id).catch(() => undefined);
      await this.welcomePayloads.drop(group.idStr, { outbox: true }).catch(() => undefined);
      this.emitGroupsChanged();
      throw e;
    }
  }

  /** inviteAll that rejects only for an Add that never committed: after it, a
   * declined / silent signer or refusing relays leave the Welcomes queued with
   * their reason, and the invitees come back as undelivered (#1402). */
  private async inviteKept(mlsId: string, devices: Map<string, NostrEvent[]>) {
    try {
      const { undelivered } = await this.inviteAll(mlsId, devices);
      return await this.welcomePayloads.outcome(mlsId, undelivered);
    } catch (e) {
      // Committed = the invitees hold leaves now (an epoch change alone may be
      // another member's commit while ours was refused and rolled back).
      const state = await this.client.groups.get(mlsId).then(
        (g) => g.state,
        () => null,
      );
      const people = [...devices.keys()];
      if (!state || !people.every((pk) => getPubkeyLeafNodeIndexes(state, pk).length > 0)) throw e;
      return this.welcomePayloads.outcome(mlsId, people);
    }
  }

  /** Invite `members`' devices; resolves with the people not reached yet
   * (their invitations are retried automatically — no re-invite needed). */
  async addMembers(appGroupId: string, members: string[]): Promise<InviteOutcome> {
    const devices = await this.invitees(members);
    try {
      return await this.inviteKept(toMlsGroupId(appGroupId), devices);
    } finally {
      this.emitGroupsChanged();
    }
  }

  /** Members whose invitation hasn't reached them yet, and why (#1402). */
  pendingInvites(chatId: string) {
    return this.welcomePayloads.inviteStatus(toMlsGroupId(chatId));
  }

  /** A chat's queued invitations changed (coalesced); the listener gets its MLS id. */
  onInvitesChanged(listener: (mlsGroupId: string) => void): () => void {
    return this.outbox.changes.subscribe(listener);
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

  /** A user's open / send retries a chat's invitations (#1402); remote signers: sends only. */
  retryInvites(appGroupId: string, reason: 'send' | 'open' = 'send'): void {
    if (reason === 'send' || this.opts.signerType === 'nsec')
      void this.welcomePayloads.retry(toMlsGroupId(appGroupId));
  }

  /** Before a send / on open: add devices the 1:1's contact installed
   * since it began (#1559). Bounded; never throws, never blocks for long. */
  async syncDmDevices(appGroupId: string, reason: 'send' | 'open' = 'send'): Promise<void> {
    this.retryInvites(appGroupId, reason);
    const dm = this.getGroup(appGroupId);
    // Adds are admin-only; in a DM both people are admins.
    if (!dm?.isDm || !dm.memberPubkeys[0] || !dm.adminPubkeys.includes(this.pubkey.toLowerCase()))
      return;
    const mlsId = toMlsGroupId(appGroupId);
    const active = reason === 'send' || this.opts.signerType === 'nsec';
    await this.dmDevices.sync(mlsId, dm.memberPubkeys[0], reason);
    if (active)
      await this.relayTopUps.sync(mlsId, dm.relays, dmChoice.groupRelayFallbacks(this.pubkey));
  }

  /** Every outbound group intent goes through here: never queued inside
   * marmot-ts, where a misfired settle check could strand it (#1280), and
   * every result's state save is checked (#1754). */
  private async sendIntent(mlsId: string, intent: GroupSendIntent, timeoutMs?: number) {
    const group = await this.client.groups.get(mlsId);
    // Commits (invites included) realign the group for White Noise (#1309).
    const results = await submitWhenSettled(group, alignCommitForMdk(intent), {
      timeoutMs,
      cancelled: () => this.gate.stopped,
    });
    this.stateSaves.check(group, results);
    return results;
  }

  private async commit(mlsId: string, extraProposals: CommitProposals): Promise<void> {
    const actorPubkey = await this.client.signer.getPublicKey();
    await this.sendIntent(mlsId, { kind: 'commit', actorPubkey, extraProposals });
  }

  async removeMember(appGroupId: string, member: string): Promise<void> {
    const mlsId = toMlsGroupId(appGroupId);
    const pk = member.toLowerCase();
    // One Remove per device leaf (marmot-ts also drops a removed admin from `admins`).
    const leaves = getPubkeyLeafNodeIndexes((await this.client.groups.get(mlsId)).state, pk);
    if (leaves.length === 0) return;
    await this.commit(mlsId, spreadProposals(Proposals.proposeRemoveUser(pk), leaves.length));
    await this.welcomePayloads.dropRecipient(mlsId, pk).catch(() => undefined); // #1402
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
    // The rumor's own time, as recipients record it (marmotDmChoice): equal
    // times then break by group id the same way on both sides.
    if (ok > 0) dmChoice.noteRumor(this.activity, toMlsGroupId(appGroupId), rumor);
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
    // Its Welcome time, as the creator noted at creation: else two message-less 1:1s tie on id.
    if (group) this.activity.note(group.idStr, welcomeRumor.created_at * 1000);
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
    return this.discovery.invitees(this.pubkey, members);
  }

  private summarise(g: SessionGroup): MarmotGroupSummary {
    const ctx = { viewer: this.pubkey, firstSeen: this.firstSeen, activity: this.activity.map };
    return summariseGroup(g, { ...ctx, id: toAppGroupId(g.idStr) });
  }

  private wireGroup(g: SessionGroup): void {
    if (this.wiredGroups.has(g.idStr)) return;
    this.wiredGroups.add(g.idStr);
    this.welcomePayloads.attach(g);
    this.devices.watch(g);
    this.stateSaves.watch(g);
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
      dmChoice.noteRumor(this.activity, g.idStr, rumor); // it decrypted: a member sent it
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
}

export {
  isUsableKeyPackage,
  MarmotNoKeyPackageError,
  MarmotUnusableKeyPackageError,
} from './marmotKeyPackages';

export {
  getMarmotSession,
  quiesceMarmotSession,
  setMarmotSession,
  subscribeMarmotSession,
} from './marmotSessionRegistry';
export * from './marmotGroupIds';
