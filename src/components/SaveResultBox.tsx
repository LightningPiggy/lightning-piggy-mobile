import React, { useMemo } from 'react';
import { Text, View } from 'react-native';
import { CheckCircle, CircleAlert } from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { createServerConnectionTestStyles } from '../styles/ServerConnectionTest.styles';

/** Result of a "Check and save" — same look as the Test-connection result box. */
export default function SaveResultBox({
  message,
  failed,
  testID,
}: {
  message: string;
  failed: boolean;
  testID: string;
}) {
  const colors = useThemeColors();
  const styles = useMemo(() => createServerConnectionTestStyles(colors), [colors]);
  return (
    <View
      style={[styles.result, failed ? styles.error : styles.success]}
      accessibilityLiveRegion="polite"
      testID={testID}
    >
      {failed ? (
        <CircleAlert size={20} color={colors.red} />
      ) : (
        <CheckCircle size={20} color={colors.greenDark} />
      )}
      <Text style={[styles.text, failed ? styles.errorText : styles.successText]}>{message}</Text>
    </View>
  );
}
