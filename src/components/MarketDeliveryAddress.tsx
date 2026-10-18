import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { ChevronRight } from 'lucide-react-native';
import { BottomSheetTextInput } from '@gorhom/bottom-sheet';
import { useLocale } from '../contexts/LocaleContext';
import { useThemeColors } from '../contexts/ThemeContext';
import { createMarketCheckoutSheetStyles } from '../styles/MarketCheckoutSheet.styles';
import { createMarketShippingSectionStyles } from '../styles/MarketShippingSection.styles';
import { localizedCountryName } from '../data/countries';
import type { useCheckoutAddress } from '../hooks/useCheckoutAddress';
import {
  composeDeliveryAddress,
  validPostcode,
  type DeliveryAddress,
} from '../utils/deliveryAddress';

interface Props {
  delivery: ReturnType<typeof useCheckoutAddress>;
  countryCode: string | null;
  disabled: boolean;
  onOpenCountryPicker: () => void;
  sellerName: string;
}
const fields: (keyof DeliveryAddress)[] = ['name', 'line1', 'line2', 'town', 'postcode'];
export default function MarketDeliveryAddress({
  delivery,
  countryCode,
  disabled,
  onOpenCountryPicker,
  sellerName,
}: Props) {
  const colors = useThemeColors();
  const styles = useMemo(() => createMarketCheckoutSheetStyles(colors), [colors]);
  const shippingStyles = useMemo(() => createMarketShippingSectionStyles(colors), [colors]);
  const { t, locale } = useLocale();
  const postcodeInvalid =
    !!delivery.fields.postcode && !validPostcode(delivery.fields.postcode, countryCode ?? '');
  const complete = fields
    .filter((key) => key !== 'line2')
    .every((key) => delivery.fields[key].trim());
  return (
    <View style={shippingStyles.section}>
      <Text style={shippingStyles.sectionLabel}>{t('market.checkout.addressLabel')}</Text>
      {fields.map((key) => (
        <View key={key} style={styles.addressField}>
          <Text style={styles.addressLabel}>{t(`market.checkout.delivery.${key}`)}</Text>
          <BottomSheetTextInput
            style={styles.addressInput}
            value={delivery.fields[key]}
            onChangeText={(value) => delivery.changeField(key, value)}
            editable={!disabled}
            maxLength={500}
            autoCapitalize={key === 'postcode' ? 'characters' : 'words'}
            accessibilityLabel={t(`market.checkout.delivery.${key}`)}
            testID={`market-checkout-address-${key}`}
          />
          {key === 'name' ? (
            <Text style={styles.addressHint}>{t('market.checkout.delivery.nameHint')}</Text>
          ) : null}
          {key === 'postcode' && postcodeInvalid ? (
            <Text style={styles.addressHint}>{t('market.checkout.delivery.postcodeInvalid')}</Text>
          ) : null}
        </View>
      ))}
      <View style={styles.addressField}>
        <Text style={styles.addressLabel}>{t('market.checkout.delivery.country')}</Text>
        <TouchableOpacity
          style={[styles.addressInput, styles.addressCountry]}
          onPress={onOpenCountryPicker}
          disabled={disabled}
          accessibilityRole="button"
          accessibilityLabel={t('market.checkout.delivery.country')}
          accessibilityState={{ disabled }}
          testID="market-checkout-country"
        >
          <Text style={styles.addressCountryText}>
            {countryCode
              ? localizedCountryName(countryCode, locale)
              : t('market.shipping.chooseCountryPlaceholder')}
          </Text>
          <ChevronRight size={16} color={colors.textSupplementary} strokeWidth={2.5} />
        </TouchableOpacity>
        {complete &&
        !postcodeInvalid &&
        countryCode &&
        !composeDeliveryAddress(delivery.fields, countryCode) ? (
          <Text style={styles.addressHint}>{t('market.checkout.delivery.tooLong')}</Text>
        ) : null}
      </View>
      <TouchableOpacity
        onPress={delivery.toggleRemember}
        disabled={disabled}
        accessibilityRole="checkbox"
        accessibilityState={{ checked: delivery.remember, disabled }}
        accessibilityLabel={t('market.checkout.delivery.remember')}
        testID="market-checkout-address-remember"
        style={styles.rememberAddress}
      >
        <Text style={[styles.addressLabel, styles.rememberAddressLabel]}>
          {delivery.remember ? '☑' : '☐'} {t('market.checkout.delivery.remember')}
        </Text>
      </TouchableOpacity>
      <Text style={styles.addressHint}>
        {t('market.checkout.addressHint', { seller: sellerName })}
      </Text>
    </View>
  );
}
