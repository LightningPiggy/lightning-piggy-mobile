import React, { useMemo } from 'react';
import { Text, View, TouchableOpacity } from 'react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { GROUP_PROTOCOL_LABEL, type GroupProtocol } from '../utils/groupProtocol';
import { createDmProtocolTagStyles } from '../styles/DmProtocolTag.styles';

interface Props {
  /** A 1:1 protocol, or a group's (which adds NIP-171). */
  protocol: GroupProtocol;
  onPress?: () => void;
  testID: string;
}

function DmProtocolTag({ protocol, onPress, testID }: Props) {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createDmProtocolTagStyles(colors), [colors]);
  const label = t('dmProtocol.label', { protocol: GROUP_PROTOCOL_LABEL[protocol] });
  const content = (
    <Text style={[styles.text, styles[protocol]]}>{GROUP_PROTOCOL_LABEL[protocol]}</Text>
  );
  return onPress ? (
    <TouchableOpacity
      style={styles.pill}
      onPress={onPress}
      testID={testID}
      accessibilityRole="button"
      accessibilityLabel={label}
    >
      {content}
    </TouchableOpacity>
  ) : (
    <View style={styles.pill} testID={testID} accessible accessibilityLabel={label}>
      {content}
    </View>
  );
}

export default React.memo(DmProtocolTag);
