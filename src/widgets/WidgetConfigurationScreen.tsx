// The widget's configuration screen (#1849): shown by Android when a widget is
// added, and from the widget's "Edit" / reconfigure action. Picks the starting
// wallet, the style and "Hide balance", with a live preview. It runs in its own
// activity outside the app's providers, so it reads the theme from the system
// and the language from the widget snapshot.
import React, { useCallback, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  Switch,
  Text,
  useColorScheme,
  useWindowDimensions,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { SafeAreaProvider, useSafeAreaInsets } from 'react-native-safe-area-context';
import { WidgetPreview, type WidgetConfigurationScreenProps } from 'react-native-android-widget';
import { darkPalette, lightPalette, type Palette } from '../styles/palettes';
import {
  createWidgetConfigurationScreenStyles,
  type WidgetConfigurationScreenStyles,
} from '../styles/WidgetConfigurationScreen.styles';
import { WALLET_WIDGET_PALETTES, WIDGET_BRAND_GRADIENT } from '../styles/walletWidget.styles';
import { WIDGET_STYLE_IDS, type WidgetStyleId } from '../services/widgetSettings';
import { renderWalletWidget } from './renderWalletWidget';
import { walletWidgetSizeFor, type WalletWidgetSize } from './WalletWidget';
import { useWidgetConfiguration } from './useWidgetConfiguration';
import { resolveWidgetLocale, widgetTranslator, type WidgetTranslate } from './widgetI18n';

// The mock-ups' sizes (dp), for a launcher that hasn't reported one yet.
const FALLBACK_SIZE: Record<WalletWidgetSize, { width: number; height: number }> = {
  large: { width: 172, height: 172 },
  bar: { width: 356, height: 80 },
  compact: { width: 172, height: 80 },
};

const STYLE_LABEL_KEYS: Record<WidgetStyleId, string> = {
  piggyPink: 'widget.config.stylePiggyPink',
  cleanWhite: 'widget.config.styleCleanWhite',
  nightGlass: 'widget.config.styleNightGlass',
};

function Radio({ on, styles }: { on: boolean; styles: WidgetConfigurationScreenStyles }) {
  return (
    <View style={[styles.radio, on && styles.radioOn]}>
      {on ? <View style={styles.radioDot} /> : null}
    </View>
  );
}

function StyleSwatch({
  id,
  styles,
}: {
  id: WidgetStyleId;
  styles: WidgetConfigurationScreenStyles;
}) {
  if (id === 'piggyPink') {
    return (
      <LinearGradient
        colors={[WIDGET_BRAND_GRADIENT.from, WIDGET_BRAND_GRADIENT.to]}
        start={{ x: 0, y: 0 }}
        end={{ x: 1, y: 1 }}
        style={styles.swatch}
      />
    );
  }
  const palette = WALLET_WIDGET_PALETTES[id];
  const fill = id === 'nightGlass' ? '#140E22' : (palette.background.backgroundColor ?? '#FFFFFF');
  return <View style={[styles.swatch, { backgroundColor: fill }]} />;
}

function ConfigurationBody({
  widgetInfo,
  renderWidget,
  setResult,
}: WidgetConfigurationScreenProps) {
  const scheme = useColorScheme();
  const colors: Palette = scheme === 'dark' ? darkPalette : lightPalette;
  const styles = useMemo(() => createWidgetConfigurationScreenStyles(colors), [colors]);
  const insets = useSafeAreaInsets();
  const { width: screenWidth } = useWindowDimensions();
  const config = useWidgetConfiguration(widgetInfo.widgetId);
  const { t }: { t: WidgetTranslate } = widgetTranslator(
    resolveWidgetLocale(config.snapshot?.locale),
  );
  const [saving, setSaving] = useState(false);
  const size = walletWidgetSizeFor(widgetInfo.widgetName) ?? 'large';
  const wallets = config.snapshot?.wallets ?? [];

  // Preview at the widget's own size, scaled down to fit the screen.
  const known = widgetInfo.width > 0 && widgetInfo.height > 0;
  const width = known ? widgetInfo.width : FALLBACK_SIZE[size].width;
  const height = known ? widgetInfo.height : FALLBACK_SIZE[size].height;
  const maxWidth = screenWidth - 80;
  const scale = width > maxWidth ? maxWidth / width : 1;
  const previewWidth = Math.round(width * scale);
  const previewHeight = Math.round(height * scale);
  const { snapshot, settings } = config;
  const renderPreview = useCallback(
    () => renderWalletWidget(size, snapshot, settings),
    [size, snapshot, settings],
  );

  const onSave = async () => {
    setSaving(true);
    try {
      await config.save();
      renderWidget(renderWalletWidget(size, config.snapshot, config.settings));
    } finally {
      setResult('ok');
    }
  };

  // Two AsyncStorage reads: a blank frame, no spinner (BrandedSpinner needs the
  // app's providers, which this activity doesn't have).
  if (!config.loaded) return <View style={styles.root} />;

  return (
    <View style={[styles.root, { paddingTop: insets.top + 12 }]} testID="widget-config-screen">
      <ScrollView contentContainerStyle={styles.scroll}>
        <Text style={styles.title} accessibilityRole="header">
          {t('widget.config.title')}
        </Text>
        <Text style={styles.subtitle}>{t('widget.config.subtitle')}</Text>

        <View style={styles.previewWrap} testID="widget-config-preview">
          <WidgetPreview width={previewWidth} height={previewHeight} renderWidget={renderPreview} />
        </View>

        <Text style={styles.sectionLabel}>{t('widget.config.walletSection')}</Text>
        <View style={styles.card}>
          {wallets.length === 0 ? (
            <Text style={styles.notice} testID="widget-config-no-wallets">
              {t('widget.config.noWallets')}
            </Text>
          ) : (
            wallets.map((wallet, i) => {
              const on = wallet.id === config.settings.walletId;
              const name = wallet.name || t('widget.unnamedWallet');
              return (
                <Pressable
                  key={wallet.id}
                  style={[styles.row, i > 0 && styles.rowDivider]}
                  onPress={() => config.selectWallet(wallet.id)}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={name}
                  testID={`widget-config-wallet-${i}`}
                >
                  <View style={styles.rowText}>
                    <Text style={styles.rowTitle} numberOfLines={1}>
                      {name}
                    </Text>
                    <Text style={styles.rowHint}>
                      {t(
                        wallet.walletType === 'onchain'
                          ? 'widget.config.typeOnchain'
                          : 'widget.config.typeLightning',
                      )}
                    </Text>
                  </View>
                  <Radio on={on} styles={styles} />
                </Pressable>
              );
            })
          )}
        </View>

        <Text style={styles.sectionLabel}>{t('widget.config.styleSection')}</Text>
        <View style={styles.card}>
          {WIDGET_STYLE_IDS.map((id, i) => {
            const on = config.settings.style === id;
            return (
              <Pressable
                key={id}
                style={[styles.row, i > 0 && styles.rowDivider]}
                onPress={() => config.update({ style: id })}
                accessibilityRole="radio"
                accessibilityState={{ selected: on }}
                accessibilityLabel={t(STYLE_LABEL_KEYS[id])}
                testID={`widget-config-style-${id}`}
              >
                <StyleSwatch id={id} styles={styles} />
                <Text style={[styles.rowTitle, styles.rowText]}>{t(STYLE_LABEL_KEYS[id])}</Text>
                <Radio on={on} styles={styles} />
              </Pressable>
            );
          })}
        </View>

        <View style={[styles.card, styles.cardSpaced]}>
          <View style={styles.row}>
            <View style={styles.rowText}>
              <Text style={styles.rowTitle}>{t('widget.config.hideBalance')}</Text>
              <Text style={styles.rowHint}>{t('widget.config.hideBalanceHint')}</Text>
            </View>
            <Switch
              value={config.settings.hideBalance}
              onValueChange={(hideBalance) => config.update({ hideBalance })}
              trackColor={{ false: colors.divider, true: colors.brandPink }}
              thumbColor={colors.white}
              accessibilityLabel={t('widget.config.hideBalance')}
              testID="widget-config-hide-balance"
            />
          </View>
        </View>
      </ScrollView>

      <View style={[styles.footer, { paddingBottom: insets.bottom + 12 }]}>
        <Pressable
          style={[styles.button, styles.buttonSecondary]}
          onPress={() => setResult('cancel')}
          accessibilityRole="button"
          accessibilityLabel={t('widget.config.cancel')}
          testID="widget-config-cancel"
        >
          <Text style={styles.buttonSecondaryText}>{t('widget.config.cancel')}</Text>
        </Pressable>
        <Pressable
          style={[styles.button, styles.buttonPrimary, saving && styles.buttonDisabled]}
          onPress={onSave}
          disabled={saving}
          accessibilityRole="button"
          accessibilityState={{ disabled: saving }}
          accessibilityLabel={t('widget.config.save')}
          testID="widget-config-save"
        >
          <Text style={styles.buttonPrimaryText}>{t('widget.config.save')}</Text>
        </Pressable>
      </View>
    </View>
  );
}

export function WidgetConfigurationScreen(props: WidgetConfigurationScreenProps) {
  return (
    <SafeAreaProvider>
      <ConfigurationBody {...props} />
    </SafeAreaProvider>
  );
}
