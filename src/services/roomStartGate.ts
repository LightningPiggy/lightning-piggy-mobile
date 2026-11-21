import { hasRepliedTo } from './dmRepliedPartners';
import { peekWotSettings, type WotTier } from './wotSettingsService';

/**
 * Who may START a room the viewer isn't in yet (#1830): a synthetic NIP-17
 * room or a new-group kind-30200. The Messages storage rule for a 1:1 sender —
 * the viewer, a follow, someone the viewer has replied to, or anyone while the
 * list shows everyone (tier 'all'; unknown tier stays gated). Never widened by
 * a refresh's `includeNonFollows` (the Map) or by a thread-open, which only
 * decide 1:1 storage. A room the viewer is already in needs no check: its
 * members keep reaching them whatever the tier.
 */
export function mayStartRoom(
  viewer: string,
  starter: string,
  isFollowed: (pk: string) => boolean,
  listTier: WotTier | null | undefined = peekWotSettings(viewer)?.wotTier,
): boolean {
  const pk = starter.toLowerCase();
  return (
    listTier === 'all' || pk === viewer.toLowerCase() || isFollowed(pk) || hasRepliedTo(viewer, pk)
  );
}
