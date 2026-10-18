import {
  loadBuyerOrderTitles,
  retireBuyerOrderTitles,
  reviveBuyerOrderTitles,
  waitForBuyerOrderTitleWrites,
} from '../services/buyerOrderTitles';
import { act, renderHook } from '@testing-library/react-native';
import { sendNip17Rumor } from '../services/nip17RumorSend';
import { useMarketCheckout } from './useMarketCheckout';
import { useNostr } from '../contexts/NostrContext';
import * as nostrService from '../services/nostrService';
import * as nostrConnectService from '../services/nostrConnectService';
import { getMemoisedSecretKey } from '../contexts/nostrSecretKeyCache';

jest.mock('../contexts/NostrContext', () => ({ useNostr: jest.fn() }));
jest.mock('../contexts/nostrSecretKeyCache', () => ({ getMemoisedSecretKey: jest.fn() }));
jest.mock('../contexts/LocaleContext', () => ({ useTranslation: () => (key: string) => key }));
jest.mock('../services/amberService', () => ({}));
jest.mock('../services/nostrConnectService', () => ({
  requestNip44Encrypt: jest.fn(),
  requestEventSignature: jest.fn(),
}));
jest.mock('../services/nostrService', () => ({
  DEFAULT_RELAYS: ['wss://relay.example'],
  sendNip17ToManyWithSigner: jest.fn(),
  sendNip17ToManyWithNsec: jest.fn(),
}));

const buyer = 'a'.repeat(64);
const vendor = 'b'.repeat(64);
const input = { vendorPubkey: vendor, dTag: 'item', priceSats: 100, quantity: 1 };

beforeEach(() => {
  jest.clearAllMocks();
  (useNostr as jest.Mock).mockReturnValue({
    pubkey: buyer,
    isLoggedIn: true,
    signerType: 'nip46',
    relays: [],
  });
  (nostrConnectService.requestNip44Encrypt as jest.Mock).mockResolvedValue('ciphertext');
  (nostrConnectService.requestEventSignature as jest.Mock).mockResolvedValue({
    event: JSON.stringify({ kind: 13, sig: 'signature' }),
  });
  (nostrService.sendNip17ToManyWithSigner as jest.Mock).mockImplementation(async (options) => {
    await options.signerNip44Encrypt('plaintext', vendor);
    await options.signerSignSeal({ kind: 13, pubkey: buyer });
    return {
      wrapOutcomes: [{ recipientPubkey: vendor, published: true }],
      wrapsPublished: 2,
      delivery: { delivered: true },
      errors: [],
    };
  });
});

test('NIP-46 checkout encrypts and signs with the logged-in buyer and sends the order', async () => {
  const { result } = renderHook(() => useMarketCheckout());
  expect(result.current.canOrder).toBe(true);
  await act(async () => {
    await result.current.placeOrder(input);
  });
  expect(nostrConnectService.requestNip44Encrypt).toHaveBeenCalledWith('plaintext', vendor, buyer);
  expect(nostrConnectService.requestEventSignature).toHaveBeenCalledWith(
    JSON.stringify({ kind: 13, pubkey: buyer }),
    '',
    buyer,
  );
  expect(nostrService.sendNip17ToManyWithSigner).toHaveBeenCalledWith(
    expect.objectContaining({
      senderPubkey: buyer,
      recipientPubkeys: [vendor],
    }),
  );
  expect(result.current.status).toBe('sent');
});

test('an empty NIP-46 signature fails checkout instead of reporting delivery', async () => {
  (nostrConnectService.requestEventSignature as jest.Mock).mockResolvedValue({ event: '' });
  const { result } = renderHook(() => useMarketCheckout());
  await act(async () => {
    await expect(result.current.placeOrder(input)).rejects.toThrow('empty signed seal');
  });
  expect(result.current.status).toBe('error');
});

test('unsupported signers cannot enter checkout', () => {
  (useNostr as jest.Mock).mockReturnValue({
    pubkey: buyer,
    isLoggedIn: true,
    signerType: null,
    relays: [],
  });
  expect(renderHook(() => useMarketCheckout()).result.current.canOrder).toBe(false);
});

test('a self-wrap success with a failed merchant wrap does not report the order sent', async () => {
  (nostrService.sendNip17ToManyWithSigner as jest.Mock).mockResolvedValue({
    wrapsPublished: 1,
    delivery: { delivered: true },
    errors: ['vendor publish failed'],
    wrapOutcomes: [
      { recipientPubkey: buyer, published: true },
      { recipientPubkey: vendor, published: false, error: 'vendor publish failed' },
    ],
  });
  const { result } = renderHook(() => useMarketCheckout());
  await act(async () => {
    await expect(result.current.placeOrder(input)).rejects.toThrow('vendor publish failed');
  });
  expect(result.current.status).toBe('error');
});

