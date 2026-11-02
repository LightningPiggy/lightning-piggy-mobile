// Serialize a DM's relay metadata commit before its next send. Concurrent
// sync callers share the same commit; one attempt per session, so a failing
// top-up (relays unreachable) never delays every later send.
import { Proposals } from '@internet-privacy/marmot-ts';
import { spreadProposals } from './marmotProposals';
import { relayTopUp, RelaysAlreadyTopped } from './marmotDmChoice';
import { DM_DEVICE_SYNC_SEND_WAIT_MS } from './marmotDmDeviceSync';

type CommitProposals = ReturnType<typeof spreadProposals>;

export class MarmotDmRelayTopUp {
  private readonly pending = new Map<string, Promise<void>>();
  private readonly done = new Set<string>();

  constructor(
    private readonly commit: (id: string, proposals: CommitProposals) => Promise<void>,
    private readonly changed: () => void,
    private readonly waitMs: () => number | undefined = () => undefined,
  ) {}

  /** Waits at most the device sync's send wait; a slower commit carries
   * on in the background and is still not retried this session. */
  async sync(id: string, current: string[], fallbacks: string[]): Promise<void> {
    let run = this.pending.get(id);
    if (!run) {
      if (this.done.has(id) || !relayTopUp(current, fallbacks)) return;
      run = this.run(id, fallbacks).finally(() => this.pending.delete(id));
      this.pending.set(id, run);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      run,
      new Promise<void>(
        (resolve) => (timer = setTimeout(resolve, this.waitMs() ?? DM_DEVICE_SYNC_SEND_WAIT_MS)),
      ),
    ]);
    clearTimeout(timer);
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
