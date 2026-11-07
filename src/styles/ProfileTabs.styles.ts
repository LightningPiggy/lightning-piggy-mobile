import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';
import { PROFILE_TOP_BAR_BUTTON, PROFILE_TOP_BAR_HEIGHT } from '../utils/profileHeaderLayout';

/**
 * Profile page tabs (#1332): the Posts / Media / Products tab bar and the
 * rows of the list underneath — post cards, the 3-column media grid, the
 * 2-column product grid, status rows and the "Load more" footer.
 */
export const createProfileTabsStyles = (colors: Palette) =>
  StyleSheet.create({
    tabBar: {
      flexDirection: 'row',
      marginTop: 20,
      marginHorizontal: 16,
      marginBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.divider,
    },
    tab: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: 10,
      borderBottomWidth: 2,
      borderBottomColor: 'transparent',
    },
    tabActive: {
      borderBottomColor: colors.brandPink,
    },
    tabText: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.textSupplementary,
    },
    tabTextActive: {
      color: colors.brandPink,
      fontWeight: '700',
    },
    // Posts / Posts & replies switch at the top of the Posts tab.
    segmented: {
      flexDirection: 'row',
      alignSelf: 'flex-start',
      marginHorizontal: 16,
      marginBottom: 10,
      padding: 2,
      borderRadius: 16,
      backgroundColor: colors.surface,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.divider,
    },
    segment: {
      paddingHorizontal: 12,
      paddingVertical: 5,
      borderRadius: 14,
    },
    segmentActive: {
      backgroundColor: colors.brandPink,
    },
    segmentText: {
      fontSize: 12,
      fontWeight: '600',
      color: colors.textSupplementary,
    },
    segmentTextActive: {
      color: colors.white,
    },
    postCard: {
      backgroundColor: colors.surface,
      borderRadius: 12,
      paddingHorizontal: 14,
      paddingVertical: 12,
      marginHorizontal: 16,
      marginBottom: 10,
      borderWidth: StyleSheet.hairlineWidth,
      borderColor: colors.divider,
      gap: 6,
    },
    postTime: {
      fontSize: 12,
      color: colors.textSupplementary,
      fontWeight: '500',
    },
    gridRow: {
      flexDirection: 'row',
      paddingHorizontal: 16,
      gap: 4,
      marginBottom: 4,
    },
    mediaTile: {
      flex: 1,
      aspectRatio: 1,
      borderRadius: 6,
      overflow: 'hidden',
      backgroundColor: colors.brandPinkLight,
      alignItems: 'center',
      justifyContent: 'center',
    },
    mediaSpacer: {
      flex: 1,
    },
    mediaImage: {
      width: '100%',
      height: '100%',
    },
    playBadge: {
      position: 'absolute',
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: 'rgba(0,0,0,0.55)',
      alignItems: 'center',
      justifyContent: 'center',
    },
    productRow: {
      flexDirection: 'row',
      paddingHorizontal: 16,
      gap: 12,
      marginBottom: 12,
    },
    productCell: {
      flex: 1,
    },
    statusRow: {
      paddingVertical: 32,
      paddingHorizontal: 24,
      alignItems: 'center',
    },
    statusText: {
      fontSize: 13,
      color: colors.textSupplementary,
      textAlign: 'center',
    },
    footer: {
      alignItems: 'center',
      paddingVertical: 12,
      gap: 8,
    },
    loadMoreButton: {
      paddingHorizontal: 18,
      paddingVertical: 8,
      borderRadius: 16,
      borderWidth: 1,
      borderColor: colors.brandPink,
    },
    // Pinned app bar (#1332 review): solid background from the very top of
    // the screen (under the status bar / cutout) down past the back / ⋯
    // row, with the tab bar appended once it sticks.
    stickyBar: {
      position: 'absolute',
      top: 0,
      left: 0,
      right: 0,
      zIndex: 5,
      backgroundColor: colors.background,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.divider,
    },
    stickyTitleRow: {
      // Same height as the floating back / ⋯ row, title centred on the
      // buttons (the 8 dp gap below them is padding).
      height: PROFILE_TOP_BAR_HEIGHT,
      paddingBottom: PROFILE_TOP_BAR_HEIGHT - PROFILE_TOP_BAR_BUTTON,
      justifyContent: 'center',
      paddingHorizontal: 64,
    },
    stickyTitle: {
      fontSize: 16,
      fontWeight: '700',
      color: colors.textHeader,
      textAlign: 'center',
    },
    stickyTabBar: {
      marginTop: 0,
      marginBottom: 0,
      borderBottomWidth: 0,
    },
    loadMoreText: {
      fontSize: 13,
      fontWeight: '600',
      color: colors.brandPink,
    },
  });

export type ProfileTabsStyles = ReturnType<typeof createProfileTabsStyles>;
