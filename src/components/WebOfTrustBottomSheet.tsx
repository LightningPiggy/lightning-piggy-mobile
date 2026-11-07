// Bottom-sheet explainer + tier picker for the Web of Trust filter (#535).
//
// Tapping any of the WoT chips (Messages, Hunt, Events) opens this sheet.
// Choosing "Friends of friends" builds the extended trust set on demand
// (#565): a progress panel shows "X of Y" follow-list batches with Cancel,
// and the tier only switches once the set is ready. Cancel or a relay
// failure leaves the previous tier in place.

import React, { useMemo } from 'react';
import { Modal, Pressable, ScrollView, Text, TouchableOpacity, View } from 'react-native';
import { ShieldCheck, ShieldOff, ShieldQuestion, X } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import BrandedSpinner from './BrandedSpinner';
import { useThemeColors } from '../contexts/ThemeContext';
import {
  useTrustGraph,
  useTrustGraphL2Status,
  type FofBuildProgress,
} from '../contexts/TrustGraphContext';
import { useTranslation } from '../contexts/LocaleContext';
import {
  createWebOfTrustBottomSheetStyles,
  type WebOfTrustBottomSheetStyles,
} from '../styles/WebOfTrustBottomSheet.styles';
import type { WotTier } from '../services/wotSettingsService';

interface Props {
  visible: boolean;
  onClose: () => void;
  /** Optional explicit "current" tier. When provided, the sheet renders
   * that as the active row instead of reading the global value from
   * `useTrustGraph()`. Lets a caller surface a *derived* tier in its
   * chip — most cleanly used by the per-rail override design in #636.
   * When omitted, falls back to the global persisted tier — every
   * existing caller's behaviour. */
  currentTier?: WotTier;
}

interface TierRowProps {
  tier: WotTier;
  title: string;
  subtitle: string;
  active: boolean;
  onSelect: () => void;
  styles: WebOfTrustBottomSheetStyles;
}

const TierRow: React.FC<TierRowProps> = ({ tier, title, subtitle, active, onSelect, styles }) => {
  const colors = useThemeColors();
  const Icon = tier === 'friends' ? ShieldCheck : tier === 'fof' ? ShieldQuestion : ShieldOff;
  return (
    <TouchableOpacity
      style={[styles.tierRow, active ? styles.tierRowActive : null]}
      onPress={onSelect}
      testID={`wot-tier-${tier}-chip`}
      accessibilityRole="radio"
      accessibilityState={{ selected: active }}
      accessibilityLabel={title}
    >
      <View style={styles.tierIcon}>
        <Icon size={20} color={colors.textHeader} strokeWidth={2.5} />
      </View>
      <View style={styles.tierBody}>
        <Text style={styles.tierTitle}>{title}</Text>
        <Text style={styles.tierSubtitle}>{subtitle}</Text>
      </View>
      <View style={[styles.radioOuter, active ? styles.radioOuterActive : null]}>
        {active ? <View style={styles.radioInner} /> : null}
      </View>
    </TouchableOpacity>
  );
};

interface FofProgressPanelProps {
  progress: FofBuildProgress | null;
  onCancel: () => void;
  styles: WebOfTrustBottomSheetStyles;
}

// "Finding friends of friends… 3 of 12" + bar + Cancel. Re-renders once per
// 50-friend follow-list batch.
const FofProgressPanel: React.FC<FofProgressPanelProps> = ({ progress, onCancel, styles }) => {
  const t = useTranslation();
  const total = progress?.total ?? 0;
  const done = progress?.done ?? 0;
  const label =
    total > 0
      ? t('webOfTrustBottomSheet.fofProgress', { done, total })
      : t('webOfTrustBottomSheet.fofProgressStarting');
  const fraction = total > 0 ? Math.min(1, done / total) : 0;
  return (
    <View style={styles.fofPanel} testID="wot-fof-progress">
      <View style={styles.fofPanelRow}>
        <BrandedSpinner size="small" />
        <Text
          style={styles.fofPanelText}
          testID="wot-fof-progress-text"
          accessibilityLiveRegion="polite"
        >
          {label}
        </Text>
      </View>
      <View style={styles.fofTrack}>
        <View style={[styles.fofFill, { width: `${Math.round(fraction * 100)}%` }]} />
      </View>
      <TouchableOpacity
        style={styles.fofCancelButton}
        onPress={onCancel}
        testID="wot-fof-cancel"
        accessibilityRole="button"
        accessibilityLabel={t('webOfTrustBottomSheet.fofCancelA11y')}
      >
        <Text style={styles.fofCancelText}>{t('webOfTrustBottomSheet.fofCancel')}</Text>
      </TouchableOpacity>
    </View>
  );
};

