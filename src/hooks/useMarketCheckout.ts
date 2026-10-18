import { useCallback, useState } from 'react';
import { useNostr } from '../contexts/NostrContext';
import { useTranslation } from '../contexts/LocaleContext';
import { Nip17SendError, canSendNip17, sendNip17Rumor } from '../services/nip17RumorSend';
import { buyerOrderTitleGeneration, recordBuyerOrderTitles } from '../services/buyerOrderTitles';
import {
  buildMarketOrder,
  productCoordinate,
  type MarketOrderLine,
  type OrderShippingInput,
} from '../utils/marketOrder';

/**
 * Stable, translatable reason a checkout failed. The raw Error thrown alongside
 * each code keeps a developer-facing message for logs/diagnostics; the UI copy
 * is looked up from `market.checkout.errors.<code>` so it follows the app's
 * locale rather than surfacing raw English.
 */
export type CheckoutErrorCode =
  | 'notSignedIn'
  | 'noSellerIdentity'
  | 'signingKeyMissing'
  | 'unsupportedSigner'
  | 'relayUnreachable'
  | 'generic';

/** Error carrying a {@link CheckoutErrorCode} so the hook can map it to copy. */
class CheckoutError extends Error {
  constructor(
    readonly code: CheckoutErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CheckoutError';
  }
}

/** Map the shared NIP-17 send failure onto the checkout's copy keys. */
function checkoutCode(e: unknown): CheckoutErrorCode {
  if (e instanceof CheckoutError) return e.code;
  if (e instanceof Nip17SendError) return e.code === 'noRecipient' ? 'noSellerIdentity' : e.code;
  return 'generic';
}

// In-app Market checkout orchestration (#market). The PURE order-building lives
// in utils/marketOrder (unit-tested); this thin hook gift-wraps the kind-16
// order rumor to the merchant via services/nip17RumorSend — ALWAYS NIP-17,
// never Marmot (Gamma kinds 16/17 are wrap-only, see utils/wrapOnlyKinds).
//
// The send also wraps a copy to the buyer, so the placed order echoes back
// through the live DM subscription and threads into the vendor conversation
// as an order card (partner = vendor) — no optimistic local insert needed.

export type CheckoutStatus = 'idle' | 'placing' | 'sent' | 'error';

export interface PlaceOrderInput {
  /** Merchant's Nostr pubkey (hex) — gift-wrap recipient + order `p` tag. */
  vendorPubkey: string;
  /** `d` tag of the seller's listing (kind 30402) the `item` tag references. */
  dTag: string;
  /** Unit price in satoshis. */
  priceSats: number;
  /** Quantity ordered. */
  quantity: number;
  /** Optional free-text note to the merchant. */
  note?: string;
  /** Chosen shipping option (coordinate + all-in sats cost), when any (#948). */
  shipping?: OrderShippingInput;
  /** Shipping address for a physical order (Gamma `address` tag). */
  address?: string;
  /** Product title, remembered locally for My orders (never sent). */
  title?: string;
}

export interface PlaceOrderResult {
  orderId: string;
  totalSats: number;
}

export interface UseMarketCheckout {
  status: CheckoutStatus;
  error: string | null;
  /** True while the order is being signed + published. */
  isPlacing: boolean;
  /** Whether the user is signed in and can therefore place an order. */
  canOrder: boolean;
  placeOrder: (input: PlaceOrderInput) => Promise<PlaceOrderResult>;
  reset: () => void;
}

export function useMarketCheckout(): UseMarketCheckout {
  const { pubkey, isLoggedIn, signerType, relays } = useNostr();
  const t = useTranslation();
  const [status, setStatus] = useState<CheckoutStatus>('idle');
  const [error, setError] = useState<string | null>(null);

  const reset = useCallback(() => {
    setStatus('idle');
    setError(null);
  }, []);

  const placeOrder = useCallback(
    async (input: PlaceOrderInput): Promise<PlaceOrderResult> => {
      setError(null);
      try {
        if (!pubkey || !isLoggedIn) {
          throw new CheckoutError('notSignedIn', 'Sign in to place an order');
        }
        const vendorPubkey = input.vendorPubkey.trim().toLowerCase();
        if (!/^[0-9a-f]{64}$/.test(vendorPubkey)) {
          throw new CheckoutError(
            'noSellerIdentity',
            'This seller has no Nostr identity to order from',
          );
        }

        const titleGeneration = buyerOrderTitleGeneration(pubkey);
        setStatus('placing');
        // Build INSIDE the guarded section: a synchronous throw (RNG missing,
        // unexpected input) still flips status to 'error' with a message.
        const line: MarketOrderLine = {
          merchantPubkey: vendorPubkey,
          dTag: input.dTag,
          quantity: input.quantity,
          priceSats: input.priceSats,
        };
        const { rumor, orderId, totalSats } = buildMarketOrder({
          buyerPubkey: pubkey,
          vendorPubkey,
          lines: [line],
          note: input.note,
          shipping: input.shipping,
          address: input.address,
        });

        await sendNip17Rumor({
          senderPubkey: pubkey,
          signerType,
          relays,
          rumor,
          recipientPubkey: vendorPubkey,
        });

        if (input.title) {
          // Best effort — only labels My orders.
          void recordBuyerOrderTitles(
            pubkey,
            orderId,
            { [productCoordinate(vendorPubkey, input.dTag)]: input.title },
            titleGeneration,
          ).catch(() => undefined);
        }
        setStatus('sent');
        return { orderId, totalSats };
      } catch (e) {
        // Keep the raw Error for diagnostics/logs; show localized copy in the UI.
        if (__DEV__) console.warn('[market] place order failed:', e);
        setStatus('error');
        setError(t(`market.checkout.errors.${checkoutCode(e)}`));
        throw e instanceof Error ? e : new Error('Failed to place order');
      }
    },
    [pubkey, isLoggedIn, signerType, relays, t],
  );

  return {
    status,
    error,
    isPlacing: status === 'placing',
    canOrder: Boolean(isLoggedIn && canSendNip17(pubkey, signerType)),
    placeOrder,
    reset,
  };
}
