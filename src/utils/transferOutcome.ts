// Move (TransferSheet) guards and failure classification (#1778).
//
// Kept out of the sheet so the rules that decide "can this Move run?" and
// "what do we tell the user when it throws?" are testable on their own.

import { Alert } from '../components/BrandedAlert';
import * as boltzService from '../services/boltzService';
import { isUnansweredError } from '../services/nwcErrors';

type Translate = (key: string) => string;

/**
 * True when the source wallet's known balance can't cover the amount. An
 * unknown balance (`null` — not loaded yet) never blocks: the wallet itself is
 * the final judge, and blocking on a missing figure would strand the user.
 */
export function exceedsSourceBalance(
  balance: number | null | undefined,
  amountSats: number,
): boolean {
  return typeof balance === 'number' && amountSats > balance;
}

export type TransferFailureKind = 'quote-changed' | 'unknown-outcome' | 'dev-reload' | 'failed';

/**
 * How far the Move got before it threw: nothing sent yet, a Lightning payment
 * request sent, or an on-chain broadcast attempted.
 */
export type TransferDispatch = 'none' | 'lightning' | 'onchain';

/**
 * Classify an error thrown by the Move flow.
 *
 * An unknown outcome — the sats may well have moved — must never read as
 * "Move Failed": a user who trusts that retries and moves the amount twice
 * (the same rule SendSheet follows, #891 / #648).
 *  - After a Lightning payment was sent, a reply timeout or relay/connection
 *    drop is unknown; the wallet's own rejection is still a failure.
 *  - After an on-chain broadcast was attempted, ANY error is unknown: a lost
 *    Electrum reply surfaces as arbitrary BDK text, and the transaction may
 *    already be in the mempool.
 *  - Before dispatch nothing can have moved, so errors are plain failures.
 */
export function classifyTransferError(
  error: unknown,
  dispatch: TransferDispatch,
): TransferFailureKind {
  if (boltzService.isQuoteChangedError(error)) return 'quote-changed';
  if (dispatch === 'onchain') return 'unknown-outcome';
  if (dispatch === 'lightning' && isUnansweredError(error)) return 'unknown-outcome';
  const message = error instanceof Error ? error.message : '';
  // react-native's HMRClient throws this when Metro drops the dev-client
  // connection. Before dispatch nothing was signed or broadcast; after a
  // Lightning payment was sent the outcome is unknown, like any lost reply.
  if (/reload.*of undefined|DevSettings/i.test(message)) {
    return dispatch === 'none' ? 'dev-reload' : 'unknown-outcome';
  }
  return 'failed';
}

/** User-facing message for the progress view's failed row. */
export function transferFailureMessage(
  kind: TransferFailureKind,
  error: unknown,
  t: Translate,
): string {
  if (kind === 'unknown-outcome') return t('transferSheet.unknownOutcomeBody');
  return error instanceof Error ? error.message : 'Move failed';
}

/** Alert for every failure kind except `quote-changed` (the sheet handles that). */
export function alertTransferFailure(kind: TransferFailureKind, message: string, t: Translate) {
  if (kind === 'unknown-outcome') {
    Alert.alert(t('transferSheet.unknownOutcomeTitle'), message);
  } else if (kind === 'dev-reload') {
    Alert.alert(
      'Development Reload Needed',
      'Metro disconnected from the app mid-move. No funds were moved. Relaunch the app (or reconnect Metro) and try again.',
      [{ text: 'OK' }],
    );
  } else {
    Alert.alert('Move Failed', message);
  }
}
