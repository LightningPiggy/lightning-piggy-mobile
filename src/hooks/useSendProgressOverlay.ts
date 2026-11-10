import { useCallback, useMemo, useRef, useState } from 'react';
import type { PaymentProgressState } from '../components/PaymentProgressOverlay';
import { Toast } from '../components/BrandedToast';
import { useTranslation } from '../contexts/LocaleContext';
import { humanizePaymentError } from '../utils/paymentErrors';
import * as swapRecoveryService from '../services/swapRecoveryService';
import type { ReverseSwapSendStage } from '../utils/reverseSwapSend';
import { swapSendSteps } from '../utils/swapSendStage';

interface Options {
  onClose: () => void;
  setSending: (sending: boolean) => void;
}

/**
 * One tap of Send. Dismissal and dispatch state live HERE, not in shared refs,
 * so a send the user continued in the background can never repaint — or
 * un-dismiss — the overlay of the send that follows it.
 */
export interface SendInvocation {
  /** Per-send AbortController so the Cancel button on PaymentProgressOverlay
   *  can abort the NWC call's publish → reply-timeout → poll-for-preimage
   *  chain without waiting ~5 minutes for it to give up on its own (#175). */
  readonly controller: AbortController;
  /** The user chose "Continue in background" for this send. */
  dismissed: boolean;
  /** This send's pay request (plain Lightning, or a swap's hold invoice) has
   *  been dispatched to the wallet — a Cancel can no longer recall it (#1776). */
  dispatched: boolean;
}

type OutcomeState = Exclude<PaymentProgressState, 'hidden' | 'sending'>;

/**
 * SendSheet's PaymentProgressOverlay state machine: the overlay state/error,
 * the current send invocation, the Boltz reverse-swap stage + dispatch flag
 * (#1167), and the Cancel / reply-timeout / dismiss handlers — including
 * "Continue in background", which hands an in-flight swap to recovery.
 *
 * Every asynchronous overlay update is scoped to the invocation that made it:
 * it only lands while that send is still current and not backgrounded.
 */
