import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

/** The review / live waveform bars (colour-independent). */
export const voiceWaveformStyles = StyleSheet.create({
  row: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 2, height: 34 },
  bar: { width: 3, borderRadius: 2, minHeight: 3 },
});

export const createVoiceRecordingSheetStyles = (colors: Palette) =>
  StyleSheet.create({
    sheetBackground: {
      backgroundColor: colors.surface,
    },
    handleIndicator: {
      backgroundColor: colors.divider,
    },
    content: {
      paddingHorizontal: 24,
      paddingTop: 8,
      paddingBottom: 28,
      alignItems: 'center',
      gap: 14,
    },
    title: {
      fontSize: 16,
      fontWeight: '700',
      color: colors.textHeader,
    },
    encryptionNote: {
      fontSize: 12,
      color: colors.textSupplementary,
      textAlign: 'center',
      paddingHorizontal: 4,
      lineHeight: 16,
    },
    elapsed: {
      fontSize: 32,
      fontWeight: '700',
      color: colors.textBody,
      // Tabular nums so the seconds digit doesn't shift the layout
      // every time it ticks up.
      fontVariant: ['tabular-nums'],
    },
    micArea: {
      width: 120,
      height: 120,
      alignItems: 'center',
      justifyContent: 'center',
      marginVertical: 4,
    },
    pulse: {
      position: 'absolute',
      width: 120,
      height: 120,
      borderRadius: 60,
    },
    micButton: {
      width: 84,
      height: 84,
      borderRadius: 42,
      alignItems: 'center',
      justifyContent: 'center',
      // Crisp shadow so the mic feels tappable even when the pulse is
      // dim (start-of-utterance, breath pauses).
      shadowColor: '#000',
      shadowOpacity: 0.18,
      shadowRadius: 8,
      shadowOffset: { width: 0, height: 4 },
      elevation: 6,
    },
    liveWave: {
      alignSelf: 'stretch',
      height: 34,
      justifyContent: 'center',
      paddingHorizontal: 8,
    },
    playerCard: {
      flexDirection: 'row',
      alignItems: 'center',
      alignSelf: 'stretch',
      gap: 12,
      backgroundColor: colors.background,
      borderRadius: 16,
      paddingVertical: 10,
      paddingHorizontal: 14,
    },
    playButton: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: colors.brandPink,
      alignItems: 'center',
      justifyContent: 'center',
    },
    playerTime: {
      fontSize: 13,
      color: colors.textSupplementary,
      fontVariant: ['tabular-nums'],
      minWidth: 40,
      textAlign: 'right',
    },
    hint: {
      fontSize: 13,
      color: colors.textSupplementary,
      textAlign: 'center',
      paddingHorizontal: 8,
    },
    buttonRow: {
      flexDirection: 'row',
      alignSelf: 'stretch',
      gap: 12,
      marginTop: 8,
    },
    actionButton: {
      flex: 1,
      flexDirection: 'row',
      gap: 8,
      paddingVertical: 12,
      paddingHorizontal: 14,
      borderRadius: 14,
      alignItems: 'center',
      justifyContent: 'center',
    },
    cancelButton: {
      backgroundColor: colors.background,
    },
    sendButton: {
      backgroundColor: colors.brandPink,
    },
    sendButtonDisabled: {
      opacity: 0.4,
    },
    actionLabel: {
      fontSize: 15,
      fontWeight: '700',
    },
  });
