import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

// The compact single-row chat header shared by the 1:1 and group threads
// (ChatHeaderBar): back chevron, avatar, name + optional by-line, trailing
// protocol pill + chat menu, on the surface colour with a hairline divider.
export type ChatHeaderStyles = ReturnType<typeof createChatHeaderStyles>;

export const createChatHeaderStyles = (colors: Palette) =>
  StyleSheet.create({
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      paddingHorizontal: 12,
      paddingVertical: 10,
      backgroundColor: colors.surface,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: colors.divider,
      gap: 10,
    },
    backButton: {
      padding: 4,
    },
    headerPeer: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
    },
    headerAvatar: {
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colors.background,
    },
    headerAvatarFallback: {
      alignItems: 'center',
      justifyContent: 'center',
    },
    headerName: {
      fontSize: 16,
      fontWeight: '700',
      color: colors.textHeader,
    },
    headerNameBlock: {
      flex: 1,
    },
    // Secondary line under the name: a Marmot 1:1's "Secure chat · 2
    // devices" (#1267), or a group's "13 members".
    headerByline: {
      fontSize: 12,
      color: colors.textSupplementary,
    },
  });
