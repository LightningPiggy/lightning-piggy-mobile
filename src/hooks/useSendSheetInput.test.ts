import { act, renderHook } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import { Alert } from '../components/BrandedAlert';
import { useSendSheetInput } from './useSendSheetInput';
import {
  AMOUNTLESS_INVOICE,
  DROPPED_CHARACTER_INVOICE,
  INVOICE_WITH_AMOUNT,
} from '../utils/bolt11TestVectors';

jest.mock('expo-clipboard', () => ({ getStringAsync: jest.fn() }));
jest.mock('../components/BrandedAlert', () => ({ Alert: { alert: jest.fn() } }));
jest.mock('../contexts/LocaleContext', () => ({ useTranslation: () => (key: string) => key }));
jest.mock('../services/boltzService', () => ({ isBitcoinAddress: () => false }));
jest.mock('../services/onchainService', () => ({}));

function setup() {
  const opts = {
    scanned: false,
    visible: true,
    targetKey: 'alice',
    pasteTextRef: { current: DROPPED_CHARACTER_INVOICE },
    applyPasteText: jest.fn(),
    onInvalidInvoice: jest.fn(),
    setIsOnchainAddress: jest.fn(),
    setIsLnurl: jest.fn(),
    setInvoiceData: jest.fn(),
    setDecoded: jest.fn(),
    setScanned: jest.fn(),
    setSatsValue: jest.fn(),
    setLoadingBoltzFees: jest.fn(),
    setBoltzFees: jest.fn(),
    setOnchainFeeEstimate: jest.fn(),
  };
  return {
    opts,
    ...renderHook((props: typeof opts) => useSendSheetInput(props), { initialProps: opts }),
  };
}

beforeEach(() => jest.clearAllMocks());

it.each(['paste submit', 'clipboard', 'QR scan', 'deep link', 'NFC'])(
  'rejects a corrupt invoice from %s before enabling send',
  async (entry) => {
    const { result, opts } = setup();
    jest.mocked(Clipboard.getStringAsync).mockResolvedValue(DROPPED_CHARACTER_INVOICE);
    await act(async () => {
      if (entry === 'paste submit') result.current.handlePasteSubmit();
      if (entry === 'clipboard') await result.current.handlePaste();
      if (entry === 'QR scan')
        result.current.handleBarCodeScanned({ data: DROPPED_CHARACTER_INVOICE });
      if (entry === 'deep link')
        result.current.processInput(`lightning:${DROPPED_CHARACTER_INVOICE}`);
      if (entry === 'NFC')
        result.current.handleNfcContent({
          type: 'lightning-invoice',
          data: DROPPED_CHARACTER_INVOICE,
        });
    });
    expect(Alert.alert).toHaveBeenCalledWith(
      'sendSheet.invalidInvoiceTitle',
      'sendSheet.invalidInvoiceBody',
      expect.any(Array),
      expect.any(Object),
    );
    expect(opts.setScanned).not.toHaveBeenCalledWith(true);
    expect(opts.setInvoiceData).toHaveBeenCalledWith(null);
    expect(opts.setDecoded).toHaveBeenCalledWith(null);
    expect(opts.setSatsValue).toHaveBeenCalledWith('');
    expect(opts.applyPasteText).toHaveBeenCalledWith(DROPPED_CHARACTER_INVOICE);
    expect(opts.onInvalidInvoice).toHaveBeenCalledTimes(1);
  },
);

it.each([
  [INVOICE_WITH_AMOUNT, 250000],
  [AMOUNTLESS_INVOICE, null],
])(
  'accepts a valid invoice without confusing missing amount with failure',
  (invoice, amountSats) => {
    const { result, opts } = setup();
    act(() => result.current.processInput(`LIGHTNING:${invoice}`));
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(opts.setInvoiceData).toHaveBeenCalledWith(invoice);
    expect(opts.setDecoded).toHaveBeenCalledWith(expect.objectContaining({ amountSats }));
    expect(opts.setScanned).toHaveBeenCalledWith(true);
  },
);

it('does not reopen the error on every camera frame, and allows retry after dismissal', () => {
  const { result, opts } = setup();
  act(() => {
    result.current.handleBarCodeScanned({ data: DROPPED_CHARACTER_INVOICE });
    result.current.handleBarCodeScanned({ data: DROPPED_CHARACTER_INVOICE });
  });
  expect(Alert.alert).toHaveBeenCalledTimes(1);
  expect(opts.setScanned).toHaveBeenCalledTimes(1);
  act(() => result.current.handleBarCodeScanned({ data: AMOUNTLESS_INVOICE }));
  expect(opts.setScanned).not.toHaveBeenCalledWith(true);
  act(() => jest.mocked(Alert.alert).mock.calls[0][2]?.[0].onPress?.());
  act(() => result.current.handleBarCodeScanned({ data: AMOUNTLESS_INVOICE }));
  expect(opts.setScanned).toHaveBeenLastCalledWith(true);
});

it('allows a fresh attempt after native dismissal of the error', () => {
  const { result, opts } = setup();
  act(() => result.current.processInput(DROPPED_CHARACTER_INVOICE));
  act(() => jest.mocked(Alert.alert).mock.calls[0][3]?.onDismiss?.());
  act(() => result.current.processInput(INVOICE_WITH_AMOUNT));
  expect(opts.setInvoiceData).toHaveBeenLastCalledWith(INVOICE_WITH_AMOUNT);
  expect(opts.setScanned).toHaveBeenLastCalledWith(true);
});

