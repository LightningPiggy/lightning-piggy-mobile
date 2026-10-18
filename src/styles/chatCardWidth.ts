import { useWindowDimensions } from 'react-native';

export const CHAT_CARD_MAX_WIDTH = 320;

/**
 * Match the order card's typical phone footprint: 78% leaves room to show
 * direction, while the 320 dp cap keeps cards readable on tablets. Every
 * rich chat card uses this outer width; row alignment supplies equal margins.
 * Recompute on rotation / split-screen rather than caching Dimensions.get().
 */
export const chatCardWidth = (windowWidth: number): number =>
  Math.min(windowWidth * 0.78, CHAT_CARD_MAX_WIDTH);

export const useChatCardWidth = (): number => chatCardWidth(useWindowDimensions().width);

/** Sender-supplied `dim` is untrusted: keep bubbles between a tall portrait
 * (0.6, ~1.7× the width) and a wide panorama (1.8) so forged metadata can't
 * produce a giant row. */
export const CHAT_IMAGE_MIN_ASPECT = 0.6;
export const CHAT_IMAGE_MAX_ASPECT = 1.8;

/** Preserve the source aspect ratio within bounds; invalid or unknown dimensions start square. */
export const chatImageAspectRatio = (width: number, height: number): number =>
  Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0
    ? Math.min(Math.max(width / height, CHAT_IMAGE_MIN_ASPECT), CHAT_IMAGE_MAX_ASPECT)
    : 1;
