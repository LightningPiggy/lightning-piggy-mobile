// Consent records retain all candidate Welcomes; snapshots expose one validated row per MLS group.
import { getWelcome } from '@internet-privacy/marmot-ts';
import { createYieldScheduler, type YieldScheduler } from '../contexts/nostrDecryptPacing';
import type { MarmotGroupSummary, MarmotRumor } from './marmotSession';
import type { MarmotKvBackend } from './marmotStore';
import { WELCOME_OUTCOMES_NS, type WelcomeOutcome } from './marmotWelcomeOutcomes';

const NS = 'welcomeInvitations';
const RUMOR_WRAPS_NS = 'welcomeInvitationRumorWraps';
const DECLINED_GROUPS_NS = 'welcomeInvitationDeclinedGroups';
export interface PendingMarmotInvitation {
  id: string;
  rumor: MarmotRumor;
  groupName?: string;
  groupId?: string;
  error?: boolean;
  replacesContentlessAlert?: boolean;
}
type InvitationRecord = PendingMarmotInvitation & {
  status: 'pending' | 'approved';
  fresh?: boolean;
};
type Record =
  | InvitationRecord
  | { id: string; status: 'joined' | 'declined' | 'skipped'; groupId?: string };
export interface InvitationSession {
  getGroup(appGroupId: string): MarmotGroupSummary | undefined;
  acceptWelcome(rumor: MarmotRumor): Promise<MarmotGroupSummary | null>;
  previewWelcome(rumor: MarmotRumor): Promise<{
    forThisDevice: boolean;
    groupId?: string;
    group: { name: string } | null;
  }>;
}
const newestFirst = (a: PendingMarmotInvitation, b: PendingMarmotInvitation) =>
  b.rumor.created_at - a.rumor.created_at || b.id.localeCompare(a.id);

const usableFirst = (a: PendingMarmotInvitation, b: PendingMarmotInvitation) =>
  Number(Boolean(a.error)) - Number(Boolean(b.error)) || newestFirst(a, b);

