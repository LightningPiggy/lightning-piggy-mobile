import FiatAmount from './FiatAmount';
import MarketHeader from './MarketHeader';
import BrandedSpinner from './BrandedSpinner';
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { View, Text, TouchableOpacity, Linking } from 'react-native';
import { Image } from 'expo-image';
import {
  BottomSheetScrollView,
  BottomSheetBackdrop,
  BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { BottomSheetModal } from './AccessibleBottomSheetModal';
import { Zap, Plus, Minus, Check, ExternalLink, LogIn } from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useLocale } from '../contexts/LocaleContext';
import { createMarketCheckoutSheetStyles } from '../styles/MarketCheckoutSheet.styles';
import { useMarketCheckout } from '../hooks/useMarketCheckout';
import type { OrderShippingInput } from '../utils/marketOrder';
import { useShippingOptions } from '../hooks/useShippingOptions';
import { useBtcRates } from '../hooks/useBtcRates';
import { filterShippingOptions, orderTotalWithShippingSats } from '../utils/marketShipping';
import {
  checkoutRateCurrencies,
  checkoutShippingCostSats,
  checkoutShippingOptions,
  checkoutUnitPriceSats,
  isSatsDenominated,
} from '../utils/marketCheckoutPricing';
import { composeDeliveryAddress } from '../utils/deliveryAddress';
import { useCheckoutAddress } from '../hooks/useCheckoutAddress';
import MarketDeliveryAddress from './MarketDeliveryAddress';
import { useCheckoutCountry } from '../hooks/useCheckoutCountry';
import MarketShippingSection from './MarketShippingSection';
import CountryPickerSheet from './CountryPickerSheet';
import Toast from './BrandedToast';
import type { MarketProduct } from '../data/marketProducts';
import { maxOrderQuantity, type MarketCheckoutTarget } from '../utils/marketCheckout';
import { titleInitial } from '../utils/titleInitial';

interface Props {
  visible: boolean;
  onClose: () => void;
  product: MarketProduct;
  /** Resolved by `marketCheckoutTarget`: order recipient, the listing `d`
   * tag, fulfilment and — for relay listings — price, stock and shipping refs. */
  checkout: MarketCheckoutTarget;
  sellerName: string;
  /** Seller logo, threaded into the conversation the buyer lands in. */
  vendorLogo?: string;
  /** Open the sign-in sheet (owned by the parent screen). */
  onRequestSignIn: () => void;
  /** Fired after a successful order so the parent can navigate to the vendor conversation. */
  onPlaced: (info: { vendorPubkey: string; vendorName: string; vendorLogo?: string }) => void;
  /** Open My orders from the order-placed state. */
  onViewOrders?: () => void;
}

/**
 * In-app Market checkout (#market). Replaces the old "open the seller's website"
 * link with a place-order-and-pay round trip: the buyer confirms product +
 * quantity, taps **Place order**, and LP gift-wraps a kind-16 `type-1` order to
 * the merchant (NIP-17) via {@link useMarketCheckout}. The merchant's order
 * service replies with a kind-16 `type-2` payment request (a payable order
 * card, #928) in the vendor conversation, which the buyer is navigated to so
 * they can pay it with their Lightning Piggy wallet.
 *
 * Sign-in is gated: a logged-out buyer is prompted to sign in first (the order
 * must be signed by their key). Curated products keep the seller's website as
 * a fallback link; relay listings (Gamma Markets kind 30402) have none — their
 * physical orders carry the buyer's address in the gift-wrapped order instead.
 */
