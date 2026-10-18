import type { RelayPublishResult } from '../services/nostrRelayLists';

export type PublishRow = {
  url: string;
  status: 'pending' | 'accepted' | 'rejected' | 'noResponse';
  reason?: string;
};
export type PublishProgress = (update: {
  targets?: string[];
  signed?: boolean;
  result?: RelayPublishResult;
}) => void;

/** Match the republish result vocabulary, preserving a relay's rejection reason. */
export function publishProgressRow(result: RelayPublishResult): PublishRow {
  if (result.ok) return { url: result.url, status: 'accepted' };
  return /connection (?:failure|failed|closed|timed out)|websocket closed|timed out|timeout|missing publish result/i.test(
    result.message ?? '',
  ) || result.skipped === 'unhealthy'
    ? { url: result.url, status: 'noResponse' }
    : { url: result.url, status: 'rejected', reason: result.message };
}

export type PublishPhase = 'waiting' | 'publishing' | 'finished';
export function publishPhase(
  current: PublishPhase,
  update: { signed?: boolean; finished?: boolean },
): PublishPhase {
  if (current === 'finished' || update.finished) return 'finished';
  return update.signed ? 'publishing' : current;
}