export class MarmotPendingInvitations {
  private chain: Promise<unknown> = Promise.resolve();
  // Only receive uses this queue: durable ingestion must never await MLS work.
  private receiveChain: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly backend: MarmotKvBackend,
    private readonly changed: () => void,
    private readonly pending: (record: PendingMarmotInvitation) => void = () => {},
  ) {}
  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task);
    this.chain = run.catch(() => undefined);
    return run;
  }
  private process<T>(task: (pacing: YieldScheduler) => Promise<T>): Promise<T> {
    return this.serial(async () => {
      const pacing = createYieldScheduler({ safetyEvery: 8 });
      try {
        return await task(pacing);
      } finally {
        pacing.dispose();
      }
    });
  }
  private async read(id: string): Promise<Record | null> {
    const raw = await this.backend.get(NS, id);
    return raw ? (JSON.parse(raw) as Record) : null;
  }
  private async write(record: Record): Promise<void> {
    await this.backend.set(NS, record.id, JSON.stringify(record));
    this.changed();
  }
  private async records(): Promise<InvitationRecord[]> {
    const records = await Promise.all((await this.backend.keys(NS)).map((id) => this.read(id)));
    return records.filter(
      (r): r is InvitationRecord => r?.status === 'pending' || r?.status === 'approved',
    );
  }
  async list(): Promise<PendingMarmotInvitation[]> {
    await this.chain;
    await this.receiveChain;
    const groups = new Map<string, PendingMarmotInvitation>();
    for (const record of (await this.records()).sort(usableFirst)) {
      if (record.status === 'pending' && record.groupId && !groups.has(record.groupId))
        groups.set(record.groupId, record);
    }
    return [...groups.values()];
  }
  /**
   * Store a received Welcome as an invitation. Every invitation waits for the
   * user's Accept / Decline, whoever sent it (as White Noise does): following
   * someone isn't consent to be added to their groups. True when it's newly
   * pending (the caller may alert); false for a repeat or a decided one.
   */
  receive(
    id: string,
    rumor: MarmotRumor,
    fresh = false,
    replacesContentlessAlert = false,
  ): Promise<boolean> {
    const run = this.receiveChain.then(async () => {
      if (await this.read(id)) return false;
      const original = await this.backend.get(RUMOR_WRAPS_NS, rumor.id);
      if (original && (await this.read(original))) return false;
      await this.backend.set(RUMOR_WRAPS_NS, rumor.id, id);
      await this.write({
        id,
        rumor,
        fresh,
        replacesContentlessAlert,
        status: 'pending',
      });
      return true;
    });
    this.receiveChain = run.catch(() => undefined);
    return run;
  }
  private groupCandidates(record: InvitationRecord, records: InvitationRecord[]) {
    return records
      .filter((r) => r.id === record.id || (record.groupId && r.groupId === record.groupId))
      .sort(newestFirst);
  }
  private async clearGroup(
    record: InvitationRecord,
    status: 'joined' | 'declined',
    candidates: InvitationRecord[],
  ) {
    // Persist consent by group before removing plaintext candidates. A distinct,
    // delayed Welcome can only be associated with this group after preview.
    if (status === 'declined' && record.groupId)
      await this.backend.set(DECLINED_GROUPS_NS, record.groupId, 'declined');
    for (const candidate of candidates) {
      await this.write({
        id: candidate.id,
        status,
        ...(status === 'declined' ? { groupId: candidate.groupId } : {}),
      });
      await this.backend.remove('pendingWelcomes', candidate.rumor.id);
    }
  }
  private async validate(
    session: InvitationSession,
    isCurrent: () => boolean,
    pacing: YieldScheduler,
  ) {
    await this.receiveChain;
    const records = await this.records();
    const visibleGroups = new Set(records.map((r) => r.groupId).filter(Boolean));
    for (const record of records) {
      if (!isCurrent()) return;
      if (record.groupId) continue;
      await pacing.maybeYield();
      if (!isCurrent()) return;
      let preview: Awaited<ReturnType<InvitationSession['previewWelcome']>>;
      try {
        preview = await session.previewWelcome(record.rumor);
      } catch {
        if (!isCurrent()) return;
        // Only structural decoding failures are permanent. Key-store / MLS
        // preview failures on a decodable Welcome must remain retryable.
        try {
          getWelcome(record.rumor);
        } catch {
          await this.write({ id: record.id, status: 'skipped' });
          await this.backend.remove('pendingWelcomes', record.rumor.id);
        }
        continue;
      }
      if (!isCurrent()) return;
      if (!preview.forThisDevice) {
        await this.write({ id: record.id, status: 'skipped' });
        if (__DEV__)
          console.log(`[Marmot] welcome ${record.id.slice(0, 8)} for another device, skipped`);
        continue;
      }
      if (!preview.groupId) continue; // Incomplete preview remains hidden and retryable.
      if (await this.backend.get(DECLINED_GROUPS_NS, preview.groupId)) {
        await this.write({ id: record.id, status: 'declined', groupId: preview.groupId });
        await this.backend.remove('pendingWelcomes', record.rumor.id);
        continue;
      }
      // Preview IDs are MLS hex; the session indexes active conversations by app ID.
      if (session.getGroup(`marmot:${preview.groupId}`)) {
        await this.write({ id: record.id, status: 'joined' });
        await this.backend.remove('pendingWelcomes', record.rumor.id);
        continue;
      }
      const alreadyVisible = visibleGroups.has(preview.groupId);
      visibleGroups.add(preview.groupId);
      const validated = { ...record, groupId: preview.groupId, groupName: preview.group?.name };
      await this.write(validated);
      if (!alreadyVisible && record.status === 'pending' && record.fresh) this.pending(validated);
    }
  }
  resume(session: InvitationSession, isCurrent: () => boolean): Promise<void> {
    return this.process(async (pacing) => {
      await this.validate(session, isCurrent, pacing);
      // One batch-local index serves both fallback and cleanup. Ingestion can
      // add unpreviewed candidates during MLS work; the next pass validates them.
      const groups = new Map<string, InvitationRecord[]>();
      for (const record of await this.records()) {
        if (!record.groupId) continue;
        const candidates = groups.get(record.groupId) ?? [];
        candidates.push(record);
        groups.set(record.groupId, candidates);
      }
      for (const candidates of groups.values()) {
        if (!isCurrent()) return;
        const approved = candidates.find((r) => r.status === 'approved');
        if (approved)
          await this.join(approved, candidates.sort(newestFirst), session, isCurrent, pacing);
      }
    });
  }
  private async join(
    record: InvitationRecord,
    candidates: InvitationRecord[],
    session: InvitationSession,
    isCurrent: () => boolean,
    pacing: YieldScheduler,
  ) {
    for (const candidate of candidates) {
      if (!isCurrent()) return null;
      if (candidate.error) continue;
      await pacing.maybeYield();
      if (!isCurrent()) return null;
      await this.write({ ...candidate, status: 'approved' });
      const group = await session.acceptWelcome(candidate.rumor);
      if (!isCurrent()) return null;
      if (group) {
        await this.clearGroup(record, 'joined', candidates);
        return group;
      }
      const raw = await this.backend.get(WELCOME_OUTCOMES_NS, candidate.rumor.id);
      if (!raw) return null; // Transient failure: retain durable approval for restart.
      const outcome = JSON.parse(raw) as WelcomeOutcome;
      if (outcome.result === 'joined') {
        await this.clearGroup(record, 'joined', candidates);
        return null;
      }
    }
    // All candidates are permanently unusable. Keep a dismissible error row.
    for (const candidate of candidates)
      await this.write({ ...candidate, status: 'pending', error: true });
    return null;
  }
  accept(id: string, session: InvitationSession, isCurrent: () => boolean) {
    return this.process(async (pacing) => {
      await this.validate(session, isCurrent, pacing);
      const record = await this.read(id);
      if (record?.status !== 'pending' || !record.groupId || !isCurrent()) return null;
      const candidates = this.groupCandidates(record, await this.records());
      if (candidates.every((candidate) => candidate.error)) return null;
      return this.join(record, candidates, session, isCurrent, pacing);
    });
  }
  decline(id: string): Promise<void> {
    return this.serial(async () => {
      await this.receiveChain;
      const record = await this.read(id);
      if (record?.status === 'pending')
        await this.clearGroup(
          record,
          'declined',
          this.groupCandidates(record, await this.records()),
        );
    });
  }
}
