// Lightning invoices are case-insensitive, and in upper case a QR code can use its compact alphanumeric mode, so the same invoice needs fewer, larger modules.
const BOLT11 = /^(lightning:)?ln(bc|tbs|tb|bcrt|sb)[0-9]*[munp]?1[02-9ac-hj-np-z]+$/i;

/** The string to encode in a QR code: Lightning invoices in upper case, anything else unchanged. */
export function qrPayload(value: string): string {
  return BOLT11.test(value) ? value.toUpperCase() : value;
}
