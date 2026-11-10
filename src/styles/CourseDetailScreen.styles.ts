import { StyleSheet, Platform, StatusBar } from 'react-native';
import type { Palette } from './palettes';

const STATUS_BAR_TOP = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 40) + 4 : 44;

export const createCourseDetailScreenStyles = (colors: Palette) =>
  StyleSheet.create({
    container: {
      flex: 1,
      backgroundColor: colors.courseTeal,
    },
    scrollContent: {
      paddingBottom: 40,
    },
    backButton: {
      position: 'absolute',
      top: STATUS_BAR_TOP,
      left: 16,
      width: 36,
      height: 36,
      borderRadius: 18,
      backgroundColor: colors.white, // White pill contrasts hero imagery
      justifyContent: 'center',
      alignItems: 'center',
      zIndex: 10,
    },
    headerContainer: {
      minHeight: 420,
      position: 'relative',
      justifyContent: 'flex-end',
    },
    headerImage: {
      ...StyleSheet.absoluteFill,
      width: '100%',
      height: '100%',
    },
    headerGradient: {
      ...StyleSheet.absoluteFill,
    },
    headerContent: {
      paddingHorizontal: 20,
      paddingBottom: 24,
    },
    headerTitle: {
      color: colors.white,
      fontSize: 32,
      fontWeight: '700',
    },
    headerMeta: {
      color: colors.white,
      fontSize: 14,
      fontWeight: '600',
      opacity: 0.85,
      marginTop: 4,
    },
    headerDescription: {
      color: colors.white,
      fontSize: 14,
      lineHeight: 22,
      opacity: 0.9,
      marginTop: 12,
      textAlign: 'center',
    },
    missionsContainer: {
      padding: 20,
      gap: 12,
    },
    missionCard: {
      backgroundColor: colors.surface,
      borderRadius: 16,
      padding: 12,
      flexDirection: 'row',
      alignItems: 'center',
      gap: 14,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 0 },
      shadowOpacity: 0.15,
      shadowRadius: 12,
      elevation: 4,
    },
    missionThumb: {
      width: 80,
      height: 45,
      borderRadius: 8,
    },
    missionRight: {
      flex: 1,
      gap: 2,
    },
    missionTitle: {
      fontSize: 15,
      fontWeight: '700',
      color: colors.textHeader,
    },
    missionMeta: {
      fontSize: 12,
      color: colors.textSupplementary,
    },
    checkCircle: {
      width: 28,
      height: 28,
      borderRadius: 14,
      backgroundColor: colors.green,
      justifyContent: 'center',
      alignItems: 'center',
    },
    chipStart: {
      backgroundColor: colors.brandPink,
      paddingHorizontal: 14,
      paddingVertical: 4,
      borderRadius: 100,
      alignSelf: 'flex-start',
      marginTop: 4,
    },
    chipStartText: {
      color: colors.white,
      fontSize: 11,
      fontWeight: '700',
    },
    chipEarned: {
      backgroundColor: colors.greenLight,
      paddingHorizontal: 14,
      paddingVertical: 4,
      borderRadius: 100,
      alignSelf: 'flex-start',
      marginTop: 4,
    },
    chipEarnedText: {
      color: colors.greenDark,
      fontSize: 11,
      fontWeight: '700',
    },
    rewardBanner: {
      backgroundColor: colors.greenLight,
      borderRadius: 12,
      padding: 16,
      alignItems: 'center',
      marginTop: 8,
    },
    rewardText: {
      color: colors.greenDark,
      fontSize: 14,
      fontWeight: '700',
    },
    chipComingSoon: {
      backgroundColor: colors.divider,
      paddingHorizontal: 14,
      paddingVertical: 4,
      borderRadius: 100,
      alignSelf: 'flex-start',
      marginTop: 4,
    },
    chipComingSoonText: {
      color: colors.textSupplementary,
      fontSize: 11,
      fontWeight: '700',
    },
    tipButton: {
      backgroundColor: colors.brandPink,
      height: 52,
      borderRadius: 12,
      justifyContent: 'center',
      alignItems: 'center',
    },
    tipButtonText: {
      color: colors.white,
      fontSize: 16,
      fontWeight: '700',
    },
  });
