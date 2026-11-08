import React, { useMemo } from 'react';
import { walletCardGradientColors } from '../utils/walletCardColors';
import { resolveWalletHealth } from '../utils/walletHealthDisplay';
import { View, Text, Image, TouchableOpacity, Dimensions } from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Grayscale } from 'react-native-color-matrix-image-filters';
import { WalletState, WalletConnectionHealth } from '../types/wallet';
import type { CardThemeConfig } from '../themes/cardThemes';
import { cardThemes, defaultCardThemeFor } from '../themes/cardThemes';
import { getCardBgStyle } from '../themes/cards';
import { satsToFiatString, FiatCurrency } from '../services/fiatService';
import { ChainIcon, SettingsIcon } from './icons/ArrowIcons';
import { useThemeColors } from '../contexts/ThemeContext';
import { useLocale } from '../contexts/LocaleContext';

import { walletCarouselStyles } from '../styles/WalletCarousel.styles';
import { CARD_WIDTH, CARD_HEIGHT, walletCardStyles as styles } from '../styles/WalletCard.styles';
export { CARD_MARGIN, CARD_WIDTH, CARD_HEIGHT, CARD_ASPECT } from '../styles/WalletCard.styles';
const { width: SCREEN_WIDTH } = Dimensions.get('window');

// Mini preview is the full card scaled down. The default 2-up grid width;
// the cover-flow picker passes a larger value. Height + scale are derived
// per-instance from the width at render time.
const MINI_CONTAINER_WIDTH = (SCREEN_WIDTH - 48 - 12) / 2; // ~47% of sheet width

interface WalletCardProps {
  wallet: WalletState;
  btcPrice: number | null;
  currency: FiatCurrency;
  onSettingsPress: () => void;
  carousel?: boolean;
}

interface MiniCardProps {
  interactive?: boolean;
  theme: CardThemeConfig;
  selected?: boolean;
  onPress?: () => void;
  // Rendered width. Defaults to the 2-up grid width; the cover-flow picker
  // passes a larger value. Height + scale are derived to keep the card's
  // aspect ratio.
  width?: number;
}

/** Full card visual — used both directly and scaled for mini previews */
const CardContent: React.FC<{
  theme: CardThemeConfig;
  alias?: string;
  balance?: number | null;
  btcPrice?: number | null;
  currency?: FiatCurrency;
  connectionHealth?: WalletConnectionHealth;
  walletType?: 'nwc' | 'onchain';
  walletAlias?: string | null;
  hideBalance?: boolean;
  onSettingsPress?: () => void;
  showDetails?: boolean;
  isWatchOnly?: boolean;
}> = ({
  theme,
  alias,
  balance,
  btcPrice,
  currency,
  connectionHealth,
  walletType = 'nwc',
  walletAlias,
  hideBalance,
  onSettingsPress,
  showDetails = true,
  isWatchOnly = false,
}) => {
  const colors = useThemeColors();
  const { t, formatLocale } = useLocale();

  // Four-state status for the dot + label (#786, #1768): grey "Checking…"
  // until the wallet has actually answered, then green / amber / red.
  const health = resolveWalletHealth({ walletType, balance: balance ?? null, connectionHealth });
  const statusColor = {
    checking: colors.textSupplementary,
    responsive: colors.green,
    degraded: colors.amber,
    disconnected: colors.red,
  }[health];
  const statusLabel = {
    checking: t('walletCard.checking'),
    responsive: t('walletCard.connected'),
    degraded: t('walletCard.notResponding'),
    disconnected: t('walletCard.disconnected'),
  }[health];

  const gradientColors = useMemo(
    () => walletCardGradientColors(theme.gradientColors, isWatchOnly),
    [theme, isWatchOnly],
  );

  const card = (
    <LinearGradient
      colors={gradientColors}
      start={{ x: 0, y: 0 }}
      end={{ x: 1, y: 1 }}
      style={styles.card}
      testID={showDetails ? `wallet-card-design-${theme.id}` : undefined}
    >
      {theme.backgroundImage && isWatchOnly ? (
        <Grayscale style={getCardBgStyle(theme.backgroundImageStyle, false)}>
          <Image
            source={theme.backgroundImage}
            style={{ width: '100%', height: '100%' }}
            resizeMode={theme.backgroundImageResizeMode ?? 'contain'}
          />
        </Grayscale>
      ) : theme.backgroundImage ? (
        <View style={getCardBgStyle(theme.backgroundImageStyle, false)}>
          <Image
            source={theme.backgroundImage}
            style={{ width: '100%', height: '100%' }}
            resizeMode={theme.backgroundImageResizeMode ?? 'contain'}
          />
        </View>
      ) : null}

      {showDetails ? (
        <>
          <View style={styles.topRow}>
            <View style={styles.statusRow}>
              <View
                style={[styles.statusDot, { backgroundColor: statusColor }]}
                testID={`wallet-status-${health}`}
              />
              <Text
                style={[styles.statusText, { color: theme.textColor }]}
                accessibilityLabel={t('walletCard.walletStatus', { status: statusLabel })}
              >
                {statusLabel}
              </Text>
            </View>
            <View style={styles.topRightIcons}>
              {walletType === 'onchain' ? (
                <ChainIcon size={20} color={theme.textColor} strokeWidth={2.5} />
              ) : (
                <Image
                  source={require('../../assets/images/nwc-icon.png')}
                  style={[styles.walletTypeIcon, { tintColor: theme.textColor }]}
                  resizeMode="contain"
                />
              )}
              {onSettingsPress && (
                <TouchableOpacity
                  accessibilityRole="button"
                  onPress={onSettingsPress}
                  hitSlop={{ top: 10, bottom: 10, left: 10, right: 10 }}
                  testID="wallet-settings"
                  accessibilityLabel={t('walletCard.walletSettings')}
                >
                  <SettingsIcon size={22} color={theme.textColor} strokeWidth={1.5} />
                </TouchableOpacity>
              )}
            </View>
          </View>

          <View style={styles.aliasBalanceGroup}>
            <Text style={[styles.alias, { color: theme.textColor }]} numberOfLines={1}>
              {alias}
            </Text>
            <Text style={[styles.balance, { color: theme.textColor }]}>
              {hideBalance
                ? '***'
                : balance !== null
                  ? t('walletCard.satsBalance', { amount: balance!.toLocaleString(formatLocale) })
                  : '---'}
            </Text>
            {/* Render the fiat row whenever we know the user's selected
                currency, even if the BTC price hasn't arrived yet.
                `satsToFiatString` now returns a `£–` (or `$–`, `€–`)
                placeholder when `btcPrice === null` so the row keeps a
                stable height while we're offline / mid-fetch — see #633.
                The `btcPrice !== null` gate used to hide the row and
                made users wonder if the wallet was broken. */}
            {!hideBalance && balance !== null && currency && (
              <Text style={[styles.fiatBalance, { color: theme.textColor }]}>
                {satsToFiatString(balance!, btcPrice ?? null, currency, formatLocale)}
              </Text>
            )}
          </View>

          {walletAlias && walletAlias !== alias && (
            <Text style={[styles.providerAlias, { color: theme.textColor }]} numberOfLines={1}>
              {walletAlias}
            </Text>
          )}
        </>
      ) : (
        <View style={styles.previewLabel}>
          <Text style={[styles.previewName, { color: theme.textColor }]}>
            {theme.nameKey ? t(theme.nameKey) : theme.name}
          </Text>
        </View>
      )}
    </LinearGradient>
  );

  return card;
};

