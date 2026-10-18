import ShopReceiveWalletSetting from '../components/ShopReceiveWalletSetting';
import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, Text, View } from 'react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { useSellerShop } from '../hooks/useSellerShop';
import { saveSellerCurrency } from '../services/sellerPreferences';
import { Toast } from '../components/BrandedToast';
import MarketSellerHeader from '../components/MarketSellerHeader';
import SettingsPickerOptionRow from '../components/SettingsPickerOptionRow';
import { createMarketSellerStyles } from '../styles/MarketSeller.styles';
import { createMarketShopCurrenciesStyles } from '../styles/MarketShopCurrencies.styles';
import { SELLER_CURRENCIES } from '../utils/marketSellerEvents';
import type { SettingsPickerOption } from '../utils/settingsPicker';
import type { ExploreNavigation } from '../navigation/types';

interface Props {
  navigation: ExploreNavigation;
}

const OPTIONS: SettingsPickerOption[] = SELLER_CURRENCIES.map((code) => ({
  value: code,
  label: code,
}));
const optionKey = (option: SettingsPickerOption) => option.value;

/** The shop's default currency (#1534). Gamma has no shop currency, so this
 * stays on this device (`sellerPreferences`) and is never published. It
 * prefills new listings and new shipping options. */
const MarketShopCurrenciesScreen: React.FC<Props> = ({ navigation }) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createMarketSellerStyles(colors), [colors]);
  const screenStyles = useMemo(() => createMarketShopCurrenciesStyles(colors), [colors]);
  const { pubkey, defaultCurrency } = useSellerShop();
  // Optimistic: the row shows the choice at once; the hook re-reads on save.
  const [picked, setPicked] = useState<string | null>(null);
  const selected = picked ?? defaultCurrency ?? 'SATS';

  const onSelect = useCallback(
    (currency: string) => {
      if (!pubkey || currency === selected) return;
      setPicked(currency);
      saveSellerCurrency(pubkey, currency)
        .then(() => Toast.show({ type: 'success', text1: t('market.sell.currencies.saved') }))
        .catch(() => {
          setPicked(null);
          Toast.show({ type: 'error', text1: t('market.sell.currencies.saveFailed') });
        });
    },
    [pubkey, selected, t],
  );

  const renderItem = useCallback(
    ({ item }: { item: SettingsPickerOption }) => (
      <SettingsPickerOptionRow
        option={item}
        selected={item.value === selected}
        onSelect={onSelect}
        testID={`shop-currency-option-${item.value}`}
      />
    ),
    [selected, onSelect],
  );
  const renderSeparator = useCallback(
    () => <View style={screenStyles.separator} />,
    [screenStyles],
  );

  return (
    <View style={styles.container} testID="shop-currencies-screen">
      <MarketSellerHeader
        title={t('market.sell.hub.currencies')}
        backLabel={t('market.sell.back')}
        onBack={() => navigation.goBack()}
        testID="shop-currencies-back"
      />
      <View style={screenStyles.body}>
        <ShopReceiveWalletSetting />
        <View style={screenStyles.intro}>
          <Text style={styles.label}>{t('market.sell.currencies.defaultTitle')}</Text>
          <Text style={styles.hint}>{t('market.sell.currencies.hint')}</Text>
        </View>
        <FlatList
          data={OPTIONS}
          keyExtractor={optionKey}
          renderItem={renderItem}
          ItemSeparatorComponent={renderSeparator}
          style={screenStyles.card}
          initialNumToRender={14}
          windowSize={7}
          testID="shop-currency-list"
        />
      </View>
    </View>
  );
};

export default MarketShopCurrenciesScreen;
