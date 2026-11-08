import React, { memo, useMemo } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Trash2, Eye, EyeOff, ChevronUp, ChevronDown, Wallet, Bitcoin } from 'lucide-react-native';
import { Alert } from './BrandedAlert';
import { useThemeColors } from '../contexts/ThemeContext';
import { useLocale } from '../contexts/LocaleContext';
import type { useWallet } from '../contexts/WalletContext';
import type { WalletState } from '../types/wallet';
import { cardThemes, defaultCardThemeFor } from '../themes/cardThemes';
import { createManagedWalletRowStyles } from '../styles/ManagedWalletRow.styles';
import { resolveWalletHealth } from '../utils/walletHealthDisplay';

type WalletActions = ReturnType<typeof useWallet>;
type Status = 'ok' | 'warn' | 'error' | 'unknown' | 'checking';
interface Props {
  wallet: WalletState;
  index: number;
  walletCount: number;
  onOpenSettings: (walletId: string) => void;
  onRemove: WalletActions['removeWallet'];
  onReorder: WalletActions['reorderWallet'];
  onUpdateSettings: WalletActions['updateWalletSettings'];
}

// Each 34 px action box already pads the 18 px icon by 8 px either side, so the
// slop is vertical only — horizontal slop would overlap the adjacent action.
const HIT_SLOP = { top: 8, bottom: 8, left: 0, right: 0 };

function walletStatus(w: WalletState): Status {
  if (w.walletType === 'onchain') return w.balance === null ? 'unknown' : 'ok';
  // Same four-state health as the wallet card (#1768): grey until it answers.
  const health = resolveWalletHealth(w);
  if (health === 'checking') return 'checking';
  if (health === 'degraded') return 'warn';
  return health === 'responsive' ? 'ok' : 'error';
}

/**
 * One compact line per wallet: icon tile, name + balance/type, status dot and
 * the inline reorder / balance-visibility / remove actions. Tapping the
 * icon/name area opens the wallet's settings sheet.
 */
const ManagedWalletRow = memo(function ManagedWalletRow({
  wallet: w,
  index,
  walletCount,
  onOpenSettings,
  onRemove,
  onReorder,
  onUpdateSettings,
}: Props) {
  const colors = useThemeColors();
  const { t, formatLocale } = useLocale();
  const styles = useMemo(() => createManagedWalletRowStyles(colors), [colors]);
  const theme = cardThemes[w.theme] ?? cardThemes[defaultCardThemeFor(w.walletType)];
  const Icon = w.walletType === 'onchain' ? Bitcoin : Wallet;
  const type = w.walletType === 'onchain' ? t('settingsPages.watchOnly') : t('settingsPages.nwc');
  const balance = w.hideBalance
    ? '***'
    : w.balance !== null
      ? t('walletsScreen.satsAmount', { amount: w.balance.toLocaleString(formatLocale) })
      : t('settingsKit.status.unknown');
  // Balance first so it survives the ellipsis on narrow screens.
  const detail = `${balance} · ${type}`;
  const status = walletStatus(w);
  const statusLabel = t(`settingsKit.status.${status}`);
  const statusColor = {
    ok: colors.green,
    warn: colors.amber,
    error: colors.red,
    unknown: colors.textSupplementary,
    checking: colors.textSupplementary,
  }[status];
  const isFirst = index === 0;
  const isLast = index === walletCount - 1;

  return (
    <View style={styles.row}>
      <TouchableOpacity
        style={styles.body}
        onPress={() => onOpenSettings(w.id)}
        testID={`wallet-row-${w.id}`}
        accessibilityRole="link"
        accessibilityLabel={w.alias}
        accessibilityHint={`${detail}. ${statusLabel}`}
      >
        <View style={[styles.iconTile, { backgroundColor: theme.gradientColors[0] }]}>
          <Icon size={18} color={theme.textColor} />
        </View>
        <View style={styles.text}>
          <Text style={styles.name} numberOfLines={1}>
            {w.alias}
          </Text>
          <Text style={styles.detail} numberOfLines={1}>
            {detail}
          </Text>
        </View>
        <View
          style={[styles.status, { backgroundColor: statusColor }]}
          accessible
          accessibilityLabel={statusLabel}
          accessibilityRole="text"
        />
      </TouchableOpacity>
      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.action}
          testID={`wallet-move-up-${w.id}`}
          accessibilityState={{ disabled: isFirst }}
          onPress={() => onReorder(w.id, 'up')}
          disabled={isFirst}
          hitSlop={HIT_SLOP}
          accessibilityLabel={t('walletsScreen.moveUp', { alias: w.alias })}
        >
          <ChevronUp size={18} color={colors.white} opacity={isFirst ? 0.3 : 0.8} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.action}
          testID={`wallet-move-down-${w.id}`}
          accessibilityState={{ disabled: isLast }}
          onPress={() => onReorder(w.id, 'down')}
          disabled={isLast}
          hitSlop={HIT_SLOP}
          accessibilityLabel={t('walletsScreen.moveDown', { alias: w.alias })}
        >
          <ChevronDown size={18} color={colors.white} opacity={isLast ? 0.3 : 0.8} />
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.action}
          testID={`wallet-balance-visibility-${w.id}`}
          onPress={() => onUpdateSettings(w.id, { hideBalance: !w.hideBalance })}
          hitSlop={HIT_SLOP}
          accessibilityLabel={
            w.hideBalance
              ? t('walletsScreen.showBalance', { alias: w.alias })
              : t('walletsScreen.hideBalance', { alias: w.alias })
          }
        >
          {w.hideBalance ? (
            <EyeOff size={18} color={colors.white} opacity={0.8} />
          ) : (
            <Eye size={18} color={colors.white} opacity={0.8} />
          )}
        </TouchableOpacity>
        <TouchableOpacity
          style={styles.action}
          testID={`wallet-remove-${w.id}`}
          onPress={() =>
            Alert.alert(
              t('walletsScreen.removeWalletTitle'),
              t('walletsScreen.removeWalletMessage', { alias: w.alias }),
              [
                { text: t('walletsScreen.cancel'), style: 'cancel' },
                {
                  text: t('walletsScreen.remove'),
                  style: 'destructive',
                  onPress: () => onRemove(w.id),
                },
              ],
            )
          }
          hitSlop={HIT_SLOP}
          accessibilityLabel={t('walletsScreen.removeWalletA11y', { alias: w.alias })}
        >
          <Trash2 size={18} color={colors.white} opacity={0.8} />
        </TouchableOpacity>
      </View>
    </View>
  );
});

export default ManagedWalletRow;
