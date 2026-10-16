import BrandedSpinner from '../components/BrandedSpinner';
import { SellerSigningError } from '../utils/sellerSigning';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { Plus } from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { useSellerShop } from '../hooks/useSellerShop';
import {
  SellerFetchError,
  StaleRevisionError,
  useSellerActions,
  type ShopBase,
} from '../hooks/useSellerActions';
import { Alert } from '../components/BrandedAlert';
import { Toast } from '../components/BrandedToast';
import MarketSellerHeader from '../components/MarketSellerHeader';
import ShippingZoneEditor from '../components/ShippingZoneEditor';
import CountryPickerSheet from '../components/CountryPickerSheet';
import { createMarketSellerStyles } from '../styles/MarketSeller.styles';
import { deviceCountryCode } from '../data/countries';
import {
  MAX_SHIPPING_ZONES,
  newIdentifier,
  validateShop,
  zoneDraftFromOption,
  type ShippingZoneDraft,
} from '../utils/marketSellerEvents';
import type { ExploreNavigation } from '../navigation/types';

interface Props {
  navigation: ExploreNavigation;
}

/** The shop's kind-30406 shipping options (#1534, moved out of the old shop
 * settings screen). Every save checks the current revision of each option
 * first (fail closed), so a stale form never overwrites newer data. */
