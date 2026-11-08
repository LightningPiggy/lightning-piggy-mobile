/**
 * Render window for the 1:1 chat FlatList (inverted, up to DM_CONV_CAP rows).
 *
 * - `initialNumToRender` fills one phone viewport (~10-14 bubbles plus day
 *   headers) on the first frame; the rest of the window fills in batches
 *   after the first paint instead of before it. Was 20 (about two screens).
 * - `windowSize` stays at RN's default 21 (10 screens kept either side): a
 *   smaller window unmounted rows a few screens back, so scrolling back showed
 *   blank space until they re-rendered (#1661). Lower it only with an
 *   on-device scroll-back A/B.
 *
 * `removeClippedSubviews` is deliberately OFF: with `inverted` on Android it
 * breaks the contentOffset reporting, so onScroll's `y < 200` check flips while
 * the user is visually at the bottom and the scroll-to-bottom FAB shows
 * spuriously (facebook/react-native#30521, #26061).
 */
export const DM_CHAT_LIST_WINDOW = {
  initialNumToRender: 15,
  maxToRenderPerBatch: 10,
  windowSize: 21,
  removeClippedSubviews: false,
} as const;
