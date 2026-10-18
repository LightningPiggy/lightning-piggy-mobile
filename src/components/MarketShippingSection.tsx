import FiatAmount from './FiatAmount';
import BrandedSpinner from './BrandedSpinner';
import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { ChevronRight, Globe, MessageCircle } from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useLocale } from '../contexts/LocaleContext';
import { createMarketShippingSectionStyles } from '../styles/MarketShippingSection.styles';
import { countryName } from '../data/countries';
import type { ShippingOption } from '../utils/marketShipping';

type TranslateFn = ReturnType<typeof useLocale>['t'];

interface Props {
  /** Fetch state from useShippingOptions. */
  status: 'idle' | 'loading' | 'ready' | 'error';
  retry: () => void;
  /** Options already filtered to the selected country (empty = no match). */
  compatibleOptions: ShippingOption[];
  /** Selected destination (ISO 3166-1 alpha-2), or null before the pick. */
  countryCode: string | null;
  onOpenCountryPicker: () => void;
  /** Coordinate of the chosen option, or null. */
  selectedCoordinate: string | null;
  onSelectOption: (coordinate: string) => void;
  /** All-in sats cost per option coordinate; null = fiat rate unavailable. */
  costSatsByCoordinate: Map<string, number | null>;
  sellerName: string;
  onMessageShop: () => void;
  /** False when the sheet collects the address itself (relay listings), so
   * the "the seller asks for it in chat" note would be wrong. */
  showAddressNote?: boolean;
}

/** "Ships worldwide" vs a short country list for an option row's sub-label. */
function scopeLabel(option: ShippingOption, t: TranslateFn): string {
  if (option.countries.length === 0) return t('market.shipping.worldwide');
  const names = option.countries.slice(0, 3).map(countryName);
  const more = option.countries.length - names.length;
  const countries = names.join(', ');
  return more > 0
    ? t('market.shipping.shipsToMore', { countries, count: more })
    : t('market.shipping.shipsTo', { countries });
}

/**
 * Country-first shipping selection inside the Market checkout (#948 Option A):
 * a required "Ship to" country row, then only the merchant's kind-30406
 * options compatible with that country. Zero matches renders an honest empty
 * state with a "Message the shop" affordance instead of letting the buyer
 * place an unshippable order.
 */
const MarketShippingSection: React.FC<Props> = ({
  status,
  retry,
  compatibleOptions,
  countryCode,
  onOpenCountryPicker,
  selectedCoordinate,
  onSelectOption,
  costSatsByCoordinate,
  sellerName,
  onMessageShop,
  showAddressNote = true,
}) => {
  const colors = useThemeColors();
  const { t, formatLocale } = useLocale();
  const styles = useMemo(() => createMarketShippingSectionStyles(colors), [colors]);

  if (status === 'loading') {
    return (
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>{t('market.shipping.label')}</Text>
        <View style={styles.statusRow} testID="market-shipping-loading">
          <BrandedSpinner size="small" />
          <Text style={styles.statusText}>
            {t('market.shipping.checking', { seller: sellerName })}
          </Text>
        </View>
      </View>
    );
  }

  if (status === 'error') {
    return (
      <View style={styles.section}>
        <Text style={styles.sectionLabel}>{t('market.shipping.label')}</Text>
        <View style={styles.statusRow} testID="market-shipping-error">
          <Text style={styles.statusText}>{t('market.shipping.loadError')}</Text>
          <TouchableOpacity
            onPress={retry}
            accessibilityRole="button"
            accessibilityLabel={t('market.shipping.retryAccessibility')}
            testID="market-shipping-retry"
          >
            <Text style={styles.retryText}>{t('market.shipping.retry')}</Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  return (
    <View style={styles.section}>
      <Text style={styles.sectionLabel}>{t('market.shipping.label')}</Text>

      <TouchableOpacity
        style={styles.countryRow}
        onPress={onOpenCountryPicker}
        accessibilityRole="button"
        accessibilityLabel={
          countryCode
            ? t('market.shipping.shipTo', { country: countryName(countryCode) })
            : t('market.shipping.chooseCountry')
        }
        testID="market-shipping-country"
      >
        {countryCode ? (
          <Text style={styles.countryLabel}>{countryName(countryCode)}</Text>
        ) : (
          <Text style={styles.countryPlaceholder}>
            {t('market.shipping.chooseCountryPlaceholder')}
          </Text>
        )}
        <View style={styles.countryChevronWrap}>
          <Globe size={16} color={colors.textSupplementary} strokeWidth={2} />
          <ChevronRight size={16} color={colors.textSupplementary} strokeWidth={2.5} />
        </View>
      </TouchableOpacity>

      {countryCode ? (
        compatibleOptions.length === 0 ? (
          <View style={styles.emptyWrap} testID="market-shipping-empty">
            <Text style={styles.emptyText}>
              {t('market.shipping.noShip', { country: countryName(countryCode) })}
            </Text>
            <TouchableOpacity
              style={styles.messageShopButton}
              onPress={onMessageShop}
              accessibilityRole="button"
              accessibilityLabel={t('market.shipping.message', { seller: sellerName })}
              testID="market-shipping-message-shop"
            >
              <MessageCircle size={15} color={colors.brandPink} strokeWidth={2.5} />
              <Text style={styles.messageShopText}>
                {t('market.shipping.message', { seller: sellerName })}
              </Text>
            </TouchableOpacity>
          </View>
        ) : (
          compatibleOptions.map((option) => {
            const isSelected = option.coordinate === selectedCoordinate;
            const costSats = costSatsByCoordinate.get(option.coordinate);
            return (
              <TouchableOpacity
                key={option.coordinate}
                style={[styles.optionRow, isSelected && styles.optionRowSelected]}
                onPress={() => onSelectOption(option.coordinate)}
                accessibilityRole="button"
                accessibilityState={{ selected: isSelected }}
                accessibilityLabel={t('market.shipping.optionAccessibility', {
                  title: option.title,
                })}
                testID={`market-shipping-option-${option.dTag}`}
              >
                <View style={styles.optionInfo}>
                  <Text style={styles.optionTitle} numberOfLines={1}>
                    {option.title}
                  </Text>
                  <Text style={styles.optionScope} numberOfLines={1}>
                    {scopeLabel(option, t)}
                  </Text>
                </View>
                <Text style={styles.optionCost}>
                  {costSats === null || costSats === undefined
                    ? // Fiat rate unavailable — show the merchant's own pricing
                      // rather than a wrong sats figure; submit stays blocked.
                      t('market.shipping.priceFallback', {
                        amount: option.baseAmount,
                        currency: option.currency || '?',
                      })
                    : costSats === 0
                      ? t('market.free')
                      : t('market.sats', { amount: costSats.toLocaleString(formatLocale) })}
                  <FiatAmount inline sats={costSats} />
                </Text>
              </TouchableOpacity>
            );
          })
        )
      ) : null}

      {/* The order carries only the chosen shipping option — there is no
          address form, so say where the address actually gets collected. */}
      {showAddressNote ? (
        <Text style={styles.addressNote} testID="market-shipping-address-note">
          {t('market.shipping.addressInChat', { seller: sellerName })}
        </Text>
      ) : null}
    </View>
  );
};

export default MarketShippingSection;
