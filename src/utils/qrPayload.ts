// Lightning invoices are case-insensitive, and in upper case a QR code can use its compact alphanumeric mode, so the same invoice needs fewer, larger modules.
const BOLT11 = /^(lightning:)?ln(bc|tb|bcrt|sb)[0-9a-z]+$/i;

/** The string to encode in a QR code: Lightning invoices in upper case, anything else unchanged. */
export function qrPayload(value: string): string {
  return BOLT11.test(value) ? value.toUpperCase() : value;
}
