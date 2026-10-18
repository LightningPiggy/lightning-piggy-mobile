import { StyleSheet } from 'react-native';
import type { Palette } from './palettes';

/** Wallet radio list for order invoices + the shop's "Receive payments to". */
export const createInvoiceWalletPickerStyles = (colors: Palette) =>
  StyleSheet.create({
    container: {
      gap: 8,
    },
    label: {
      fontSize: 15,
      fontWeight: '600',
      color: colors.textHeader,
    },
    hint: {
      fontSize: 12,
      color: colors.textSupplementary,
    },
    row: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingVertical: 12,
      paddingHorizontal: 14,
      borderRadius: 12,
      borderWidth: 1,
      borderColor: colors.divider,
      backgroundColor: colors.surface,
    },
    rowSelected: {
      borderColor: colors.brandPink,
      backgroundColor: colors.brandPinkLight,
    },
    rowDisabled: {
      opacity: 0.55,
    },
    radio: {
      width: 20,
      height: 20,
      borderRadius: 10,
      borderWidth: 2,
      borderColor: colors.divider,
      alignItems: 'center',
      justifyContent: 'center',
    },
    radioSelected: {
      borderColor: colors.brandPink,
      backgroundColor: colors.brandPink,
    },
    rowBody: {
      flex: 1,
    },
    rowTitle: {
      fontSize: 15,
      fontWeight: '600',
      color: colors.textHeader,
    },
    rowSub: {
      fontSize: 12,
      color: colors.textSupplementary,
      marginTop: 2,
    },
    empty: {
      fontSize: 13,
      color: colors.textSupplementary,
      paddingVertical: 8,
    },
  });

export type InvoiceWalletPickerStyles = ReturnType<typeof createInvoiceWalletPickerStyles>;
