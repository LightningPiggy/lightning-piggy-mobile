import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

export const createFriendPickerSheetStyles = (colors: Palette) =>
  StyleSheet.create({
    sheetBackground: {
      backgroundColor: colors.surface,
      borderTopLeftRadius: 24,
      borderTopRightRadius: 24,
    },
    container: {
      flex: 1,
    },
    listWithBar: {
      flex: 1,
      flexDirection: 'row',
      overflow: 'hidden',
    },
    list: {
      flex: 1,
    },
    titleRow: {
      flexDirection: 'row',
      alignItems: 'flex-start',
    },
    titleText: {
      flex: 1,
    },
    header: {
      paddingHorizontal: 20,
      paddingTop: 8,
      paddingBottom: 12,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.divider,
    },
    title: {
      fontSize: 18,
      fontWeight: '700',
      color: colors.textHeader,
      textAlign: 'center',
    },
    subtitle: {
      fontSize: 13,
      color: colors.textSupplementary,
      marginTop: 4,
      textAlign: 'center',
    },
    searchInput: {
      marginTop: 12,
      backgroundColor: colors.background,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 15,
      color: colors.textHeader,
    },
    listContent: {
      paddingVertical: 8,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingVertical: 10,
      paddingHorizontal: 20,
      gap: 12,
    },
    avatar: {
      width: 40,
      height: 40,
      borderRadius: 20,
      overflow: 'hidden',
      backgroundColor: colors.background,
    },
    avatarImage: {
      width: 40,
      height: 40,
      borderRadius: 20,
    },
    avatarFallback: {
      width: 40,
      height: 40,
      alignItems: 'center',
      justifyContent: 'center',
    },
    info: {
      flex: 1,
    },
    name: {
      fontSize: 16,
      fontWeight: '600',
      color: colors.textHeader,
    },
    newGroupIcon: {
      width: 40,
      height: 40,
      borderRadius: 20,
      backgroundColor: colors.brandPinkLight,
      justifyContent: 'center',
      alignItems: 'center',
    },
    newGroupName: {
      fontSize: 16,
      fontWeight: '600',
      color: colors.brandPink,
    },
    address: {
      fontSize: 13,
      color: colors.textSupplementary,
      marginTop: 2,
    },
    empty: {
      padding: 24,
      alignItems: 'center',
    },
    emptyText: {
      fontSize: 14,
      color: colors.textSupplementary,
      textAlign: 'center',
    },
  });

export type FriendPickerSheetStyles = ReturnType<typeof createFriendPickerSheetStyles>;