const WebOfTrustBottomSheet: React.FC<Props> = ({ visible, onClose, currentTier }) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createWebOfTrustBottomSheetStyles(colors), [colors]);
  const { wotTier, setWotTier, l2Size } = useTrustGraph();
  const { status, cancelL2 } = useTrustGraphL2Status();
  // `activeTier` is what the picker renders as "checked". Defaults to
  // the global persisted tier; a caller can pass `currentTier` to
  // override this when its chip surfaces a derived value (per-rail —
  // #636) so the sheet's active state matches what the user just tapped.
  const activeTier = currentTier ?? wotTier;

  // 'fof' starts the build (the tier switches when it completes); any other
  // tier cancels a build in flight — both handled by the context.
  const handleSelect = (next: WotTier): void => {
    if (next === 'fof' && status.building) return;
    setWotTier(next);
  };

  return (
    <Modal
      visible={visible}
      animationType="slide"
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <Pressable style={styles.backdrop} onPress={onClose} testID="wot-sheet-backdrop" />
      {/* navigationBarTranslucent draws this bottom-anchored sheet behind
          the Android nav bar; pad the base 28 by the bottom safe-area inset
          so the Done button stays clear of 3-button navigation (0 under
          gesture nav, so edge-to-edge is preserved there). */}
      <View style={[styles.sheet, { paddingBottom: 28 + insets.bottom }]} testID="wot-bottom-sheet">
        <View style={styles.handleBar} />
        <View style={styles.titleRow}>
          <Text style={styles.title}>{t('webOfTrustBottomSheet.title')}</Text>
          <TouchableOpacity
            onPress={onClose}
            testID="wot-sheet-close"
            accessibilityLabel={t('webOfTrustBottomSheet.close')}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <X size={20} color={colors.textHeader} strokeWidth={2.5} />
          </TouchableOpacity>
        </View>

        <ScrollView style={styles.scroll} showsVerticalScrollIndicator={false}>
          <Text style={styles.explainer}>{t('webOfTrustBottomSheet.explainer')}</Text>

          <TierRow
            tier="friends"
            title={t('webOfTrustBottomSheet.friendsTitle')}
            subtitle={t('webOfTrustBottomSheet.friendsSubtitle')}
            active={activeTier === 'friends'}
            onSelect={() => handleSelect('friends')}
            styles={styles}
          />
          <TierRow
            tier="fof"
            title={t('webOfTrustBottomSheet.fofTitle')}
            subtitle={t('webOfTrustBottomSheet.fofSubtitle')}
            active={activeTier === 'fof'}
            onSelect={() => handleSelect('fof')}
            styles={styles}
          />
          {status.building ? (
            <FofProgressPanel progress={status.progress} onCancel={cancelL2} styles={styles} />
          ) : null}
          {!status.building && status.failed ? (
            <Text style={styles.errorText} testID="wot-fof-error" accessibilityLiveRegion="polite">
              {t('webOfTrustBottomSheet.fofFailed')}
            </Text>
          ) : null}
          {!status.building && !status.failed && activeTier === 'fof' ? (
            <Text style={styles.metaText} testID="wot-fof-meta">
              {t('webOfTrustBottomSheet.fofCount', { count: l2Size })}
            </Text>
          ) : null}
          <TierRow
            tier="all"
            title={t('webOfTrustBottomSheet.allTitle')}
            subtitle={t('webOfTrustBottomSheet.allSubtitle')}
            active={activeTier === 'all'}
            onSelect={() => handleSelect('all')}
            styles={styles}
          />

          <Text style={styles.gateHint} testID="wot-sheet-gate-hint">
            {t('webOfTrustBottomSheet.gateHint')}
          </Text>
        </ScrollView>

        <TouchableOpacity
          style={styles.doneButton}
          onPress={onClose}
          testID="wot-sheet-done"
          accessibilityLabel={t('webOfTrustBottomSheet.done')}
        >
          <Text style={styles.doneText}>{t('webOfTrustBottomSheet.done')}</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
};

export default WebOfTrustBottomSheet;
