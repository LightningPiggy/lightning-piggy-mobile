// Sizing for the profile header's identity row (#1332). The design (#439) is
// the avatar overlapping the banner on the left, and the QR / zap / message
// buttons plus the Follow pill on ONE row to its right, fully below the
// banner with a clear gap, roughly centred on the part of the avatar below it. That row used to `flexWrap`, so on a ~400 dp phone (or
// with a larger system font) the buttons wrapped onto a second line that
// floated over the banner. Instead, pick a compact size whenever the regular
// one wouldn't fit. Pure, so the breakpoint is unit-tested.

export interface ProfileHeaderLayout {
  compact: boolean;
  avatarSize: number;
  /** Avatar plus its border ring. */
  avatarOuter: number;
  /** How far the avatar pulls up into the banner (~40% of its height). */
  overlap: number;
  /**
   * Offset of the action row's top from the identity row's top. The row
   * starts `overlap` above the banner's bottom edge, so the buttons clear
   * the banner by `actionTop - overlap` (= ACTION_GAP).
   */
  actionTop: number;
  iconSize: number;
  iconGap: number;
  followPaddingH: number;
  followMinWidth: number;
  /** Width left for the action row beside the avatar. */
  availableWidth: number;
  /** Width the action row needs at this size (the Follow pill shrinks past it). */
  actionRowWidth: number;
}

const SCREEN_PADDING = 16;
const AVATAR_BORDER = 3;
const ROW_GAP = 12;
/** Clear space between the banner's bottom edge and the tops of the buttons. */
export const ACTION_GAP = 12;
/** Share of the avatar that overlaps the banner. */
const OVERLAP_RATIO = 0.4;
const ACTIONS_FOLLOW_GAP = 8;
const FOLLOW_FONT = 14;
// Average bold glyph width as a share of the font size, and the longest
// English label ("Following") — other locales shrink the pill's text instead.
const GLYPH_WIDTH = 0.62;
const FOLLOW_LABEL_CHARS = 9;

function sizes(compact: boolean) {
  return compact
    ? { avatarSize: 72, iconSize: 36, iconGap: 6, followPaddingH: 12, followMinWidth: 0 }
    : { avatarSize: 96, iconSize: 40, iconGap: 10, followPaddingH: 22, followMinWidth: 110 };
}

/** Width the action row needs at a given size, for `iconCount` buttons + Follow. */
function requiredWidth(
  s: ReturnType<typeof sizes>,
  iconCount: number,
  fontScale: number,
  follow: boolean,
): number {
  const icons = iconCount * s.iconSize + Math.max(0, iconCount - 1) * s.iconGap;
  if (!follow) return icons;
  const label = FOLLOW_LABEL_CHARS * FOLLOW_FONT * GLYPH_WIDTH * fontScale;
  return icons + ACTIONS_FOLLOW_GAP + Math.max(s.followMinWidth, label + 2 * s.followPaddingH);
}

export function profileHeaderLayout(
  windowWidth: number,
  fontScale: number,
  iconCount = 3,
  showFollow = true,
): ProfileHeaderLayout {
  const available = (s: ReturnType<typeof sizes>) =>
    windowWidth - 2 * SCREEN_PADDING - (s.avatarSize + 2 * AVATAR_BORDER) - ROW_GAP;
  const regular = sizes(false);
  const compact = available(regular) < requiredWidth(regular, iconCount, fontScale, showFollow);
  const s = compact ? sizes(true) : regular;
  const avatarOuter = s.avatarSize + 2 * AVATAR_BORDER;
  const overlap = Math.round(avatarOuter * OVERLAP_RATIO);
  return {
    compact,
    ...s,
    avatarOuter,
    overlap,
    actionTop: overlap + ACTION_GAP,
    availableWidth: available(s),
    actionRowWidth: requiredWidth(s, iconCount, fontScale, showFollow),
  };
}

/** Height of the floating back / ⋯ row below the status bar: the 36 dp
 *  buttons sit right at the safe-area inset (#1696), plus an 8 dp gap below. */
export const PROFILE_TOP_BAR_BUTTON = 36;
export const PROFILE_TOP_BAR_HEIGHT = PROFILE_TOP_BAR_BUTTON + 8;
/** Banner height in ContactProfileScreen.styles (`bannerContainer`). */
export const PROFILE_BANNER_HEIGHT = 200;

/**
 * What the pinned app bar shows at a scroll offset (#1332 review):
 *   0 — nothing: the banner is still under the floating back / ⋯ buttons;
 *   1 — a solid bar (safe-area inset + button row) once the banner has
 *       scrolled out from under the buttons, so content never shows
 *       through the status bar or behind the buttons;
 *   2 — that bar plus the tab bar stuck below it, once the in-list tab bar
 *       reaches the bar's bottom edge.
 * `tabBarY` is the tab bar's offset in the list content (null = unmeasured).
 */
export type ProfileStickyPhase = 0 | 1 | 2;
export function profileStickyPhase(
  scrollY: number,
  topInset: number,
  tabBarY: number | null,
): ProfileStickyPhase {
  const barBottom = topInset + PROFILE_TOP_BAR_HEIGHT;
  if (tabBarY !== null && scrollY >= tabBarY - barBottom) return 2;
  if (scrollY >= PROFILE_BANNER_HEIGHT - barBottom) return 1;
  return 0;
}
