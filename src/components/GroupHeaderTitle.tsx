import React, { useMemo } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createGroupHeaderTitleStyles } from '../styles/GroupHeaderTitle.styles';

interface Props {
  name: string;
  /** False for a Marmot group the viewer doesn't administer: MLS would reject
   * the rename commit, so the title is plain text with no pencil. */
  canRename: boolean;
  onRename: () => void;
}

/** Group chat header title: a rename button (with pencil) when the viewer may
 * rename the group, otherwise a plain heading. */
function GroupHeaderTitle({ name, canRename, onRename }: Props) {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createGroupHeaderTitleStyles(colors), [colors]);
  const title = (
    <Text style={styles.title} numberOfLines={1}>
      {name}
    </Text>
  );
  if (!canRename) {
    return (
      <View
        style={styles.container}
        testID="group-title"
        accessible
        accessibilityRole="header"
        accessibilityLabel={name}
      >
        {title}
      </View>
    );
  }
  return (
    <TouchableOpacity
      style={styles.container}
      onPress={onRename}
      accessibilityRole="button"
      accessibilityLabel={t('groupConversationScreen.renameGroup', { name })}
      testID="group-title"
    >
      {title}
      <Svg width={12} height={12} viewBox="0 0 24 24" fill="none">
        <Path
          d="M12 20h9M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z"
          stroke={colors.textSupplementary}
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </Svg>
    </TouchableOpacity>
  );
}

export default React.memo(GroupHeaderTitle);
