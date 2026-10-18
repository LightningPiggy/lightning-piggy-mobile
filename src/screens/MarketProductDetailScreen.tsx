import MarketHeader from '../components/MarketHeader';
import BrandedRefreshControl from '../components/BrandedRefreshControl';
import { marketEditorDestination } from '../utils/marketEditorNavigation';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, Linking } from 'react-native';
import { KeyboardAwareScrollView } from 'react-native-keyboard-controller';
import { Zap, ExternalLink } from 'lucide-react-native';
import type { CompositeNavigationProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { useThemeColors } from '../contexts/ThemeContext';
import { useLocale } from '../contexts/LocaleContext';
import { useNostr } from '../contexts/NostrContext';
import { openDirectChat } from '../utils/openDirectChat';
import { createMarketProductDetailStyles } from '../styles/MarketProductDetailScreen.styles';
import { MARKET_PRODUCTS, sellerOf } from '../data/marketProducts';
import { vendorNostrPubkey } from '../utils/marketVendors';
import { marketFeedbackContext } from '../utils/marketFeedback';
import { marketCheckoutTarget } from '../utils/marketCheckout';
import { perfLog } from '../utils/perfLog';
import VendorAvatar from '../components/VendorAvatar';
import ProductFeedbackTabs from '../components/ProductFeedbackTabs';
import NostrLoginSheet from '../components/NostrLoginSheet';
import MarketCheckoutSheet from '../components/MarketCheckoutSheet';
import MarketPrice from '../components/MarketPrice';
import MarketListingActions from '../components/MarketListingActions';
import { Toast } from '../components/BrandedToast';
import { usePullToRefresh, useRegisterRefresher } from '../hooks/usePullToRefresh';
import { useLatestListing } from '../hooks/useLatestListing';
import MarketListingDetails from '../components/MarketListingDetails';
import MarketProductGallery from '../components/MarketProductGallery';
import MarkdownText from '../components/MarkdownText';
import MarketProductRecommendations from '../components/MarketProductRecommendations';
import { usePubkeyProfile } from '../hooks/usePubkeyProfile';
import type {
  ExploreNavigation,
  MarketProductDetailRoute,
  RootStackParamList,
} from '../navigation/types';

// Composite nav type so the "Buy" flow can `navigate('Conversation', …)` after
// placing an order — the Conversation route lives on the root stack, not the
// Explore stack (same pattern as HuntPiggyDetailScreen).
type MarketProductDetailNavigation = CompositeNavigationProp<
  ExploreNavigation,
  NativeStackNavigationProp<RootStackParamList>
>;

interface Props {
  navigation: MarketProductDetailNavigation;
  route: MarketProductDetailRoute;
}

/**
 * Space kept between a focused feedback input's caret and the keyboard — room
 * for the button row under it (Post, or a comment card's Cancel / Save).
 */
const FEEDBACK_INPUT_BOTTOM_OFFSET = 72;

/**
 * Full Market PRODUCT page opened from a grid tile: product image, title,
 * price, seller (avatar + name), description and a buy affordance (the in-app
 * checkout sheet for products explicitly opted in via `checkout`; the seller's
 * shop URL otherwise), followed by Nostr Reviews (kind 31555) + Comments (kind
 * 1111) in an underlined tabbed section — mirroring the companion website's
 * product page. Reviews/comments are shown only when the seller has a Nostr
 * identity to root them on. Pull down to refresh the listing (it may have
 * been edited) and load new reviews / comments (#1301).
 */
const MarketProductDetailScreen: React.FC<Props> = ({ navigation, route }) => {
  const colors = useThemeColors();
  const { t } = useLocale();
  // Pairs with `market product tap` on the Market screen: tap-to-first-commit.
  useEffect(() => perfLog('[PerfBlock] market product detail shown'), []);
  const styles = useMemo(() => createMarketProductDetailStyles(colors), [colors]);
  const [loginVisible, setLoginVisible] = useState(false);
  const [checkoutVisible, setCheckoutVisible] = useState(false);
  const { pubkey } = useNostr();
  // `preview` = an unpublished draft from the listing editor (#1273).
  const preview = route.params.preview === true;

  const routeProduct = useMemo(
    () =>
      route.params.product?.id === route.params.productId
        ? route.params.product
        : MARKET_PRODUCTS.find((p) => p.id === route.params.productId),
    [route.params.productId, route.params.product],
  );
  const { product, withdrawn, refresh: refreshListing } = useLatestListing(routeProduct);
  // Pull-to-refresh: the listing plus each mounted feedback section (#1301).
  const onRefreshError = useCallback(
    () => Toast.show({ type: 'error', text1: t('market.detail.refreshFailed') }),
    [t],
  );
  // A seller's preview of an unpublished draft (#1273) has nothing on relays
  // to refresh, and its `d` tag must not be queried.
  const pull = usePullToRefresh(onRefreshError, { enabled: !preview });
  const { register } = pull;
  useRegisterRefresher(register, refreshListing);
  const listedVendor = useMemo(() => (product ? sellerOf(product) : undefined), [product]);
  // Relay listings: show the seller's Nostr profile name + avatar (shared
  // profile cache), not the short-key placeholder the parser starts with.
  const sellerProfile = usePubkeyProfile(product?.listing?.event.pubkey ?? null);
  const vendor = useMemo(
    () =>
      listedVendor && product?.listing
        ? {
            ...listedVendor,
            name: sellerProfile.name || listedVendor.name,
            logo: sellerProfile.picture || listedVendor.logo,
          }
        : listedVendor,
    [listedVendor, product?.listing, sellerProfile.name, sellerProfile.picture],
  );
  // Memoised so the comment-thread root identity stays stable across renders.
  const feedback = useMemo(
    () => (product ? marketFeedbackContext(product, vendor) : null),
    [product, vendor],
  );
  // In-app checkout: curated products explicitly opted in with the seller's
  // real listing id, and any other person's priced kind-30402 relay listing
  // (a Gamma Markets order the seller answers with an invoice).
  const checkoutTarget = useMemo(
    () => (product ? marketCheckoutTarget(product, vendor, pubkey) : null),
    [product, vendor, pubkey],
  );

  const onRequestSignIn = useCallback(() => setLoginVisible(true), []);
  // In-app order for opted-in products; external website otherwise.
  const openShop = useCallback(() => {
    if (!product) return;
    if (checkoutTarget) {
      setCheckoutVisible(true);
      return;
    }
    Linking.openURL(product.url).catch(() => {
      // Swallow — a malformed/unsupported URL shouldn't crash the screen.
    });
  }, [product, checkoutTarget]);

  const onOrderPlaced = useCallback(
    (info: { vendorPubkey: string; vendorName: string; vendorLogo?: string }) => {
      // The order went out as a NIP-17 gift wrap (Gamma kinds never ride
      // Marmot): open the NIP-17 thread it's in, where its card waits for
      // the seller's invoice.
      navigation.navigate('Conversation', {
        pubkey: info.vendorPubkey,
        name: info.vendorName,
        picture: info.vendorLogo ?? null,
        protocol: 'nip17',
      });
    },
    [navigation],
  );

  if (!product) {
    return (
      <View style={styles.container} testID="market-product-detail-missing">
        <View style={styles.missing}>
          <Text style={styles.missingText}>{t('market.detail.unavailable')}</Text>
          <TouchableOpacity
            onPress={() => navigation.goBack()}
            accessibilityLabel={t('market.detail.goBack')}
          >
            <Text style={[styles.vendorName, { color: colors.brandPink, marginTop: 12 }]}>
              {t('market.detail.backToMarket')}
            </Text>
          </TouchableOpacity>
        </View>
      </View>
    );
  }

  const sellerName = vendor?.name ?? product.sellerName;
  const listingEvent = product.listing?.event;
  const isOwnListing = !!listingEvent && !!pubkey && listingEvent.pubkey === pubkey;
  const listingDTag = listingEvent?.tags.find((tag) => tag[0] === 'd')?.[1];
  const listingCheckout = checkoutTarget?.source === 'listing';
  const outOfStock = checkoutTarget?.stock === 0;

  return (
    <View style={styles.container} testID="market-product-detail-screen">
      <MarketHeader
        title={product.title}
        backLabel={t('market.detail.back')}
        onBack={() => navigation.goBack()}
        testID="market-product-detail-back"
      />

      {/* Keyboard-aware so the review / comment inputs — the top composer and
          a comment card being edited in place (#1524) — scroll above the IME
          when focused (the app is edge-to-edge, so the window never resizes). */}
      <KeyboardAwareScrollView
        testID="market-product-detail-scroll"
        bottomOffset={FEEDBACK_INPUT_BOTTOM_OFFSET}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        refreshControl={
          pull.enabled ? (
            <BrandedRefreshControl refreshing={pull.refreshing} onRefresh={pull.onRefresh} />
          ) : undefined
        }
      >
        <MarketProductGallery image={product.image} images={product.images} title={product.title} />

        {preview ? null : (
          <MarketListingActions product={product} onRequestSignIn={onRequestSignIn} />
        )}
        <View style={styles.body}>
          {preview ? (
            <View style={styles.previewBanner} testID="market-product-preview-banner">
              <Text style={styles.previewBannerText}>{t('market.sell.detail.previewBanner')}</Text>
            </View>
          ) : null}
          <Text style={styles.title}>{product.title}</Text>
          <MarketPrice product={product} variant="detail" />

          <TouchableOpacity
            style={styles.vendorRow}
            testID="market-seller-shop"
            disabled={!product.listing?.event.pubkey && !(vendor && vendorNostrPubkey(vendor))}
            onPress={() => {
              const pubkey = product.listing?.event.pubkey ?? (vendor && vendorNostrPubkey(vendor));
              if (pubkey)
                navigation.navigate('ContactProfile', {
                  contact: {
                    pubkey,
                    name: sellerName,
                    picture: sellerProfile.picture ?? null,
                    lightningAddress: null,
                    source: 'nostr',
                  },
                  initialTab: 'shop',
                });
            }}
          >
            {vendor ? <VendorAvatar vendor={vendor} size={24} /> : null}
            <Text style={styles.vendorName}>{t('market.fromSeller', { seller: sellerName })}</Text>
          </TouchableOpacity>

          <MarkdownText markdown={product.description} testID="market-product-description" />
          {product.listing && !withdrawn ? (
            <MarketListingDetails
              event={product.listing.event}
              currency={product.listing.currency}
            />
          ) : null}
          {product.listing ? null : (
            // Curated catalogue items carry no Nostr shipping data.
            <Text style={styles.shippingUnknown} testID="market-product-shipping-unknown">
              {t('market.sell.detail.shippingNone')}
            </Text>
          )}
          {withdrawn ? (
            // A refresh found the listing deleted, sold or expired.
            <View style={styles.withdrawn} testID="market-product-detail-withdrawn">
              <Text style={styles.withdrawnText}>{t('market.detail.unavailable')}</Text>
            </View>
          ) : preview ? null : (
            <>
              {isOwnListing && listingDTag ? (
                <TouchableOpacity
                  style={styles.buyButton}
                  testID="market-edit-own-listing"
                  accessibilityLabel={t('market.sell.detail.editListing')}
                  onPress={() => navigation.navigate('Main', marketEditorDestination(listingDTag))}
                >
                  <Text style={styles.buyText}>{t('market.sell.detail.editListing')}</Text>
                </TouchableOpacity>
              ) : null}
              {product.listing && !isOwnListing ? (
                <TouchableOpacity
                  style={styles.buyButton}
                  testID="market-contact-seller"
                  accessibilityLabel={t('market.live.contactSeller')}
                  onPress={() =>
                    void openDirectChat(navigation, pubkey, {
                      pubkey: product.listing!.event.pubkey,
                      name: sellerName,
                      picture: null,
                    })
                  }
                >
                  <Text style={styles.buyText}>{t('market.live.contactSeller')}</Text>
                </TouchableOpacity>
              ) : null}

              {/* Curated products link to the seller's website unless opted in
                to in-app checkout; Nostr listings get Buy (a Gamma order) when
                priced and not your own, else just Message seller. */}
              {product.listing && !checkoutTarget ? null : (
                <TouchableOpacity
                  style={[styles.buyButton, outOfStock && styles.buyButtonDisabled]}
                  onPress={openShop}
                  disabled={outOfStock}
                  testID="market-product-detail-buy"
                  activeOpacity={0.85}
                  accessibilityState={{ disabled: outOfStock }}
                  accessibilityLabel={
                    outOfStock
                      ? t('market.detail.outOfStock')
                      : t('market.detail.buyAccessibility', {
                          title: product.title,
                          seller: sellerName,
                        })
                  }
                >
                  <Zap size={16} color={colors.white} strokeWidth={2.5} fill={colors.white} />
                  <Text style={styles.buyText}>
                    {outOfStock
                      ? t('market.detail.outOfStock')
                      : listingCheckout
                        ? t('market.detail.buy')
                        : t('market.detail.buyFrom', { seller: sellerName })}
                  </Text>
                  {/* The external-link glyph only when Buy leaves the app. */}
                  {checkoutTarget ? null : (
                    <ExternalLink size={16} color={colors.white} strokeWidth={2.5} />
                  )}
                </TouchableOpacity>
              )}
              {listingCheckout ? (
                // The seller may not run a Gamma-aware client: say what happens
                // next, and Message seller stays above as the fallback.
                <Text style={styles.invoiceNote} testID="market-product-detail-invoice-note">
                  {t('market.detail.invoiceNote')}
                </Text>
              ) : null}
            </>
          )}
        </View>

        <View style={styles.divider} />

        {preview ? null : feedback ? (
          <View style={styles.feedbackWrap}>
            <ProductFeedbackTabs
              key={`${feedback.reviewCoord}:${route.params.feedbackTab ?? 'reviews'}`}
              initialTab={route.params.feedbackTab}
              coord={feedback.reviewCoord}
              commentRoot={feedback.commentRoot}
              onRequestSignIn={onRequestSignIn}
              registerRefresh={register}
            />
          </View>
        ) : (
          <View style={styles.noFeedback} testID="market-product-detail-no-feedback">
            <Text style={styles.noFeedbackText}>{t('market.detail.noFeedback')}</Text>
          </View>
        )}

        {/* More from this seller + You might like (#1542). */}
        {preview ? null : (
          <MarketProductRecommendations product={product} sellerName={sellerName} />
        )}
      </KeyboardAwareScrollView>

      {checkoutTarget ? (
        <MarketCheckoutSheet
          visible={checkoutVisible}
          onClose={() => setCheckoutVisible(false)}
          product={product}
          checkout={checkoutTarget}
          sellerName={sellerName}
          vendorLogo={vendor?.logo}
          onRequestSignIn={onRequestSignIn}
          onPlaced={onOrderPlaced}
          onViewOrders={() =>
            navigation.navigate('Main', {
              screen: 'MainTabs',
              params: { screen: 'Explore', params: { screen: 'MarketMyOrders' } },
            })
          }
        />
      ) : null}

      <NostrLoginSheet visible={loginVisible} onClose={() => setLoginVisible(false)} />
    </View>
  );
};

export default MarketProductDetailScreen;