it('reopening the sheet clears a guard left by an alert that never settled', () => {
  const { result, opts } = setup();
  act(() => result.current.processInput(DROPPED_CHARACTER_INVOICE));
  // The alert was displaced without either callback firing; intake is blocked.
  act(() => result.current.processInput(INVOICE_WITH_AMOUNT));
  expect(opts.setInvoiceData).not.toHaveBeenCalledWith(INVOICE_WITH_AMOUNT);
  act(() => result.current.resetInputForOpen());
  act(() => result.current.processInput(INVOICE_WITH_AMOUNT));
  expect(opts.setInvoiceData).toHaveBeenLastCalledWith(INVOICE_WITH_AMOUNT);
  expect(opts.setScanned).toHaveBeenLastCalledWith(true);
});

it.each(['lno1qcp4256ypq', 'lightning:LNO1QCP4256YPQ'])(
  'explains that a BOLT12 offer is not supported yet (%s)',
  (offer) => {
    const { result, opts } = setup();
    act(() => result.current.processInput(offer));
    expect(Alert.alert).toHaveBeenCalledWith(
      'sendSheet.offerUnsupportedTitle',
      'sendSheet.offerUnsupportedBody',
      expect.any(Array),
      expect.any(Object),
    );
    expect(opts.setScanned).not.toHaveBeenCalledWith(true);
    expect(opts.onInvalidInvoice).toHaveBeenCalledTimes(1);
  },
);

it.each(['npub1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq', 'alice', 'bitcoin:', 'hello world'])(
  'tells the user when pasted text %p is not something they can pay (#1800)',
  (text) => {
    const { result, opts } = setup();
    opts.pasteTextRef.current = text;
    act(() => result.current.handlePasteSubmit());
    expect(Alert.alert).toHaveBeenCalledWith(
      'sendSheet.unrecognisedInputTitle',
      'sendSheet.unrecognisedInputBody',
      expect.any(Array),
      expect.any(Object),
    );
    expect(opts.setScanned).not.toHaveBeenCalledWith(true);
    expect(opts.setInvoiceData).toHaveBeenCalledWith(null);
    expect(opts.applyPasteText).toHaveBeenCalledWith(text);
    expect(opts.onInvalidInvoice).toHaveBeenCalledTimes(1);
  },
);

it('rejects unpayable clipboard text too', async () => {
  const { result } = setup();
  jest.mocked(Clipboard.getStringAsync).mockResolvedValue('just some text');
  await act(async () => {
    await result.current.handlePaste();
  });
  expect(Alert.alert).toHaveBeenCalledWith(
    'sendSheet.unrecognisedInputTitle',
    'sendSheet.unrecognisedInputBody',
    expect.any(Array),
    expect.any(Object),
  );
});

it.each(['', '   ', '\n\t '])(
  'ignores an empty or whitespace-only clipboard (%p)',
  async (clip) => {
    const { result, opts } = setup();
    jest.mocked(Clipboard.getStringAsync).mockResolvedValue(clip);
    await act(async () => {
      await result.current.handlePaste();
    });
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(opts.applyPasteText).not.toHaveBeenCalled();
  },
);

it.each(['QR', 'NFC', 'paste'])(
  'accepts an in-sheet %s target straight away, without a link-consent prompt',
  (entry) => {
    const { result, opts } = setup();
    act(() => {
      if (entry === 'QR') result.current.handleBarCodeScanned({ data: 'lnurlp://example.com/pay' });
      else if (entry === 'NFC')
        result.current.handleNfcContent({
          type: 'lightning-invoice',
          data: 'lnurlp://example.com/pay',
        });
      else {
        opts.pasteTextRef.current = 'lnurlp://example.com/pay';
        result.current.handlePasteSubmit();
      }
    });
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(opts.setInvoiceData).toHaveBeenCalledWith('lnurlp://example.com/pay');
    expect(opts.setIsLnurl).toHaveBeenCalledWith(true);
    expect(opts.setScanned).toHaveBeenCalledWith(true);
  },
);

it('ignores input once the sheet is hidden', () => {
  const { result, opts, rerender } = setup();
  rerender({ ...opts, visible: false });
  act(() => result.current.processInput('alice@example.com'));
  expect(opts.setInvoiceData).not.toHaveBeenCalled();
});

it('drops a clipboard read that resolves after the sheet closes', async () => {
  const { result, opts, rerender } = setup();
  let resolveClip: (v: string) => void = () => {};
  jest
    .mocked(Clipboard.getStringAsync)
    .mockReturnValue(new Promise<string>((r) => (resolveClip = r)));
  const pending = result.current.handlePaste();
  rerender({ ...opts, visible: false });
  await act(async () => {
    resolveClip('alice@example.com');
    await pending;
  });
  expect(opts.setInvoiceData).not.toHaveBeenCalled();
});

it('keeps the first of two codes the camera delivers before `scanned` commits', () => {
  const { result, opts, rerender } = setup();
  act(() => {
    // Both arrive before React re-renders with scanned=true.
    result.current.handleBarCodeScanned({ data: INVOICE_WITH_AMOUNT });
    result.current.handleBarCodeScanned({ data: AMOUNTLESS_INVOICE });
  });
  expect(opts.setScanned).toHaveBeenCalledWith(true);
  expect(opts.setInvoiceData).toHaveBeenCalledTimes(1);
  expect(opts.setInvoiceData).toHaveBeenCalledWith(INVOICE_WITH_AMOUNT);
  // "Scan another" clears `scanned`: the lock is released for a new code.
  rerender({ ...opts, scanned: true });
  rerender({ ...opts, scanned: false });
  act(() => result.current.handleBarCodeScanned({ data: INVOICE_WITH_AMOUNT }));
  expect(opts.setInvoiceData).toHaveBeenCalledTimes(2);
});