describe('nsec checkout', () => {
  const secretKey = new Uint8Array(32).fill(7);
  beforeEach(() => {
    (useNostr as jest.Mock).mockReturnValue({
      pubkey: buyer,
      isLoggedIn: true,
      signerType: 'nsec',
      relays: [],
    });
    (nostrService.sendNip17ToManyWithNsec as jest.Mock).mockResolvedValue({
      wrapOutcomes: [{ recipientPubkey: vendor, published: true }],
      wrapsPublished: 2,
      errors: [],
    });
  });

  test('seals with the secret key that belongs to the active pubkey', async () => {
    (getMemoisedSecretKey as jest.Mock).mockResolvedValue(secretKey);
    const { result } = renderHook(() => useMarketCheckout());
    await act(async () => {
      await result.current.placeOrder(input);
    });
    expect(getMemoisedSecretKey).toHaveBeenCalledWith(buyer);
    expect(nostrService.sendNip17ToManyWithNsec).toHaveBeenCalledWith(
      expect.objectContaining({ senderSecretKey: secretKey, recipientPubkeys: [vendor] }),
    );
    expect(result.current.status).toBe('sent');
  });

  test('fails closed when the stored key does not belong to the active pubkey', async () => {
    (getMemoisedSecretKey as jest.Mock).mockResolvedValue(null);
    const { result } = renderHook(() => useMarketCheckout());
    await act(async () => {
      await expect(result.current.placeOrder(input)).rejects.toThrow('does not match');
    });
    expect(nostrService.sendNip17ToManyWithNsec).not.toHaveBeenCalled();
    expect(result.current.status).toBe('error');
    expect(result.current.error).toBe('market.checkout.errors.signingKeyMissing');
  });
});

test.each(['nsec', 'amber', 'nip46'])(
  'recipient delivery succeeds despite self-copy failure with %s',
  async (signerType) => {
    (useNostr as jest.Mock).mockReturnValue({
      pubkey: buyer,
      isLoggedIn: true,
      signerType,
      relays: [],
    });
    (getMemoisedSecretKey as jest.Mock).mockResolvedValue(new Uint8Array(32).fill(7));
    const outcome = {
      wrapsPublished: 1,
      delivery: { delivered: true },
      errors: ['self-copy publish failed'],
      wrapOutcomes: [
        { recipientPubkey: buyer, published: false, error: 'self-copy publish failed' },
        { recipientPubkey: vendor, published: true },
      ],
    };
    const send =
      signerType === 'nsec'
        ? nostrService.sendNip17ToManyWithNsec
        : nostrService.sendNip17ToManyWithSigner;
    (send as jest.Mock).mockResolvedValue(outcome);
    const { result } = renderHook(() => useMarketCheckout());
    await act(async () => {
      await result.current.placeOrder(input);
    });
    expect(result.current.status).toBe('sent');
    // Diagnostics survive without logging or persisting the rumor/address.
    await expect(
      sendNip17Rumor({
        senderPubkey: buyer,
        signerType,
        recipientPubkey: vendor,
        relays: [],
        rumor: { pubkey: buyer, kind: 16, created_at: 1, tags: [], content: '' },
      }),
    ).resolves.toBe(outcome);
  },
);

test('a checkout finishing after sign-out and re-login cannot restore purchase titles', async () => {
  reviveBuyerOrderTitles(buyer);
  let release!: () => void;
  const sending = new Promise<void>((resolve) => {
    release = resolve;
  });
  (nostrService.sendNip17ToManyWithSigner as jest.Mock).mockImplementationOnce(async () => {
    await sending;
    return { wrapOutcomes: [{ recipientPubkey: vendor, published: true }], errors: [] };
  });
  const { result } = renderHook(() => useMarketCheckout());
  await act(async () => {
    const checkout = result.current.placeOrder({ ...input, title: 'Private purchase' });
    retireBuyerOrderTitles(buyer);
    await waitForBuyerOrderTitleWrites();
    reviveBuyerOrderTitles(buyer);
    release();
    await checkout;
    await waitForBuyerOrderTitleWrites();
  });
  expect(await loadBuyerOrderTitles(buyer)).toEqual({});
});