/** Mini card for theme selection — renders the full card design scaled down */
const MiniWalletCardPreview: React.FC<MiniCardProps> = ({
  interactive = true,
  theme,
  selected,
  onPress,
  width = MINI_CONTAINER_WIDTH,
}) => {
  const { t } = useLocale();
  const scale = width / CARD_WIDTH;
  const height = CARD_HEIGHT * scale;
  return (
    <TouchableOpacity
      accessibilityRole={interactive ? 'button' : undefined}
      accessible={interactive}
      importantForAccessibility={interactive ? 'auto' : 'no-hide-descendants'}
      disabled={!interactive}
      style={[styles.miniCardContainer, { width, height }, selected && styles.miniCardSelected]}
      onPress={onPress}
      activeOpacity={0.7}
      accessibilityState={{ selected: !!selected }}
      accessibilityLabel={t('walletCard.cardDesign', {
        name: theme.nameKey ? t(theme.nameKey) : theme.name,
      })}
      testID={interactive ? `theme-${theme.id}` : undefined}
    >
      <View style={[styles.miniScaleWrapper, { width, height }]}>
        <View
          style={{
            width: CARD_WIDTH,
            height: CARD_HEIGHT,
            transform: [
              { translateX: -(CARD_WIDTH * (1 - scale)) / 2 },
              { translateY: -(CARD_HEIGHT * (1 - scale)) / 2 },
              { scale },
            ],
          }}
        >
          <CardContent theme={theme} showDetails={false} />
        </View>
      </View>
    </TouchableOpacity>
  );
};

export const MiniWalletCard = React.memo(MiniWalletCardPreview);

const WalletCard: React.FC<WalletCardProps> = ({
  wallet,
  btcPrice,
  currency,
  onSettingsPress,
  carousel,
}) => {
  // Defensive fallback: persisted wallets may carry a theme key that has
  // been renamed/removed in subsequent releases (or none at all). Without a
  // fallback the app crashes on `theme.gradientColors` of undefined on boot —
  // see the group-messaging branch test runs. Fall back per wallet type:
  // on-chain → Bitcoin (orange), Lightning/NWC → Lightning Piggy.
  const theme = cardThemes[wallet.theme] ?? cardThemes[defaultCardThemeFor(wallet.walletType)];
  const { t } = useLocale();

  return (
    <View
      style={carousel ? walletCarouselStyles.cardContainer : styles.cardContainer}
      accessible={false}
      testID={`wallet-card-${wallet.walletType}`}
      accessibilityLabel={t('walletCard.walletAccessibility', {
        alias: wallet.alias,
        type: t(
          wallet.walletType === 'onchain' ? 'walletCard.typeOnchain' : 'walletCard.typeLightning',
        ),
      })}
    >
      <CardContent
        theme={theme}
        alias={wallet.alias}
        balance={wallet.balance}
        btcPrice={btcPrice}
        currency={currency}
        connectionHealth={wallet.connectionHealth}
        walletType={wallet.walletType}
        walletAlias={wallet.walletAlias}
        hideBalance={wallet.hideBalance}
        onSettingsPress={onSettingsPress}
        isWatchOnly={wallet.walletType === 'onchain' && wallet.onchainImportMethod !== 'mnemonic'}
      />
    </View>
  );
};

export default React.memo(WalletCard);
