// Startup replay of a Marmot group's durable rumor history. Split out of
// marmotSession.ts.
//
// MLS delivers an app event exactly once: marmot-ts durably marks it
// processed before emitting it, so if the app dies before its own stores
// persist the message it is never re-delivered. The library saves it to the
// (durable) group history first, though — so on start, replay recent history
// into the listeners (their stores upsert idempotently by id; old messages
// are past the notification window). Also prunes the history.

import type { GroupRumorHistory, MarmotGroup } from '@internet-privacy/marmot-ts';

import * as dmChoice from './marmotDmChoice';
import { forgetMediaKeys } from './marmotMediaKeyStore';
import type { MarmotRumor } from './marmotSession';
import type { MarmotKvBackend } from './marmotStore';

// Startup replay window + retained history per group.
const HISTORY_REPLAY_SECS = 7 * 24 * 60 * 60;
const HISTORY_KEEP = 500;

/** The KV namespace holding a group's rumor history. */
export const historyNamespace = (groupIdHex: string) => `history:${groupIdHex}`;

export async function replayGroupHistory(
  g: MarmotGroup<GroupRumorHistory>,
  deps: {
    backend: MarmotKvBackend;
    activity: dmChoice.GroupActivity;
    viewer: string;
    deliver: (rumor: MarmotRumor) => void;
  },
): Promise<void> {
  if (!g.history) return;
  await dmChoice.seedActivityOnce(deps.backend, deps.activity, g, deps.viewer);
  const since = Math.floor(Date.now() / 1000) - HISTORY_REPLAY_SECS;
  const recent = (await g.history.queryRumors({ since })) as MarmotRumor[];
  recent.sort((a, b) => a.created_at - b.created_at).forEach((r) => deps.deliver(r));
  const ns = historyNamespace(g.idStr);
  const ids = await deps.backend.keys(ns);
  if (ids.length <= HISTORY_KEEP) return;
  const all = (await g.history.queryRumors({})) as MarmotRumor[];
  all.sort((a, b) => b.created_at - a.created_at);
  for (const old of all.slice(HISTORY_KEEP)) {
    await deps.backend.remove(ns, old.id);
    await forgetMediaKeys(deps.backend, g.idStr, old.id);
  }
}