export function useSendProgressOverlay({ onClose, setSending }: Options) {
  const t = useTranslation();
  const [progressState, setProgressState] = useState<PaymentProgressState>('hidden');
  const [progressError, setProgressError] = useState<string | undefined>(undefined);
  // Whether the in-flight send is a Boltz reverse swap (Lightning → on-chain).
  // Drives the swap-aware "Boltz swap in progress" overlay copy vs the generic
  // "Still in flight" used for a plain Lightning send that's slow to confirm.
  const [inFlightIsSwap, setInFlightIsSwap] = useState(false);
  const [swapStage, setSwapStage] = useState<ReverseSwapSendStage | null>(null);
  const [swapDispatched, setSwapDispatched] = useState(false);
  const currentSendRef = useRef<SendInvocation | null>(null);
  // The overlay's swap checklist (#1179): stage + dispatch → ✓ / spinner / ○ rows.
  const swapSteps = useMemo(
    () => (inFlightIsSwap ? swapSendSteps(swapStage, swapDispatched) : null),
    [inFlightIsSwap, swapStage, swapDispatched],
  );

  /** True while `send` may still paint the overlay. */
  const ownsOverlay = useCallback(
    (send: SendInvocation) => currentSendRef.current === send && !send.dismissed,
    [],
  );

  /** Reset the overlay for a new send and return its invocation. */
  const beginSend = useCallback((): SendInvocation => {
    // Abort any stale in-flight send (shouldn't happen in normal flow,
    // but guards against a cancel-then-resend race where the previous
    // controller is still referenced). Never one the user continued in the
    // background: its dispatched swap must keep watching for the lockup and
    // claim it — aborting would strand the funds until the next recovery pass.
    const previous = currentSendRef.current;
    if (previous && !previous.dismissed) previous.controller.abort();
    const send: SendInvocation = {
      controller: new AbortController(),
      dismissed: false,
      dispatched: false,
    };
    currentSendRef.current = send;
    setProgressError(undefined);
    setProgressState('sending');
    setInFlightIsSwap(false);
    setSwapStage(null);
    setSwapDispatched(false);
    return send;
  }, []);

  /** Mark `send` finished. Returns true if it was still the current send. */
  const endSend = useCallback((send: SendInvocation) => {
    if (currentSendRef.current !== send) return false;
    currentSendRef.current = null;
    return true;
  }, []);

  /** Paint a terminal/extended outcome for `send` — ignored once superseded. A
   *  send continued in the background has no overlay, so its failure is toasted. */
  const showOutcome = useCallback(
    (send: SendInvocation, state: OutcomeState, error?: string) => {
      if (send.dismissed && state === 'error') {
        Toast.show({
          type: 'error',
          text1: t('paymentProgressOverlay.failedTitle'),
          text2: humanizePaymentError(error).message,
        });
      }
      if (!ownsOverlay(send)) return;
      setProgressError(error);
      setProgressState(state);
    },
    [ownsOverlay, t],
  );

  /** Progress callbacks for one send's payment / reverse swap. */
  const callbacksFor = useCallback(
    (send: SendInvocation) => ({
      onReplyTimeout: () => {
        if (!ownsOverlay(send)) return;
        setProgressError(undefined);
        setProgressState((prev) => (prev === 'sending' ? 'in-flight-extended' : prev));
      },
      onStage: (stage: ReverseSwapSendStage) => {
        if (ownsOverlay(send)) setSwapStage(stage);
      },
      onPaymentDispatched: () => {
        send.dispatched = true;
        if (ownsOverlay(send)) setSwapDispatched(true);
      },
    }),
    [ownsOverlay],
  );

  const handleCancelPayment = useCallback(() => {
    // Cancel cannot recall a pay request the wallet already has (#1776). Don't
    // abort it: the (time-capped) completion race keeps running so its result
    // is still painted — or, once continued in the background, still refreshed
    // and recorded. Show the in-flight warning rather than re-arming Send.
    const send = currentSendRef.current;
    if (!send?.dispatched) send?.controller.abort();
    setProgressState(send?.dispatched ? 'in-flight-extended' : 'hidden');
    setProgressError(undefined);
    setSending(false);
  }, [setSending]);

  // Track progressState in a ref so handleOverlayDismiss doesn't recapture
  // it on every state flip. Without this, the `sending` → `success`
  // transition rebuilds the callback, but Android's touch system can still
  // fire the previously-cached handler reference for an in-flight tap —
  // that stale closure reads `wasSuccess === false`, hides the overlay,
  // and never calls onClose. See #210.
  const progressStateRef = useRef(progressState);
  // Sync during render (not in a useEffect) so the ref is always current before any tap can fire. A useEffect runs after commit/paint, leaving a window where the OK button is visible but the ref still holds the previous value — which is exactly the race the second-round Copilot review on #210 flagged.
  progressStateRef.current = progressState;

  const handleOverlayDismiss = useCallback(() => {
    // Dismissing the overlay after a successful payment also closes the
    // parent sheet. On error we only dismiss the overlay so the user can
    // retry from the filled-in form.
    const prevState = progressStateRef.current;
    const send = currentSendRef.current;
    // "Continue in background": either the in-flight-extended state, or a
    // swap still `sending` whose hold-invoice payment is already dispatched
    // (#1167). The live flow keeps running; its outcome is no longer painted.
    const continueInBackground =
      prevState === 'in-flight-extended' || (prevState === 'sending' && !!send?.dispatched);
    const shouldCloseParent = prevState === 'success' || continueInBackground;
    if (continueInBackground) {
      if (send) send.dismissed = true;
      // Kick a recovery pass so the claim is retried now rather than waiting
      // for the next app launch. Safe no-op (single-flight guarded) if the
      // lockup isn't claimable yet — pull-to-refresh / next foreground will retry.
      swapRecoveryService.recoverPendingSwaps().catch((e) => {
        console.warn('[Send] continue-in-background swap recovery failed:', e);
      });
    }
    setProgressState('hidden');
    setProgressError(undefined);
    // Defer the parent close so the overlay's hidden state renders first;
    // otherwise on a slow JS thread the parent sheet can tear down the
    // overlay component before the state update completes (#210).
    if (shouldCloseParent) setTimeout(() => onClose(), 0);
  }, [onClose]);

  return {
    progressState,
    progressError,
    inFlightIsSwap,
    setInFlightIsSwap,
    swapSteps,
    canContinueInBackground: inFlightIsSwap && swapDispatched,
    beginSend,
    endSend,
    ownsOverlay,
    showOutcome,
    callbacksFor,
    handleCancelPayment,
    handleOverlayDismiss,
  };
}