const MarketShopShippingScreen: React.FC<Props> = ({ navigation }) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createMarketSellerStyles(colors), [colors]);
  const { snapshot, status, refresh, defaultCurrency } = useSellerShop();
  const { saveShop, busy } = useSellerActions(snapshot);
  const currency = defaultCurrency ?? 'SATS';
  const [zones, setZones] = useState<ShippingZoneDraft[] | null>(null);
  const [showErrors, setShowErrors] = useState(false);
  const [pickingZone, setPickingZone] = useState<number | null>(null);
  // The revisions the form was loaded from: an untouched form follows newer
  // revisions; a touched one asks before overwriting them.
  const [base, setBase] = useState<ShopBase | null>(null);
  const [dirty, setDirty] = useState(false);
  // Options start collapsed; one the seller just added opens to be filled in.
  const added = useRef(new Set<string>());
  const edit = useCallback((update: (prev: ShippingZoneDraft[]) => ShippingZoneDraft[]) => {
    setDirty(true);
    setZones((prev) => (prev ? update(prev) : prev));
  }, []);

  // Seed only from a COMPLETED fetch. A failed fetch must not offer a blank
  // form: saving it would delete every existing option.
  useEffect(() => {
    if (dirty || status !== 'ready') return;
    const next = snapshot.zones.map(zoneDraftFromOption);
    setZones((previous) => (JSON.stringify(previous) === JSON.stringify(next) ? previous : next));
    setBase({
      shop: snapshot.shop,
      zoneCoordinates: snapshot.zones.map((z) => z.coordinate),
      zoneEvents: new Map(snapshot.zoneEvents),
    });
  }, [dirty, snapshot.shop, snapshot.zones, snapshot.zoneEvents, status]);

  const errors = useMemo(() => (zones ? validateShop({ currency }, zones) : []), [zones, currency]);

  const onZoneChange = useCallback(
    (index: number, zone: ShippingZoneDraft) =>
      edit((prev) => prev.map((z, i) => (i === index ? zone : z))),
    [edit],
  );
  const onZoneRemove = useCallback(
    (index: number) => edit((prev) => prev.filter((_, i) => i !== index)),
    [edit],
  );
  const onAddZone = useCallback(() => {
    const home = deviceCountryCode();
    const dTag = newIdentifier('shipping');
    added.current.add(dTag);
    edit((prev) => [
      ...prev,
      {
        dTag,
        name: t('market.sell.zone.defaultName'),
        countries: home ? [home] : [],
        cost: '',
        currency,
      },
    ]);
  }, [edit, t, currency]);
  const onPickCountry = useCallback(
    (code: string) => {
      if (pickingZone === null) return;
      edit((prev) =>
        prev.map((z, i) =>
          i === pickingZone && !z.countries.includes(code)
            ? { ...z, countries: [...z.countries, code] }
            : z,
        ),
      );
      setPickingZone(null);
    },
    [pickingZone, edit],
  );

  const onSave = useCallback(async () => {
    if (!zones) return;
    if (errors.length > 0) {
      setShowErrors(true);
      Toast.show({ type: 'error', text1: t('market.sell.shop.fixErrors') });
      return;
    }
    const reload = () => {
      // Show the newer options the relays just returned.
      setDirty(false);
      setBase(null);
      setZones(null);
      refresh();
    };
    const save = async (force: boolean) => {
      try {
        await saveShop(
          { currency },
          zones,
          base ?? { shop: null, zoneCoordinates: [], zoneEvents: new Map() },
          { force },
        );
        Toast.show({ type: 'success', text1: t('market.sell.shipping.saved') });
        navigation.goBack();
      } catch (e) {
        if (e instanceof SellerFetchError) {
          // Unknown is not "no options": never publish blind.
          Toast.show({ type: 'error', text1: t('market.sell.loadFailedTryAgain') });
          return;
        }
        if (e instanceof StaleRevisionError) {
          if (!e.base) {
            Toast.show({ type: 'info', text1: t('market.sell.shop.existingFound') });
            reload();
            return;
          }
          Alert.alert(t('market.sell.conflictTitle'), t('market.sell.shop.conflictBody'), [
            { text: t('market.sell.cancel'), style: 'cancel', onPress: reload },
            { text: t('market.sell.overwrite'), onPress: () => void save(true) },
          ]);
          return;
        }
        Toast.show({
          type: 'error',
          text1: t('market.sell.shipping.saveFailed'),
          text2: e instanceof SellerSigningError ? undefined : (e as Error).message,
        });
      }
    };
    await save(false);
  }, [zones, errors, base, currency, saveShop, refresh, navigation, t]);

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      testID="shop-shipping-screen"
    >
      <MarketSellerHeader
        title={t('market.sell.hub.shipping')}
        backLabel={t('market.sell.back')}
        onBack={() => navigation.goBack()}
        testID="shop-shipping-back"
      />
      {!zones ? (
        <View style={styles.centered}>
          {status === 'error' ? (
            <>
              <Text style={[styles.cardBody, styles.centerText]}>{t('market.sell.loadError')}</Text>
              <TouchableOpacity
                style={styles.secondaryButton}
                onPress={refresh}
                accessibilityLabel={t('market.sell.retry')}
                testID="shop-shipping-retry"
              >
                <Text style={styles.secondaryButtonText}>{t('market.sell.retry')}</Text>
              </TouchableOpacity>
            </>
          ) : (
            <>
              <BrandedSpinner />
              <Text style={styles.muted}>{t('market.sell.loading')}</Text>
            </>
          )}
        </View>
      ) : (
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <Text style={styles.hint}>{t('market.sell.shop.shippingHint')}</Text>
          {zones.length === 0 ? (
            <Text style={styles.muted} testID="shop-shipping-empty">
              {t('market.sell.shipping.empty')}
            </Text>
          ) : null}
          {zones.map((zone, index) => (
            <ShippingZoneEditor
              key={zone.dTag}
              zone={zone}
              index={index}
              currency={zone.currency}
              showErrors={showErrors}
              styles={styles}
              onChange={onZoneChange}
              onRemove={onZoneRemove}
              onAddCountry={setPickingZone}
              initiallyOpen={added.current.has(zone.dTag)}
            />
          ))}
          {zones.length < MAX_SHIPPING_ZONES ? (
            <TouchableOpacity
              style={styles.secondaryButton}
              onPress={onAddZone}
              accessibilityLabel={t('market.sell.shop.addZone')}
              testID="shop-add-zone"
            >
              <Plus size={18} color={colors.brandPink} strokeWidth={2.5} />
              <Text style={styles.secondaryButtonText}>{t('market.sell.shop.addZone')}</Text>
            </TouchableOpacity>
          ) : null}
          <View style={styles.formActions}>
            {showErrors
              ? errors.map((error) => (
                  <Text key={error} style={styles.errorText}>
                    {t(`market.sell.errors.${error}`)}
                  </Text>
                ))
              : null}
            <TouchableOpacity
              style={[styles.primaryButton, busy && styles.primaryButtonDisabled]}
              onPress={() => void onSave()}
              disabled={busy}
              accessibilityState={{ disabled: busy, busy }}
              accessibilityLabel={t('market.sell.shipping.save')}
              testID="shop-shipping-save"
            >
              {busy ? <BrandedSpinner onGradient /> : null}
              <Text style={[styles.primaryButtonText, styles.shopSaveButtonText]}>
                {busy ? t('market.sell.shop.saving') : t('market.sell.shipping.save')}
              </Text>
            </TouchableOpacity>
          </View>
        </ScrollView>
      )}
      <CountryPickerSheet
        visible={pickingZone !== null}
        onClose={() => setPickingZone(null)}
        selectedCode={null}
        onSelect={onPickCountry}
      />
    </KeyboardAvoidingView>
  );
};

export default MarketShopShippingScreen;
