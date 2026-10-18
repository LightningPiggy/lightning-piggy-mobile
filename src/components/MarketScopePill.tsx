import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { X } from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createMarketScopePillStyles } from '../styles/MarketScopePill.styles';
import type { MarketMode } from '../utils/marketMode';
import type { FofProgress } from '../hooks/useMarketFofAuthors';

interface Props {
  mode: MarketMode;
  /** Preferred's pill (no ×) opens Filters, where Sellers leads the sheet. */
  onOpenFilters: () => void;
  /** Every other scope's × returns to Preferred. */
  onReset: () => void;
  /** Friends-of-friends build progress (null when not building). */
  fofProgress: FofProgress | null;
  /** The friends-of-friends build failed; the scope fell back to follows. */
  fofFailed: boolean;
}

const PILL: Record<Exclude<MarketMode, 'preferred'>, { id: string; labelKey: string }> = {
  wotFriends: { id: 'friends', labelKey: 'market.filters.friendsChip' },
  wotFof: { id: 'fof', labelKey: 'market.filters.friendsOfFriendsChip' },
  wotAll: { id: 'all', labelKey: 'market.filters.allChip' },
};

/**
 * The seller scope, always shown as a pill under the search row. The
 * experimental scopes carry a one-line note: All's "unvetted" caveat, and
 * friends-of-friends' "building your network" progress while its graph builds.
 */
const MarketScopePill: React.FC<Props> = ({
  mode,
  onOpenFilters,
  onReset,
  fofProgress,
  fofFailed,
}) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createMarketScopePillStyles(colors), [colors]);

  let note: { text: string; testID: string } | null = null;
  if (mode === 'wotAll') {
    note = { text: t('market.screen.allScopeNote'), testID: 'market-scope-all-note' };
  } else if (mode === 'wotFof' && fofProgress) {
    note = {
      text:
        fofProgress.total > 0
          ? t('market.screen.fofBuilding', { done: fofProgress.done, total: fofProgress.total })
          : t('market.screen.fofBuildingStart'),
      testID: 'market-scope-fof-progress',
    };
  } else if (mode === 'wotFof' && fofFailed) {
    note = { text: t('market.screen.fofFailed'), testID: 'market-scope-fof-failed' };
  }

  return (
    <View style={styles.scopeRow}>
      {mode === 'preferred' ? (
        <TouchableOpacity
          style={styles.scopeChip}
          onPress={onOpenFilters}
          accessibilityLabel={t('market.filters.changeScope', {
            label: t('market.modes.preferred'),
          })}
          testID="market-scope-pill-preferred"
          activeOpacity={0.7}
        >
          <Text style={styles.scopeChipText}>{t('market.modes.preferred')}</Text>
        </TouchableOpacity>
      ) : (
        <TouchableOpacity
          style={styles.scopeChip}
          onPress={onReset}
          accessibilityLabel={t('market.filters.clearScope')}
          testID={`market-scope-pill-${PILL[mode].id}`}
          activeOpacity={0.7}
        >
          <Text style={styles.scopeChipText}>{t(PILL[mode].labelKey)}</Text>
          <X size={14} color={colors.brandPink} strokeWidth={2.25} />
        </TouchableOpacity>
      )}
      {note ? (
        <Text style={styles.scopeNote} testID={note.testID}>
          {note.text}
        </Text>
      ) : null}
    </View>
  );
};

export default React.memo(MarketScopePill);
