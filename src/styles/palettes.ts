import { outgoingBubblePalettes } from './outgoingBubblePalettes';

// Light and dark colour palettes. The key set must stay identical between the
// two objects so every `colors.X` lookup resolves in either theme. Add new
// entries to both palettes.

export const lightPalette = {
  outgoingBubble: outgoingBubblePalettes.A,
  brandPink: '#EC008C',
  brandPinkLight: '#FFF0F5',
  white: '#FFFFFF',
  background: '#F5F5F5',
  // Tap-to-load / retry media boxes and the file-type tile: pale pink with
  // dark ink in light mode. In dark mode the pink tint reads as plum, so the
  // box goes neutral and the action text carries the pink instead.
  mediaBoxFill: '#FFF0F5',
  mediaBoxAction: '#15171A',
  surface: '#FFFFFF',
  textHeader: '#15171A',
  textBody: '#333333',
  textSupplementary: '#7C8B9A',
  divider: '#DDE1E3',
  green: '#4CAF50',
  greenLight: '#E8F5E9',
  greenDark: '#2E7D32',
  // Amber status colour — the middle of the wallet-card health traffic light
  // (green Connected / amber "Not responding" / red Disconnected, #786).
  amber: '#FF9800',
  red: '#F44336',
  redLight: '#FFEBEE',
  courseTeal: '#109AB8',
  bitcoinOrange: '#F7931A',
  bitcoinOrangeLight: '#FFF1E0',
  boltzNavy: '#232742',
  zapYellow: '#FFC107',
  // Ink used INSIDE the yellow `zapYellow` surface (e.g. the attention
  // badge glyph). Always a dark colour regardless of theme — `textHeader`
  // is near-white in dark mode and would fail contrast against yellow.
  zapYellowInk: '#15171A',
  // Warning-callout surface + ink. Pairs with `zapYellow` for the badge
  // and matches the Bootstrap-style alert convention readers recognise.
  zapYellowLight: '#FFF3CD',
  zapYellowDark: '#856404',
  // Map-pin accent colours used by LibreMiniMap + LegendSheet. Promoting
  // these to palette tokens so the theme owns them (was inline hex on
  // map pin + legend chip styles).
  cachePurple: '#7A5CFF',
  eventViolet: '#5B3AFF',
  // Lightning Piggy card purple (the lighter top of the card's
  // #9B40FF -> #7A30F3 gradient). Used by the offline banner so it reads
  // as the brand's Nostr violet rather than the hot-pink alert colour.
  brandPurple: '#9B40FF',
  // Secondary UI accent — the brand violet promoted to a SEMANTIC role so
  // pink-heavy surfaces (Settings, Messages) can share the visual load.
  // Distinct token (not raw `brandPurple`) so the "secondary accent" intent
  // is explicit at the call-site and the value can diverge from the Nostr
  // violet later if needed. Used for: outlined secondary buttons, selected/
  // active states, switch tracks, and decorative section-header icons.
  accentSecondary: '#9B40FF',
  // Tinted surface that pairs with `accentSecondary` for selected rows —
  // the purple analogue of `brandPinkLight`. Pale lilac in light mode.
  accentSecondaryLight: '#F3EAFF',
  // Mid-point bridge colour for the brand pink -> purple banner gradient
  // (`BrandGradientBackground`). A vivid magenta-violet that sits just off
  // the straight pink->purple line so the hue arc stays saturated through
  // the middle (no muddy/grey midpoint) and the fade reads as one smooth
  // sweep rather than two flat zones. Same value in both themes since
  // `brandPink`/`brandPurple` are theme-invariant.
  brandGradientMid: '#C42BD6',
};

// Dark palette: keep the Lightning Piggy brand hot-pink intact, swap the
// greyscale chrome for tuned dark-grey values (AA contrast against white
// text). `white` keeps its literal name since many components use it as
// an explicit foreground colour on pink/orange backgrounds.
export const darkPalette: typeof lightPalette = {
  outgoingBubble: outgoingBubblePalettes.A,
  brandPink: '#EC008C',
  brandPinkLight: '#3A1028',
  white: '#FFFFFF',
  background: '#0E1013',
  mediaBoxFill: '#0E1013',
  mediaBoxAction: '#EC008C',
  surface: '#1A1D21',
  textHeader: '#F5F6F7',
  textBody: '#D5D8DC',
  textSupplementary: '#8A95A3',
  divider: '#2A2E34',
  green: '#66BB6A',
  greenLight: '#1B3A1F',
  greenDark: '#A5D6A7',
  // Slightly brighter amber so the "Not responding" status reads clearly on a
  // dark card gradient (#786).
  amber: '#FFA726',
  red: '#EF5350',
  redLight: '#3A1010',
  courseTeal: '#2EB8D6',
  bitcoinOrange: '#F7931A',
  bitcoinOrangeLight: '#3A2410',
  boltzNavy: '#3A3F5C',
  zapYellow: '#FFC107',
  // Same dark ink as the light palette — the yellow surface stays bright
  // in both themes so the glyph on top should stay dark in both.
  zapYellowInk: '#15171A',
  // Dim warm-brown surface (matches the bitcoin/red light variants) and
  // a brighter ink so the warning copy stays readable on a dark sheet.
  zapYellowLight: '#3A2F10',
  zapYellowDark: '#FFD566',
  // Match the light-palette map accents — purple reads well on both
  // themes so no adjustment needed.
  cachePurple: '#7A5CFF',
  eventViolet: '#5B3AFF',
  // Same brand violet in both themes — reads well on light and dark.
  brandPurple: '#9B40FF',
  // Secondary UI accent — same brand violet; reads well on both themes.
  accentSecondary: '#9B40FF',
  // Deep aubergine tint for selected rows in dark mode — the purple analogue
  // of dark `brandPinkLight` (#3A1028), keeping selected states subtle.
  accentSecondaryLight: '#2A1A3E',
  // Same magenta-violet bridge as the light palette — the gradient endpoints
  // (`brandPink`/`brandPurple`) are identical across themes, so the mid-point
  // is too. See the light-palette note for why it sits off the straight line.
  brandGradientMid: '#C42BD6',
};

export type Palette = typeof lightPalette;
export type ThemePreference = 'light' | 'dark' | 'system';
export type ResolvedScheme = 'light' | 'dark';
