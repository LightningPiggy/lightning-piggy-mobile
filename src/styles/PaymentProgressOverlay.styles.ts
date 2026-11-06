import { Platform, StyleSheet } from 'react-native';
import type { Palette } from './palettes';

// Colour-agnostic styles shared with the Bubble and Confetti subcomponents
// so they don't need access to the themed styles created inside the main
// component.
export const paymentProgressOverlaySharedStyles = StyleSheet.create({
  bubble: {
    position: 'absolute',
  },
  confetti: {
    position: 'absolute',
    borderRadius: 2,
  },
});

export const createPaymentProgressOverlayStyles = (colors: Palette) =>
  StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: 'rgba(21, 23, 26, 0.45)',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    card: {
      backgroundColor: colors.surface,
      borderRadius: 28,
      paddingVertical: 32,
      paddingHorizontal: 28,
      // A definite width (not content-sized via minWidth): with only
      // min/max, Yoga sized the card around the swap checklist's flex:1
      // labels, squeezing them into a narrow column whose wrapped height
      // was under-measured on iOS — "Claiming to your address" was drawn
      // over the Cancel button (2026-11-01).
      width: '100%',
      maxWidth: 340,
      alignItems: 'center',
      gap: 14,
      shadowColor: '#000',
      shadowOffset: { width: 0, height: 8 },
      shadowOpacity: 0.2,
      shadowRadius: 24,
      elevation: 12,
    },
    iconSlot: {
      width: 72,
      height: 72,
      alignItems: 'center',
      justifyContent: 'center',
    },
    successCircle: {
      borderRadius: 36,
      backgroundColor: colors.green,
    },
    errorCircle: {
      borderRadius: 36,
      backgroundColor: colors.red,
    },
    // Amber, not red: a connection loss is "couldn't confirm", not a
    // confirmed failure (#648).
    connectionCircle: {
      borderRadius: 36,
      backgroundColor: colors.zapYellow,
    },
    title: {
      fontSize: 20,
      fontWeight: '700',
      color: colors.textHeader,
      textAlign: 'center',
    },
    subtitle: {
      fontSize: 14,
      color: colors.textSupplementary,
      textAlign: 'center',
    },
    hint: {
      // Used for the on-chain mempool-pending tag (#134). Sits below
      // the subtitle, brand-pink so it reads as a status flag rather
      // than another fact about the payment.
      marginTop: -6,
      fontSize: 12,
      fontWeight: '600',
      color: colors.brandPink,
      textAlign: 'center',
      letterSpacing: 0.3,
    },
    okButton: {
      marginTop: 12,
      alignSelf: 'stretch',
      backgroundColor: colors.brandPink,
      paddingVertical: 12,
      paddingHorizontal: 24,
      borderRadius: 14,
      alignItems: 'center',
    },
    okButtonText: {
      color: colors.white,
      fontSize: 16,
      fontWeight: '700',
      letterSpacing: 0.3,
    },
    cancelButton: {
      marginTop: 8,
      alignSelf: 'center',
      paddingVertical: 10,
      paddingHorizontal: 16,
    },
    cancelButtonText: {
      color: colors.textSupplementary,
      fontSize: 15,
      fontWeight: '600',
    },
    detailsToggle: {
      marginTop: -6,
      fontSize: 12,
      color: colors.textSupplementary,
      textDecorationLine: 'underline',
    },
    detailText: {
      marginTop: -6,
      fontSize: 11,
      color: colors.textSupplementary,
      textAlign: 'center',
      fontFamily: Platform.select({ ios: 'Menlo', android: 'monospace', default: 'monospace' }),
    },
  });
