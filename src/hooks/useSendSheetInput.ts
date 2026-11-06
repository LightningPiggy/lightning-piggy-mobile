import {
  useCallback,
  useLayoutEffect,
  useRef,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';
import * as Clipboard from 'expo-clipboard';
import { Alert } from '../components/BrandedAlert';
import { useTranslation } from '../contexts/LocaleContext';
import { parseBip21 } from '../utils/bip21';
import {
  type DecodedInvoice,
  decodeInvoice,
  isLightningAddress,
  isLnurlString,
  stripLightningPrefix,
} from '../utils/sendSheetInput';
import * as boltzService from '../services/boltzService';
import type { NfcTagContent } from '../services/nfcService';

/**
 * Input-intake concern for the Send sheet: classify a raw scanned / pasted /
 * typed string (lightning address, on-chain address, bolt11 invoice, or raw
 * LNURL — optionally wrapped in a `lightning:` prefix or `bitcoin:` BIP-21 URI)
 * and drive the sheet's decoded-send state accordingly. Extracted from SendSheet
 * (which is over the file-size cap) so the parse-and-classify logic lives in one
 * named place, mirroring useSendSheetLnurl. It drives state via the passed
 * setters rather than returning values, because the decoded target is shared
 * with the rest of the send flow. Behaviour is unchanged from the inline
 * handlers.
 *
 * Returns the intake handlers the sheet wires to the scan / NFC / paste panes,
 * plus `processInput` (also called after an initial-address prefill).
 */
export function useSendSheetInput(opts: {
  scanned: boolean;
  visible?: boolean;
  targetKey?: string;
  // Ref (not a plain value) holding the freshest paste-field string. The field is
  // uncontrolled, so its onChangeText writes the native text into this ref
  // synchronously; reading `.current` at submit time avoids the one-render lag a
  // `pasteText` value prop would carry (#873 tradeoff mitigation).
  pasteTextRef: RefObject<string>;
  activePubkey?: string;
  recipientName?: string;
  // Programmatic paste-field setter that bumps the uncontrolled input's remount
  // key (see applyPasteText in SendSheet) — used when pasting from the clipboard.
  applyPasteText: (v: string) => void;
  onInvalidInvoice: () => void;
  setIsOnchainAddress: (v: boolean) => void;
  setIsLnurl: (v: boolean) => void;
  setInvoiceData: (v: string | null) => void;
  setDecoded: Dispatch<SetStateAction<DecodedInvoice | null>>;
  setScanned: (v: boolean) => void;
  setSatsValue: (v: string) => void;
}): {
  processInput: (data: string) => void;
  resetInputForOpen: () => void;
  handleBarCodeScanned: (e: { data: string }) => void;
  handleNfcContent: (content: NfcTagContent) => void;
  handlePaste: () => Promise<void>;
  handlePasteSubmit: () => void;
} {
  const {
    scanned,
    pasteTextRef,
    applyPasteText,
    onInvalidInvoice,
    setIsOnchainAddress,
    setIsLnurl,
    setInvoiceData,
    setDecoded,
    setScanned,
    setSatsValue,
  } = opts;
  const t = useTranslation();
  const invalidInvoiceAlertVisible = useRef(false);
  const sessionRef = useRef(0);
  useLayoutEffect(() => {
    sessionRef.current += 1;
    invalidInvoiceAlertVisible.current = false;
    return () => {
      sessionRef.current += 1;
    };
  }, [opts.visible, opts.targetKey]);

  // A new Send session starts with intake open. The sheet stays mounted, so a
  // guard left set by an alert that never settled must not carry over.
  const resetInputForOpen = useCallback(() => {
    sessionRef.current += 1;
    invalidInvoiceAlertVisible.current = false;
  }, []);

  const rejectInvoiceInput = (input: string, titleKey: string, bodyKey: string) => {
    setInvoiceData(null);
    setDecoded(null);
    setScanned(false);
    setSatsValue('');
    setIsOnchainAddress(false);
    setIsLnurl(false);
    // Return to an editable field and stop the camera. Otherwise the same
    // rejected QR would reopen the alert as soon as the user dismisses it.
    applyPasteText(input);
    onInvalidInvoice();
    // A camera can deliver the same bad QR on every frame. Keep one alert
    // visible, then allow another attempt when the user dismisses it.
    invalidInvoiceAlertVisible.current = true;
    const session = sessionRef.current;
    const dismiss = () => {
      if (session !== sessionRef.current) return;
      invalidInvoiceAlertVisible.current = false;
    };
    Alert.alert(
      t(titleKey),
      t(bodyKey),
      [{ text: t('sendSheet.invalidInvoiceDismiss'), onPress: dismiss }],
      { onDismiss: dismiss },
    );
  };

  const acceptInput = (data: string) => {
    if (invalidInvoiceAlertVisible.current) return;
    let input = stripLightningPrefix(data);
    let bip21Amount: number | null = null;
    if (input.toLowerCase().startsWith('bitcoin:')) {
      const parsed = parseBip21(input);
      if (parsed) {
        input = parsed.address;
        bip21Amount = parsed.amountSats;
      }
    }

    if (isLightningAddress(input)) {
      setIsOnchainAddress(false);
      setIsLnurl(false);
      setInvoiceData(input);
      setDecoded({ amountSats: null, description: null, expiry: null });
      setScanned(true);
    } else if (boltzService.isBitcoinAddress(input)) {
      setIsOnchainAddress(true);
      setIsLnurl(false);
      setInvoiceData(input);
      setDecoded({ amountSats: null, description: null, expiry: null });
      setScanned(true);
      // Pre-fill amount from BIP-21 URI if present (fiat view is derived
      // inside AmountEntryScreen from satsValue when the user opens it).
      if (bip21Amount) {
        setSatsValue(bip21Amount.toString());
      }
    } else if (/^ln/i.test(input) && !isLnurlString(input)) {
      // All invoice entry points share this gate. A missing amount is valid
      // only after decoding succeeds (including the bech32 checksum/network).
      if (/^lno1/i.test(input)) {
        // BOLT12 offer — well-formed, just not payable here yet.
        rejectInvoiceInput(
          input,
          'sendSheet.offerUnsupportedTitle',
          'sendSheet.offerUnsupportedBody',
        );
        return;
      }
      const invoice = decodeInvoice(input);
      if (!invoice) {
        rejectInvoiceInput(input, 'sendSheet.invalidInvoiceTitle', 'sendSheet.invalidInvoiceBody');
        return;
      }
      setIsOnchainAddress(false);
      setIsLnurl(false);
      setInvoiceData(input);
      setDecoded(invoice);
      setScanned(true);
    } else if (isLnurlString(input)) {
      // Raw LNURL (bech32 lnurl1… or cleartext lnurlp://). We can't tell
      // pay vs withdraw from the string alone, so stash it and let the
      // resolve effect (useSendSheetLnurl) hit the endpoint and route on the
      // server's tag — payRequest wires up lnurlParams (same amount/send path
      // as a lightning address), withdrawRequest reports a claim code.
      setIsOnchainAddress(false);
      setIsLnurl(true);
      setInvoiceData(input);
      setDecoded({ amountSats: null, description: null, expiry: null });
      setScanned(true);
    }
  };

  // No link-consent sheet here: the user opened Send and chose to scan, paste
  // or tap this target, and the details step names the recipient before any
  // payment. Links arriving from outside the app (deep links, the global NFC
  // reader) and the Add Friend scanner still confirm first (#1500).
  const processInput = (data: string) => {
    // One invalid-invoice alert at a time: the camera can deliver the same
    // bad QR on every frame.
    if (opts.visible === false || invalidInvoiceAlertVisible.current) return;
    acceptInput(data);
  };

  const handleBarCodeScanned = ({ data }: { data: string }) => {
    if (scanned) return;
    processInput(data);
  };

  // NFC mode: route whatever the tag held into the same pipeline as a
  // scanned QR. Withdraw codes and Nostr profiles aren't payable from
  // here, so say why instead of silently doing nothing.
  const handleNfcContent = (content: NfcTagContent) => {
    if (scanned) return;
    switch (content.type) {
      case 'lnurl-withdraw':
        Alert.alert(t('sendSheet.claimCodeTitle'), t('sendSheet.claimCodeBody'));
        return;
      case 'npub':
        Alert.alert(t('sendSheet.notPaymentTagTitle'), t('sendSheet.notPaymentTagBody'));
        return;
      case 'unknown':
        Alert.alert(t('sendSheet.unsupportedTagTitle'), t('sendSheet.unsupportedTagBody'));
        return;
      default:
        processInput(content.data);
    }
  };

  const handlePaste = async () => {
    try {
      const session = sessionRef.current;
      const clip = await Clipboard.getStringAsync();
      if (session !== sessionRef.current || opts.visible === false) return;
      if (clip) {
        applyPasteText(clip);
        processInput(clip);
      }
    } catch {
      // Clipboard read can fail silently on cold start; nothing user-actionable.
    }
  };

  const handlePasteSubmit = () => {
    const submitted = (pasteTextRef.current ?? '').trim();
    if (submitted) {
      processInput(submitted);
    }
  };

  return {
    processInput,
    resetInputForOpen,
    handleBarCodeScanned,
    handleNfcContent,
    handlePaste,
    handlePasteSubmit,
  };
}
