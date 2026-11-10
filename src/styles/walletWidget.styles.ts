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

export const WALLET_WIDGET_PALETTES: Record<WidgetStyleId, WalletWidgetPalette> = {
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
  bar: { amount: 19, unit: 11.5, name: 11.5, detail: 10.5, button: 11.5, chevron: 14 },
  compact: { amount: 16, unit: 10, name: 10.5, detail: 10, button: 14, chevron: 12 },
} as const;

export const WIDGET_BUTTON_HEIGHT = 30;
export const WIDGET_ROUND_BUTTON = 30;
