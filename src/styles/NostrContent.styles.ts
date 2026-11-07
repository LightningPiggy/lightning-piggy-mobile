import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

/**
 * Styles for the NIP-27 renderer (`components/nostr/*`): inline text +
 * mention chips + links, inline image thumbnails, and the embedded note /
 * article / product cards with their loading skeleton.
 */
export const createNostrContentStyles = (colors: Palette) =>
  StyleSheet.create({
    container: {
      gap: 8,
    },
    text: {
      fontSize: 14,
      lineHeight: 20,
      color: colors.textBody,
    },
    // Inline View inside the paragraph's Text — nudged down so the chip's
    // text sits on the paragraph's baseline.
    mentionWrap: {
      transform: [{ translateY: 4 }],
    },
    mentionChip: {
      backgroundColor: colors.brandPinkLight,
      // Faint pink outline so the chip reads on the grey page background too.
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: `${colors.brandPink}55`,
      borderRadius: 8,
      paddingHorizontal: 5,
      maxWidth: 220,
    },
    mentionText: {
      fontSize: 14,
      lineHeight: 20,
      fontWeight: '600',
      color: colors.brandPink,
    },
    link: {
      color: colors.brandPink,
      textDecorationLine: 'underline',
    },
    mediaRow: {
      flexDirection: 'row',
      flexWrap: 'wrap',
      gap: 6,
    },
    thumb: {
      width: 120,
      height: 120,
      borderRadius: 10,
      backgroundColor: colors.brandPinkLight,
      overflow: 'hidden',
      alignItems: 'center',
      justifyContent: 'center',
    },
    thumbSingle: {
      width: '100%',
      height: 200,
    },
    thumbImage: {
      width: '100%',
      height: '100%',
    },
    // Loading / failed box (MediaStatusBox): fill the whole thumb edge to
    // edge, not the box's default square, with the thumb's own corners.
    thumbStatus: {
      width: '100%',
      height: '100%',
      aspectRatio: undefined,
      borderRadius: 10,
    },
    playBadge: {
      position: 'absolute',
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: 'rgba(0,0,0,0.55)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    card: {
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.divider,
      borderRadius: 12,
      backgroundColor: colors.background,
      paddingHorizontal: 12,
      paddingVertical: 10,
      gap: 6,
    },
    cardCompact: {
      paddingHorizontal: 10,
      paddingVertical: 8,
      gap: 4,
    },
    cardBodyCompact: {
      fontSize: 12,
      lineHeight: 16,
    },
    replyBlock: {
      gap: 6,
    },
    // "Replying to @Name" line above a reply on the Posts tab.
    replyContext: {
      fontSize: 12,
      lineHeight: 20,
      color: colors.textSupplementary,
    },
    cardHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 8,
    },
    cardAuthor: {
      flexShrink: 1,
    },
    cardTime: {
      fontSize: 12,
      color: colors.textSupplementary,
    },
    cardBody: {
      fontSize: 13,
      lineHeight: 18,
      color: colors.textBody,
    },
    cardTitle: {
      fontSize: 14,
      fontWeight: '700',
      color: colors.textHeader,
    },
    cardKicker: {
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 0.4,
      textTransform: 'uppercase',
      color: colors.brandPink,
    },
    cardMuted: {
      fontSize: 13,
      color: colors.textSupplementary,
      fontStyle: 'italic',
    },
    articleImage: {
      width: '100%',
      height: 120,
      borderRadius: 8,
      backgroundColor: colors.brandPinkLight,
    },
    skeletonLine: {
      height: 10,
      borderRadius: 5,
      backgroundColor: colors.divider,
    },
    skeletonShort: { width: '35%' },
    skeletonMid: { width: '70%' },
    skeletonLong: { width: '95%' },
    skeletonHeader: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    skeletonAvatar: {
      width: 22,
      height: 22,
      borderRadius: 11,
      backgroundColor: colors.divider,
    },
  });

export type NostrContentStyles = ReturnType<typeof createNostrContentStyles>;