const MarketCheckoutSheet: React.FC<Props> = ({
  visible,
  onClose,
  product,
  checkout,
  sellerName,
  vendorLogo,
  onRequestSignIn,
  onPlaced,
  onViewOrders,
}) => {
  const { vendorPubkey, listingDTag, fulfilment } = checkout;
  const isListing = checkout.source === 'listing';
  const maxQty = maxOrderQuantity(checkout);
  const outOfStock = maxQty === 0;
  // Relay listings put the address on the order; curated sellers ask in chat.
  const needsAddress = isListing && fulfilment === 'physical';
  const colors = useThemeColors();
  const { t, formatLocale } = useLocale();
  const styles = useMemo(() => createMarketCheckoutSheetStyles(colors), [colors]);
  const sheetRef = useRef<BottomSheetModal>(null);
  const { status, error, isPlacing, canOrder, placeOrder, reset } = useMarketCheckout();

  const [quantity, setQuantity] = useState(1);
  const delivery = useCheckoutAddress(visible);
  const [imageFailed, setImageFailed] = useState(false);
  // In-flight guard for the WHOLE submit path (rate revalidation + publish):
  // `isPlacing` only covers the hook's publish, so the ref (synchronous) stops
  // a double tap and the state disables the button / locks the selection.
  const submittingRef = useRef(false);
  const [submitting, setSubmitting] = useState(false);

  // --- Country-first shipping (#948 Option A) ---
  const shipping = useShippingOptions(visible ? vendorPubkey : null, visible, fulfilment);
  const {
    countryCode,
    selectCountry: setCountryCode,
    rememberCountry,
  } = useCheckoutCountry(visible);
  const [countryPickerVisible, setCountryPickerVisible] = useState(false);
  const [chosenCoordinate, setSelectedCoordinate] = useState<string | null>(null);
  // The seller's options this product can ship with: a listing's own
  // `shipping_option` refs, or every option the seller publishes.
  const sellerOptions = useMemo(
    () => checkoutShippingOptions(checkout, shipping.options),
    [checkout, shipping.options],
  );
  // BTC spot rates for every fiat price involved (listing + options). A
  // missing / failed rate (null) leaves that figure unpriced and blocks submit.
  const rateCurrencies = useMemo(
    () => checkoutRateCurrencies(checkout, shipping.status === 'ready' ? sellerOptions : []),
    [checkout, sellerOptions, shipping.status],
  );
  const {
    rates: btcPriceByCurrency,
    refreshRates,
    retry: retryRates,
  } = useBtcRates(rateCurrencies, visible);

  useEffect(() => {
    if (visible) {
      setQuantity(1);
      setImageFailed(false);
      setSelectedCoordinate(null);
      reset();
      sheetRef.current?.present();
    } else {
      // The picker is an independently presented modal — dismiss it with us.
      setCountryPickerVisible(false);
      sheetRef.current?.dismiss();
    }
  }, [visible, reset]);

  // A `physical` product only reaches `ready` with ≥1 merchant option (an
  // empty fetch is an error — see useShippingOptions), so this is the
  // country-first flow. A seller-confirmed `none` product is `ready` with no
  // options and skips the section.
  const hasShipping = shipping.status === 'ready' && sellerOptions.length > 0;
  // Belt and braces for the hook's contract: a physical order must never be
  // signed without a shipping selection.
  const shippingMissing = fulfilment === 'physical' && !hasShipping;

  const compatibleOptions = useMemo(
    () => (hasShipping && countryCode ? filterShippingOptions(sellerOptions, countryCode) : []),
    [hasShipping, sellerOptions, countryCode],
  );

  // Automatic choices are derived, so they do not become implicit choices
  // when a later country or option refresh offers several alternatives.
  const selectedCoordinate =
    compatibleOptions.length === 1
      ? compatibleOptions[0].coordinate
      : compatibleOptions.some((o) => o.coordinate === chosenCoordinate)
        ? chosenCoordinate
        : null;
  useEffect(() => {
    if (chosenCoordinate && !compatibleOptions.some((o) => o.coordinate === chosenCoordinate)) {
      setSelectedCoordinate(null);
    }
  }, [compatibleOptions, chosenCoordinate]);

  // All-in sats cost per option: the option's base (its own currency) plus a
  // listing's `shipping_option` surcharge (the listing currency). null = no rate.
  const costSatsByCoordinate = useMemo(() => {
    const map = new Map<string, number | null>();
    for (const option of sellerOptions) {
      map.set(option.coordinate, checkoutShippingCostSats(option, checkout, btcPriceByCurrency));
    }
    return map;
  }, [sellerOptions, checkout, btcPriceByCurrency]);
  // Unit price in sats — a fiat listing converts at the live rate.
  const unitPriceSats = checkoutUnitPriceSats(product, checkout, btcPriceByCurrency);

  const selectedOption = useMemo(
    () =>
      selectedCoordinate
        ? (compatibleOptions.find((o) => o.coordinate === selectedCoordinate) ?? null)
        : null,
    [compatibleOptions, selectedCoordinate],
  );
  const selectedShippingSats = selectedOption
    ? (costSatsByCoordinate.get(selectedOption.coordinate) ?? null)
    : null;
  // Live selection, readable after an await: the submit handler captured a
  // render-time selection and must not sign a different one.
  const liveSelectionRef = useRef({
    coordinate: selectedCoordinate,
    country: countryCode,
    quantity,
  });
  useLayoutEffect(() => {
    liveSelectionRef.current = { coordinate: selectedCoordinate, country: countryCode, quantity };
  }, [selectedCoordinate, countryCode, quantity]);

  // Submit gate (spec §6): until shipping has settled to `ready` we can't know
  // whether shipping is required, so block for every non-ready state —
  // `idle` (the initial render before the load effect fires), `loading`, and
  // `error` alike. Once ready, only require a country + a compatible option
  // with a priceable sats cost when the merchant actually has options.
  const subtotalSats = unitPriceSats === null ? null : unitPriceSats * quantity;
  // The displayed total is only known once shipping has settled: `ready` with
  // no options (digital goods) or a priced selection. Until then it renders as
  // "—" rather than the bare subtotal masquerading as the order total.
  const shippingSettled =
    shipping.status === 'ready' &&
    !shippingMissing &&
    (!hasShipping || selectedShippingSats !== null);
  const totalSats =
    shippingSettled && subtotalSats !== null
      ? orderTotalWithShippingSats(subtotalSats, selectedShippingSats ?? 0)
      : null;
  const address = composeDeliveryAddress(delivery.fields, countryCode ?? '');
  const addressMissing = needsAddress && !address;
  const shippingBlocksSubmit =
    totalSats === null ||
    outOfStock ||
    quantity > maxQty ||
    addressMissing ||
    shipping.status !== 'ready' ||
    shippingMissing ||
    (hasShipping && (!countryCode || !selectedOption || selectedShippingSats === null));

  // While an order is in flight the sheet must not be dismissable (pan or
  // backdrop): a hidden sheet finishing a publish could later reopen onto a
  // stale success/error state or let a second order through.
  const dismissLocked = submitting || isPlacing;
  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop
        {...props}
        disappearsOnIndex={-1}
        appearsOnIndex={0}
        pressBehavior={dismissLocked ? 'none' : 'close'}
      />
    ),
    [dismissLocked],
  );

  const hasThumb = product.image.length > 0 && !imageFailed;

  const handlePlace = useCallback(async () => {
    if (!canOrder) {
      onRequestSignIn();
      return;
    }
    if (shippingBlocksSubmit) return;
    if (submittingRef.current) return;
    submittingRef.current = true;
    setSubmitting(true);
    try {
      // Revalidate fiat rates at submit: the sheet may have sat open past the
      // rate's 5-minute TTL, and the signed order total must not use an
      // expired conversion. Served from cache while fresh, refetched
      // otherwise; an outage yields null → block and hand off to the retry.
      let unitSats = unitPriceSats;
      let shippingSats = selectedShippingSats;
      if (rateCurrencies.length > 0) {
        const fresh = { ...btcPriceByCurrency, ...(await refreshRates(rateCurrencies)) };
        // Selection changed while we awaited (the section is locked, but a
        // queued tap can still land) → don't sign the captured one.
        if (
          liveSelectionRef.current.coordinate !== selectedCoordinate ||
          liveSelectionRef.current.country !== countryCode ||
          liveSelectionRef.current.quantity !== quantity
        ) {
          return;
        }
        unitSats = checkoutUnitPriceSats(product, checkout, fresh);
        shippingSats =
          hasShipping && selectedOption
            ? checkoutShippingCostSats(selectedOption, checkout, fresh)
            : selectedShippingSats;
        if (unitSats === null || (hasShipping && shippingSats === null)) {
          retryRates();
          return;
        }
        // Never sign a total the buyer hasn't seen: if the fresh rate moved
        // a figure, let the sheet re-render the new total and require a
        // second tap.
        if (unitSats !== unitPriceSats || shippingSats !== selectedShippingSats) {
          Toast.show({
            type: 'info',
            text1: t('market.checkout.rateUpdated'),
            position: 'top',
            visibilityTime: 3000,
          });
          return;
        }
      }
      if (unitSats === null) return;
      let shippingInput: OrderShippingInput | undefined;
      if (hasShipping && selectedOption && shippingSats !== null) {
        shippingInput = {
          coordinate: selectedOption.coordinate,
          costSats: shippingSats,
          title: selectedOption.title,
        };
      }
      await placeOrder({
        vendorPubkey,
        dTag: listingDTag,
        priceSats: unitSats,
        quantity,
        shipping: shippingInput,
        ...(needsAddress ? { address: address ?? '' } : {}),
        title: product.title,
      });
      if (needsAddress) await delivery.save();
      if (hasShipping) rememberCountry();
      Toast.show({
        type: 'success',
        text1: t('market.checkout.toastPlaced'),
        text2: t('market.checkout.toastPlacedBody', { seller: sellerName }),
        position: 'top',
        visibilityTime: 2600,
      });
    } catch {
      // Error surfaced inline via `error`; nothing else to do here.
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }, [
    canOrder,
    onRequestSignIn,
    placeOrder,
    vendorPubkey,
    listingDTag,
    product,
    checkout,
    unitPriceSats,
    quantity,
    sellerName,
    shippingBlocksSubmit,
    hasShipping,
    selectedOption,
    selectedCoordinate,
    selectedShippingSats,
    countryCode,
    rememberCountry,
    rateCurrencies,
    btcPriceByCurrency,
    refreshRates,
    retryRates,
    needsAddress,
    delivery,
    address,
    t,
  ]);

  const handleGoToConversation = useCallback(() => {
    onPlaced({ vendorPubkey, vendorName: sellerName, vendorLogo });
    onClose();
  }, [onPlaced, vendorPubkey, sellerName, vendorLogo, onClose]);

  const openWebsite = useCallback(() => {
    Linking.openURL(product.url).catch(() => {
      // Swallow — a malformed/unsupported URL shouldn't crash the sheet.
    });
  }, [product.url]);

  return (
    <BottomSheetModal
      ref={sheetRef}
      enablePanDownToClose={!dismissLocked}
      enableDynamicSizing
      backdropComponent={renderBackdrop}
      backgroundStyle={styles.sheetBackground}
      handleIndicatorStyle={styles.handle}
      onDismiss={onClose}
    >
      {/* Scrollable body: a merchant can publish many shipping options, and a
          dynamically-sized sheet is capped by the viewport — the list and the
          Place order button must stay reachable. */}
      <BottomSheetScrollView
        contentContainerStyle={styles.container}
        keyboardShouldPersistTaps="handled"
        testID="market-checkout-sheet"
      >
        {status === 'sent' ? (
          <View style={styles.sentWrap}>
            <View style={styles.sentBadge}>
              <Check size={28} color={colors.greenDark} strokeWidth={3} />
            </View>
            <Text style={styles.sentTitle}>{t('market.checkout.orderPlaced')}</Text>
            <Text style={styles.sentBody}>
              {t('market.checkout.orderSentBody', { seller: sellerName })}
            </Text>
            <TouchableOpacity
              style={styles.primaryButton}
              onPress={handleGoToConversation}
              accessibilityRole="button"
              accessibilityLabel={t('market.checkout.openConversation', { seller: sellerName })}
              testID="market-checkout-goto-conversation"
            >
              <Zap size={16} color={colors.white} strokeWidth={2.5} fill={colors.white} />
              {/* numberOfLines + adjustsFontSizeToFit + flexShrink guarantee the
                  label always fits on one line: under @gorhom/bottom-sheet's
                  `enableDynamicSizing` measure pass the button can briefly hug
                  its content instead of filling the centered success column, and
                  a plain <Text> would then clip ("o to chat to pa"). Shrinking
                  the font (down to 85%) rather than the text is the robust fix. */}
              <Text
                style={styles.primaryButtonText}
                numberOfLines={1}
                adjustsFontSizeToFit
                minimumFontScale={0.85}
              >
                {t('market.checkout.goToChat')}
              </Text>
            </TouchableOpacity>
            {onViewOrders ? (
              <TouchableOpacity
                style={styles.fallbackLink}
                onPress={() => {
                  onClose();
                  onViewOrders();
                }}
                accessibilityRole="link"
                accessibilityLabel={t('myOrders.open')}
                testID="market-checkout-my-orders"
              >
                <Text style={styles.fallbackLinkText}>{t('myOrders.viewAll')}</Text>
              </TouchableOpacity>
            ) : null}
          </View>
        ) : (
          <>
            <View style={styles.header}>
              <MarketHeader
                title={t('market.detail.buyFrom', { seller: sellerName })}
                backLabel={t('market.detail.back')}
                onBack={onClose}
                testID="market-checkout-back"
                insetTop={false}
                backDisabled={dismissLocked}
              />
            </View>

            <View style={styles.productRow}>
              {hasThumb ? (
                <Image
                  source={{ uri: product.image }}
                  style={styles.thumb}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                  recyclingKey={product.image}
                  onError={() => setImageFailed(true)}
                />
              ) : (
                <View style={styles.thumbFallback}>
                  <Text style={styles.thumbFallbackText}>{titleInitial(product.title)}</Text>
                </View>
              )}
              <View style={styles.productInfo}>
                <Text style={styles.productTitle} numberOfLines={2}>
                  {product.title}
                </Text>
                <Text style={styles.productSeller}>
                  {t('market.fromSeller', { seller: sellerName })}
                </Text>
                <Text style={styles.unitPrice} testID="market-checkout-unit-price">
                  {isListing && checkout.price && isSatsDenominated(checkout.price.currency)
                    ? t('market.checkout.unitPriceSats', {
                        amount: unitPriceSats?.toLocaleString(formatLocale) ?? '—',
                      })
                    : t('market.checkout.unitPrice', {
                        amount: unitPriceSats?.toLocaleString(formatLocale) ?? '—',
                        fiat: product.priceFiatLabel,
                      })}
                  <FiatAmount inline sats={unitPriceSats} testID="market-checkout-unit-fiat" />
                </Text>
              </View>
            </View>

            <View style={styles.row}>
              <Text style={styles.rowLabel}>{t('market.checkout.quantity')}</Text>
              <View style={styles.stepper}>
                <TouchableOpacity
                  style={[styles.stepButton, quantity <= 1 && styles.stepButtonDisabled]}
                  onPress={() => setQuantity((q) => Math.max(1, q - 1))}
                  disabled={quantity <= 1 || submitting || isPlacing}
                  accessibilityRole="button"
                  accessibilityLabel={t('market.checkout.decreaseQuantity')}
                  testID="market-checkout-qty-minus"
                >
                  <Minus
                    size={18}
                    color={quantity <= 1 ? colors.divider : colors.brandPink}
                    strokeWidth={2.5}
                  />
                </TouchableOpacity>
                <Text style={styles.qtyText} testID="market-checkout-qty">
                  {quantity}
                </Text>
                <TouchableOpacity
                  style={[styles.stepButton, quantity >= maxQty && styles.stepButtonDisabled]}
                  onPress={() => setQuantity((q) => Math.min(maxQty, q + 1))}
                  disabled={quantity >= maxQty || submitting || isPlacing}
                  accessibilityRole="button"
                  accessibilityLabel={t('market.checkout.increaseQuantity')}
                  testID="market-checkout-qty-plus"
                >
                  <Plus
                    size={18}
                    color={quantity >= maxQty ? colors.divider : colors.brandPink}
                    strokeWidth={2.5}
                  />
                </TouchableOpacity>
              </View>
            </View>

            {checkout.stock !== null ? (
              <Text style={styles.stockNote} testID="market-checkout-stock">
                {outOfStock
                  ? t('market.checkout.outOfStock')
                  : t('market.checkout.inStock', { stock: checkout.stock })}
              </Text>
            ) : null}

            {shipping.status !== 'idle' && (hasShipping || shipping.status !== 'ready') ? (
              <MarketShippingSection
                status={shipping.status}
                retry={shipping.retry}
                compatibleOptions={compatibleOptions}
                countryCode={countryCode}
                onOpenCountryPicker={() => {
                  if (!submitting) setCountryPickerVisible(true);
                }}
                selectedCoordinate={selectedCoordinate}
                onSelectOption={(coordinate) => {
                  if (!submitting) setSelectedCoordinate(coordinate);
                }}
                costSatsByCoordinate={costSatsByCoordinate}
                sellerName={sellerName}
                onMessageShop={handleGoToConversation}
                showAddressNote={!needsAddress}
              />
            ) : null}

            {needsAddress ? (
              <MarketDeliveryAddress
                delivery={delivery}
                countryCode={countryCode}
                disabled={submitting || isPlacing}
                onOpenCountryPicker={() => {
                  if (!submitting && !isPlacing) setCountryPickerVisible(true);
                }}
                sellerName={sellerName}
              />
            ) : null}

            {hasShipping ? (
              <>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>{t('market.checkout.subtotal')}</Text>
                  <Text
                    style={[styles.summaryValue, styles.amountColumn]}
                    testID="market-checkout-subtotal"
                  >
                    {t('market.sats', {
                      amount: subtotalSats?.toLocaleString(formatLocale) ?? '—',
                    })}
                    <FiatAmount inline sats={subtotalSats} testID="market-checkout-subtotal-fiat" />
                  </Text>
                </View>
                <View style={styles.summaryRow}>
                  <Text style={styles.summaryLabel}>{t('market.checkout.shipping')}</Text>
                  <Text
                    style={[styles.summaryValue, styles.amountColumn]}
                    testID="market-checkout-shipping"
                  >
                    {selectedShippingSats !== null
                      ? selectedShippingSats === 0
                        ? t('market.free')
                        : t('market.sats', {
                            amount: selectedShippingSats.toLocaleString(formatLocale),
                          })
                      : '—'}
                    <FiatAmount
                      inline
                      sats={selectedShippingSats}
                      testID="market-checkout-shipping-fiat"
                    />
                  </Text>
                </View>
              </>
            ) : null}

            <View style={styles.totalRow}>
              <Text style={styles.totalLabel}>{t('market.checkout.total')}</Text>
              <View style={styles.totalValue}>
                <Zap size={16} color={colors.brandPink} strokeWidth={2.5} fill={colors.brandPink} />
                <Text style={styles.totalSats} testID="market-checkout-total">
                  {t('market.sats', { amount: totalSats?.toLocaleString(formatLocale) ?? '—' })}
                  <FiatAmount inline sats={totalSats} testID="market-checkout-total-fiat" />
                </Text>
              </View>
            </View>

            <TouchableOpacity
              style={[
                styles.primaryButton,
                (isPlacing || submitting || (canOrder && shippingBlocksSubmit)) &&
                  styles.primaryButtonDisabled,
              ]}
              onPress={handlePlace}
              disabled={isPlacing || submitting || (canOrder && shippingBlocksSubmit)}
              activeOpacity={0.85}
              accessibilityRole="button"
              accessibilityLabel={
                canOrder
                  ? t('market.checkout.placeOrderAccessibility', { seller: sellerName })
                  : t('market.checkout.signInToBuy')
              }
              testID="market-checkout-place-order"
            >
              {isPlacing || submitting ? (
                <BrandedSpinner size="small" onGradient />
              ) : canOrder ? (
                <>
                  <Zap size={16} color={colors.white} strokeWidth={2.5} fill={colors.white} />
                  <Text style={styles.primaryButtonText}>{t('market.checkout.placeOrder')}</Text>
                </>
              ) : (
                <>
                  <LogIn size={16} color={colors.white} strokeWidth={2.5} />
                  <Text style={styles.primaryButtonText}>{t('market.checkout.signInToBuy')}</Text>
                </>
              )}
            </TouchableOpacity>

            {error ? (
              <Text style={styles.errorText} testID="market-checkout-error">
                {error}
              </Text>
            ) : (
              <Text style={styles.hint}>{t('market.checkout.hint')}</Text>
            )}

            {isListing ? null : (
              <TouchableOpacity
                style={styles.fallbackLink}
                onPress={openWebsite}
                accessibilityRole="link"
                accessibilityLabel={t('market.checkout.openWebsiteAccessibility', {
                  seller: sellerName,
                })}
                testID="market-checkout-website"
              >
                <ExternalLink size={14} color={colors.brandPink} strokeWidth={2.5} />
                <Text style={styles.fallbackLinkText}>
                  {t('market.checkout.websiteFallback', { seller: sellerName })}
                </Text>
              </TouchableOpacity>
            )}
          </>
        )}
      </BottomSheetScrollView>

      <CountryPickerSheet
        visible={countryPickerVisible}
        onClose={() => setCountryPickerVisible(false)}
        selectedCode={countryCode}
        onSelect={(country) => {
          setSelectedCoordinate(null);
          setCountryCode(country);
        }}
      />
    </BottomSheetModal>
  );
};

export default MarketCheckoutSheet;
