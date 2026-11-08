import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

export const createGroupMembersSheetStyles = (colors: Palette) =>
  StyleSheet.create({
    sheetBackground: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
    },
    handleIndicator: {
      backgroundColor: colors.divider,
      width: 40,
    },
    content: {
      flex: 1,
      paddingHorizontal: 20,
      paddingTop: 8,
    },
    contentContainer: {
      paddingBottom: 60,
    },
    headerRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 16,
    },
    title: {
      fontSize: 20,
      fontWeight: '700',
      color: colors.textHeader,
    },
    doneText: {
      fontSize: 16,
      fontWeight: '600',
      color: colors.brandPink,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      gap: 12,
    },
    avatar: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.background,
      justifyContent: 'center',
      alignItems: 'center',
      overflow: 'hidden',
    },
    avatarImage: {
      width: 40,
      height: 40,
      borderRadius: 20,
    },
    rowProfile: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 12,
    },
    rowNameWrap: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
    },
    rowName: {
      flexShrink: 1,
      fontSize: 15,
      fontWeight: '600',
      color: colors.textHeader,
    },
    youTag: {
      fontWeight: '400',
      color: colors.textSupplementary,
    },
    adminBadge: {
      paddingHorizontal: 8,
      paddingVertical: 2,
      borderRadius: 10,
      backgroundColor: colors.brandPinkLight,
    },
    adminBadgeText: {
      fontSize: 11,
      fontWeight: '700',
      color: colors.brandPink,
    },
    actionsButton: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: colors.background,
      justifyContent: 'center',
      alignItems: 'center',
    },
    followingMarker: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
    },
    followingText: {
      fontSize: 13,
      fontWeight: '500',
      color: colors.textSupplementary,
    },
    followButton: {
      minWidth: 72,
      height: 32,
      paddingHorizontal: 12,
      borderRadius: 16,
      backgroundColor: colors.brandPink,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 4,
    },
    followButtonDisabled: {
      opacity: 0.5,
    },
    followButtonText: {
      fontSize: 13,
      fontWeight: '700',
      color: colors.white,
    },
    removeButton: {
      width: 32,
      height: 32,
      borderRadius: 16,
      backgroundColor: colors.brandPinkLight,
      justifyContent: 'center',
      alignItems: 'center',
    },
    addButton: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      marginTop: 24,
      paddingVertical: 14,
      borderRadius: 12,
      borderWidth: 1.5,
      borderColor: colors.brandPink,
      borderStyle: 'dashed',
    },
    addButtonText: {
      fontSize: 16,
      fontWeight: '600',
      color: colors.brandPink,
    },
    // Marmot: "2 devices ▾" under the name, its own control (#1267).
    deviceToggle: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'flex-start',
      gap: 2,
      marginLeft: 52,
      marginTop: -8,
      marginBottom: 8,
    },
    deviceToggleText: {
      fontSize: 13,
      color: colors.textSupplementary,
    },
    // Marmot: "Invitation not delivered yet" under the name (#1402).
    inviteStatus: {
      marginLeft: 52,
      marginTop: -8,
      marginBottom: 8,
      fontSize: 13,
      fontStyle: 'italic',
      color: colors.textSupplementary,
    },
    // A person's devices, indented under their row (#1267).
    deviceList: {
      marginLeft: 52,
      marginBottom: 6,
      gap: 8,
    },
    deviceRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      gap: 10,
    },
    deviceIcon: {
      marginTop: 2,
    },
    deviceText: {
      flex: 1,
    },
    deviceName: {
      fontSize: 14,
      fontWeight: '600',
      color: colors.textHeader,
    },
    deviceDetail: {
      fontSize: 12,
      color: colors.textSupplementary,
    },
  });

export type GroupMembersSheetStyles = ReturnType<typeof createGroupMembersSheetStyles>;
