// Serialize a DM's relay metadata commit before its next send. Concurrent
// sync callers share the same commit; one attempt per session, so a failing
// top-up (relays unreachable) never delays every later send.
import { Proposals } from '@internet-privacy/marmot-ts';
import { spreadProposals } from './marmotProposals';
import { relayTopUp, RelaysAlreadyTopped } from './marmotDmChoice';

type CommitProposals = ReturnType<typeof spreadProposals>;

export class MarmotDmRelayTopUp {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly done = new Set<string>();

  constructor(
    private readonly commit: (id: string, proposals: CommitProposals) => Promise<void>,
    private readonly changed: () => void,
  ) {}

  async sync(id: string, current: string[], fallbacks: string[]): Promise<void> {
    const pending = this.pending.get(id);
    if (pending) return pending;
    if (this.done.has(id) || !relayTopUp(current, fallbacks)) return;
    const run = this.run(id, fallbacks).finally(() => this.pending.delete(id));
    this.pending.set(id, run);
    return run;
  }

  private async run(id: string, fallbacks: string[]): Promise<void> {
    const topUp = spreadProposals(async (ctx) => {
      const relays = relayTopUp(ctx.groupData.relays, fallbacks);
      if (!relays) throw new RelaysAlreadyTopped();
      return Proposals.proposeUpdateMetadata({ relays })(ctx);
    }, 1);
    this.done.add(id);
    try {
      await this.commit(id, topUp);
      this.changed();
    } catch (e) {
      if (!(e instanceof RelaysAlreadyTopped)) console.warn('[Marmot] relay top-up failed');
    }
  }
}
