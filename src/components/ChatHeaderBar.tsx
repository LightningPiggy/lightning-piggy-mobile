import React, { useMemo } from 'react';
import { TouchableOpacity, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useThemeColors } from '../contexts/ThemeContext';
import { createChatHeaderStyles } from '../styles/ChatHeader.styles';

interface Props {
  onBack: () => void;
  backLabel: string;
  backTestID: string;
  /** Leading avatar (the caller owns its tap target + testID). */
  avatar: React.ReactNode;
  /** The name — plain text or the caller's own tappable title. */
  title: React.ReactNode;
  /** Optional quiet line under the name ("13 members", "2 devices"). */
  subtitle?: React.ReactNode;
  /** Right-hand side: protocol pill + chat menu. */
  trailing: React.ReactNode;
}

/**
 * The compact single-row chat header shared by 1:1 and group threads:
 * back chevron, avatar, name (+ by-line), then the protocol pill and the
 * chat menu. Each screen supplies its own slots so the actions and testIDs
 * stay screen-specific while the layout and look stay identical.
 */
function ChatHeaderBar({
  onBack,
  backLabel,
  backTestID,
  avatar,
  title,
  subtitle,
  trailing,
}: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createChatHeaderStyles(colors), [colors]);
  return (
    <View style={styles.header}>
      <TouchableOpacity
        onPress={onBack}
        style={styles.backButton}
        accessibilityLabel={backLabel}
        testID={backTestID}
        hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
      >
        <Svg width={22} height={22} viewBox="0 0 24 24" fill="none">
          <Path
            d="M15 18l-6-6 6-6"
            stroke={colors.textHeader}
            strokeWidth={2.4}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </Svg>
      </TouchableOpacity>
      <View style={styles.headerPeer}>
        {avatar}
        <View style={styles.headerNameBlock}>
          {title}
          {subtitle}
        </View>
      </View>
      {trailing}
    </View>
  );
}

export default ChatHeaderBar;
