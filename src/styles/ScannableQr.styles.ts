import { StyleSheet } from 'react-native';

export const createScannableQrStyles = () =>
  StyleSheet.create({
    fullScreen: {
      flex: 1,
      backgroundColor: '#FFFFFF',
      alignItems: 'center',
      justifyContent: 'center',
      padding: 24,
    },
    hint: {
      marginTop: 24,
      fontSize: 15,
      color: '#5A5A66',
      textAlign: 'center',
    },
  });

export type ScannableQrStyles = ReturnType<typeof createScannableQrStyles>;
