import React, { useMemo, useRef } from 'react';
import {
  Animated,
  Modal,
  PanResponder,
  ScrollView,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import { Bitcoin, MapPin, PiggyBank, Zap } from 'lucide-react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createLegendSheetStyles } from '../styles/LegendSheet.styles';
import { btcMapIconComponent } from '../utils/btcMapIcon';

interface Props {
  visible: boolean;
  onClose: () => void;
  /**
   * When true, the sheet also lists the BTC Map category icons present
   * in the current view (the user's filter chips can turn merchants off
   * entirely, in which case showing the category iconography is just
   * noise). Caller decides based on its current `filters.lightning ||
   * filters.onchain`.
   */
  placesVisible: boolean;
  /**
   * BTC Map category keys present in the current viewport — same
   * `availableCategories` array the MapScreen filter sheet uses. We
   * render the icon for each so the user can correlate the glyph on
   * the map pin with the category name.
   */
  availableCategories: string[];
}

/**
 * Bottom-sheet legend opened from a button next to Recenter on the
 * inline + full maps. Lists the pin colour idioms and, when places
 * are visible, the BTC Map category iconography. Replaces the inline
 * `MapLegend` strip we previously rendered under the maps — the legend
 * is rarely-needed but high-value when you do need it, so tucking it
 * behind a glyph button reclaims vertical space on the host screens.
 *
 * Swipe-down to dismiss; tap-backdrop also dismisses. Same gesture
 * rules as `useDismissibleSheet` in MapScreen for behavioural parity
 * — the hook was inlined there before this component existed; this
 * sheet copies the rules rather than depending on a co-located hook
 * to keep the component self-contained.
 */
export const LegendSheet: React.FC<Props> = ({
  visible,
  onClose,
  placesVisible,
  availableCategories,
}) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const insets = useSafeAreaInsets();
  const styles = useMemo(() => createLegendSheetStyles(colors), [colors]);
  const translateY = useRef(new Animated.Value(0)).current;
  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_e, g) => Math.abs(g.dy) > 4,
      onPanResponderMove: (_e, g) => translateY.setValue(Math.max(0, g.dy)),
      onPanResponderRelease: (_e, g) => {
        const dismiss = g.dy > 100 || g.vy > 0.5;
        if (dismiss) {
          Animated.timing(translateY, {
            toValue: 600,
            duration: 180,
            useNativeDriver: true,
          }).start(() => {
            translateY.setValue(0);
            onClose();
          });
        } else {
          Animated.spring(translateY, {
            toValue: 0,
            useNativeDriver: true,
            friction: 8,
            tension: 80,
          }).start();
        }
      },
    }),
  ).current;

  // Sort + dedupe so unstable BTC Map ordering doesn't make the legend
  // shuffle on every viewport change. The same key (e.g. 'cafe' and
  // 'coffee') maps to the same Lucide glyph; we dedupe by glyph name
  // so the user doesn't see duplicate entries.
  const categoryRows = useMemo(() => {
    if (!placesVisible) return [];
    const seenComponents = new Set<unknown>();
    const rows: { key: string; label: string }[] = [];
    for (const key of [...availableCategories].sort()) {
      const Comp = btcMapIconComponent(key);
      if (seenComponents.has(Comp)) continue;
      seenComponents.add(Comp);
      // Title-case the category key for display ("fast_food" → "Fast food").
      const label = key.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
      rows.push({ key, label });
    }
    return rows;
  }, [availableCategories, placesVisible]);

  return (
    <Modal
      visible={visible}
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={styles.backdrop} testID="legend-sheet">
        <TouchableOpacity style={styles.tapAway} onPress={onClose} activeOpacity={1} />
        {/* navigationBarTranslucent draws this bottom-docked sheet behind the
            Android nav bar; pad the base 32 by the bottom safe-area inset so
            the last legend rows stay clear of 3-button navigation (0 under
            gesture nav, so edge-to-edge is preserved there). */}
        <Animated.View
          style={[styles.sheet, { paddingBottom: 32 + insets.bottom, transform: [{ translateY }] }]}
        >
          {/* The whole header strip — grabber pill, the "Pin types"
              section title, AND a tall transparent area around them —
              is one big drag target so the user doesn't have to aim
              for the 4-px pill to dismiss. Everything below the title
              lives in the ScrollView and scrolls independently. */}
          <View {...responder.panHandlers} style={styles.grabberZone} testID="legend-sheet-grabber">
            <View style={styles.handle} />
            <Text style={styles.sectionTitle}>{t('legendSheet.pinTypes')}</Text>
          </View>
          <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.scrollPad}>
            {/* All pin-type rows render the same 22-px circle-with-glyph
                chassis used on the actual map markers, so what the user
                sees in the legend is exactly what they'll see in the
                viewport. Colour signals payment / cache class; glyph
                signals what. */}
            <View style={styles.row}>
              <View style={[styles.pinChip, { backgroundColor: '#EC008C' }]}>
                <Zap size={12} color="#fff" strokeWidth={2.5} />
              </View>
              <Text style={styles.rowLabel}>{t('legendSheet.lightningMerchant')}</Text>
            </View>
            <View style={styles.row}>
              <View style={[styles.pinChip, { backgroundColor: '#F7931A' }]}>
                <Bitcoin size={12} color="#fff" strokeWidth={2.5} />
              </View>
              <Text style={styles.rowLabel}>{t('legendSheet.onChainMerchant')}</Text>
            </View>
            <View style={styles.row}>
              <View style={[styles.pinChip, { backgroundColor: '#EC008C' }]}>
                <PiggyBank size={12} color="#fff" strokeWidth={2.5} />
              </View>
              <Text style={styles.rowLabel}>{t('legendSheet.nipGcPiglet')}</Text>
            </View>
            <View style={styles.row}>
              <View style={[styles.pinChip, { backgroundColor: colors.cachePurple }]}>
                <MapPin size={12} color="#fff" strokeWidth={2.5} />
              </View>
              <Text style={styles.rowLabel}>{t('legendSheet.nipGcCache')}</Text>
            </View>
            <View style={styles.row}>
              <View style={styles.userDotChip}>
                <View style={styles.userDotInner} />
              </View>
              <Text style={styles.rowLabel}>{t('legendSheet.you')}</Text>
            </View>

            {categoryRows.length > 0 ? (
              <>
                <Text style={[styles.sectionTitle, { marginTop: 20 }]}>
                  {t('legendSheet.categories')}
                </Text>
                <Text style={styles.sectionSub}>{t('legendSheet.categoriesSub')}</Text>
                {categoryRows.map((row) => {
                  const Icon = btcMapIconComponent(row.key);
                  return (
                    <View key={row.key} style={styles.row}>
                      {/* Category rows reuse the same pinChip chassis as
                          pin types — coloured pink (the default Lightning
                          merchant tint, since the map carries the same
                          category icon for both Lightning + on-chain
                          merchants and the colour signals payment type
                          separately). Same 28-px / 14-px proportions so
                          every row in the sheet visually aligns. */}
                      <View style={[styles.pinChip, { backgroundColor: colors.brandPink }]}>
                        <Icon size={12} color="#fff" strokeWidth={2.5} />
                      </View>
                      <Text style={styles.rowLabel}>{row.label}</Text>
                    </View>
                  );
                })}
              </>
            ) : null}
          </ScrollView>
        </Animated.View>
      </View>
    </Modal>
  );
};

export default LegendSheet;
