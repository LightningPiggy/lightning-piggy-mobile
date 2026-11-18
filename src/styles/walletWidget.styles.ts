// Colours and sizes for the Android home-screen widget (#1849), from the
// agreed mock-ups. The widget is drawn by react-native-android-widget's
// primitives, not React Native views, so these are plain style constants
// rather than a `StyleSheet` — but they live here with the app's other styles.
import type { ColorProp, FlexWidgetStyle } from 'react-native-android-widget';
import type { WidgetStyleId } from '../services/widgetSettings';

type Gradient = NonNullable<FlexWidgetStyle['backgroundGradient']>;

/** Brand gradient (#FF2D95 → #9B40FF), top-left to bottom-right. */
export const WIDGET_BRAND_GRADIENT: Gradient = {
  from: '#FF2D95',
  to: '#9B40FF',
  orientation: 'TL_BR',
};

export interface WalletWidgetPalette {
  background: Pick<FlexWidgetStyle, 'backgroundColor' | 'backgroundGradient'>;
  border?: ColorProp;
  text: ColorProp;
  /** Secondary text: the "sats" unit and the fiat / updated line. */
  textMuted: ColorProp;
  amount: ColorProp;
  /** ‹ › arrows. */
  chevron: ColorProp;
  dotActive: ColorProp;
  dotInactive: ColorProp;
  /** Receive. */
  primary: Pick<FlexWidgetStyle, 'backgroundColor' | 'backgroundGradient'> & { text: ColorProp };
  /** Send / Scan. */
  secondary: { background: ColorProp; text: ColorProp };
}

export const WALLET_WIDGET_PALETTES: Record<
  Exclude<WidgetStyleId, 'cardDesign'>,
  WalletWidgetPalette
> = {
  // 1. Piggy pink (default): brand gradient, white Receive, translucent Send.
  piggyPink: {
    background: { backgroundGradient: WIDGET_BRAND_GRADIENT },
    text: '#FFFFFF',
    textMuted: 'rgba(255, 255, 255, 0.8)',
    amount: '#FFFFFF',
    chevron: 'rgba(255, 255, 255, 0.75)',
    dotActive: '#FFFFFF',
    dotInactive: 'rgba(255, 255, 255, 0.35)',
    primary: { backgroundColor: '#FFFFFF', text: '#C21F78' },
    secondary: { background: 'rgba(255, 255, 255, 0.22)', text: '#FFFFFF' },
  },
  // 3. Clean white: white card, pink-gradient Receive, lilac Send.
  cleanWhite: {
    background: { backgroundColor: '#FFFFFF' },
    text: '#1D1B26',
    textMuted: 'rgba(29, 27, 38, 0.8)',
    amount: '#1D1B26',
    chevron: '#C21F78',
    dotActive: '#1D1B26',
    dotInactive: 'rgba(29, 27, 38, 0.35)',
    primary: { backgroundGradient: WIDGET_BRAND_GRADIENT, text: '#FFFFFF' },
    secondary: { background: '#F3EEFC', text: '#6A35C9' },
  },
  // 4. Night glass: dark see-through panel, gold balance, pink Receive.
  nightGlass: {
    background: { backgroundColor: 'rgba(20, 14, 34, 0.62)' },
    border: 'rgba(255, 255, 255, 0.14)',
    text: '#FFFFFF',
    textMuted: 'rgba(255, 255, 255, 0.8)',
    amount: '#FFD700',
    chevron: 'rgba(255, 255, 255, 0.75)',
    dotActive: '#FFFFFF',
    dotInactive: 'rgba(255, 255, 255, 0.35)',
    primary: { backgroundColor: '#FF2D95', text: '#FFFFFF' },
    secondary: { background: 'rgba(255, 255, 255, 0.12)', text: '#FFFFFF' },
  },
};

/** Connection dot beside the wallet name. */
export const WIDGET_STATUS_COLORS = { connected: '#4CAF50', offline: '#F44336' } as const;

export const WIDGET_RADIUS = 22;

/** Type sizes (dp) per widget size, from the mock-ups. */
export const WIDGET_TYPE = {
  large: { amount: 23, unit: 11.5, name: 11.5, detail: 10.5, button: 11.5, chevron: 18 },
  // The 2×2 card when a launcher makes it narrower than usual.
  largeNarrow: { amount: 19, unit: 10, name: 11.5, detail: 10.5, button: 11.5, chevron: 18 },
  bar: { amount: 19, unit: 11.5, name: 11.5, detail: 10.5, button: 11.5, chevron: 14 },
  compact: { amount: 16, unit: 10, name: 10.5, detail: 10, button: 14, chevron: 12 },
} as const;

export const WIDGET_BUTTON_HEIGHT = 30;
export const WIDGET_ROUND_BUTTON = 30;

/** "Same as in the app": the palette follows the wallet's card design. Text and amount use the card's own text colour. */
export function cardDesignPalette(theme: {
  gradientColors: [string, string];
  textColor: string;
}): WalletWidgetPalette {
  // Card themes store plain hex strings; the widget library types colours more strictly.
  const [from, to] = theme.gradientColors as [ColorProp, ColorProp];
  const lightText = isLightColour(theme.textColor);
  const text = theme.textColor as ColorProp;
  return {
    background: { backgroundGradient: { from, to, orientation: 'TL_BR' } },
    text,
    textMuted: withAlpha(theme.textColor, 0.8),
    amount: text,
    chevron: withAlpha(theme.textColor, 0.75),
    dotActive: text,
    dotInactive: withAlpha(theme.textColor, 0.35),
    primary: lightText
      ? { backgroundColor: '#FFFFFF', text: '#1D1B26' }
      : { backgroundColor: '#1D1B26', text: '#FFFFFF' },
    secondary: { background: withAlpha(theme.textColor, 0.22), text },
  };
}

/** Darkens full-bleed card art so white text stays readable over a busy picture. */
export const WIDGET_ART_SCRIM: ColorProp = 'rgba(0, 0, 0, 0.42)';

/** Below this height (dp) the 2×2 card drops its page dots and tightens up, so both buttons always fit. */
export const WIDGET_LARGE_SHORT_BELOW = 165;

/** Below this width (dp) the 2×2 card shrinks its amount so the "sats" unit isn't cut off. */
export const WIDGET_LARGE_NARROW_BELOW = 160;

function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function isLightColour(hex: string): boolean {
  const rgb = parseHex(hex);
  if (!rgb) return true;
  const [r, g, b] = rgb;
  return 0.299 * r + 0.587 * g + 0.114 * b > 150;
}

function withAlpha(hex: string, alpha: number): ColorProp {
  const rgb = parseHex(hex);
  if (!rgb) return hex as ColorProp;
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha})` as ColorProp;
}

/** The card's colour at `alpha`, laid over art to fade it; null when there's nothing to fade. */
export function washColour(hex: string, alpha: number): ColorProp | null {
  if (!(alpha > 0.01)) return null;
  return withAlpha(hex, Math.min(alpha, 1));
}
