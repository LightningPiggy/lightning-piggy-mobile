import { act, renderHook } from '@testing-library/react-native';
import { useSendProgressOverlay, type SendInvocation } from './useSendProgressOverlay';
import * as swapRecoveryService from '../services/swapRecoveryService';

// Hoisted above the imports by babel-jest.
jest.mock('../services/swapRecoveryService', () => ({
  recoverPendingSwaps: jest.fn(async () => undefined),
}));

const setup = () => {
  const onClose = jest.fn();
  const setSending = jest.fn();
  const hook = renderHook(() => useSendProgressOverlay({ onClose, setSending }));
  return { ...hook, onClose, setSending };
};

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
});
afterEach(() => {
  jest.useRealTimers();
});

describe('useSendProgressOverlay — per-send scoping', () => {
  it('a new send still aborts a stale send that was NOT backgrounded', () => {
    const { result } = setup();
    let a!: SendInvocation;
    act(() => {
      a = result.current.beginSend();
    });
    act(() => {
      result.current.beginSend();
    });
    expect(a.controller.signal.aborted).toBe(true);
  });

  it("a backgrounded swap A can't repaint send B's overlay", () => {
    const { result } = setup();

    // Swap A: dispatched, then the user continues in the background.
    let a!: SendInvocation;
    act(() => {
      a = result.current.beginSend();
      result.current.setInFlightIsSwap(true);
    });
    const aCallbacks = result.current.callbacksFor(a);
    act(() => {
      aCallbacks.onStage('payAndLockup');
      aCallbacks.onPaymentDispatched();
    });
    expect(result.current.canContinueInBackground).toBe(true);
    act(() => result.current.handleOverlayDismiss());
    expect(a.dismissed).toBe(true);
    expect(swapRecoveryService.recoverPendingSwaps).toHaveBeenCalledTimes(1);
    expect(result.current.progressState).toBe('hidden');

    // Send B starts on the reopened sheet. A keeps running (it still has to
    // claim its lockup) and keeps its dismissal.
    let b!: SendInvocation;
    act(() => {
      b = result.current.beginSend();
    });
    expect(a.controller.signal.aborted).toBe(false);
    expect(a.dismissed).toBe(true);
    expect(b.dismissed).toBe(false);
    expect(result.current.progressState).toBe('sending');

    // A's late SwapSettlingError catch, stage, reply-timeout and dispatch all no-op.
    act(() => {
      result.current.showOutcome(a, 'in-flight-extended');
      aCallbacks.onStage('claimSwap');
      aCallbacks.onReplyTimeout();
      aCallbacks.onPaymentDispatched();
    });
    expect(result.current.progressState).toBe('sending');
    expect(result.current.swapSteps).toBeNull();
    expect(result.current.inFlightIsSwap).toBe(false);
    expect(result.current.canContinueInBackground).toBe(false);
    expect(result.current.ownsOverlay(a)).toBe(false);
    expect(result.current.ownsOverlay(b)).toBe(true);

    // A finishing doesn't end B; B still owns its outcome.
    expect(result.current.endSend(a)).toBe(false);
    act(() => result.current.showOutcome(b, 'error', 'no route'));
    expect(result.current.progressState).toBe('error');
    expect(result.current.progressError).toBe('no route');
    expect(result.current.endSend(b)).toBe(true);
  });

  it('a superseded (not backgrounded) send cannot repaint either', () => {
    const { result } = setup();
    let a!: SendInvocation;
    act(() => {
      a = result.current.beginSend();
    });
    act(() => {
      result.current.beginSend();
    });
    act(() => {
      result.current.callbacksFor(a).onReplyTimeout();
      result.current.showOutcome(a, 'success');
    });
    expect(result.current.progressState).toBe('sending');
  });

  it("the current send's reply timeout and outcome still paint", () => {
    const { result } = setup();
    let send!: SendInvocation;
    act(() => {
      send = result.current.beginSend();
    });
    act(() => result.current.callbacksFor(send).onReplyTimeout());
    expect(result.current.progressState).toBe('in-flight-extended');
    act(() => result.current.showOutcome(send, 'success'));
    expect(result.current.progressState).toBe('success');
  });

  it('Cancel after dispatch keeps the in-flight warning; before dispatch it hides', () => {
    const { result, setSending } = setup();
    let send!: SendInvocation;
    act(() => {
      send = result.current.beginSend();
    });
    act(() => result.current.handleCancelPayment());
    expect(send.controller.signal.aborted).toBe(true);
    expect(result.current.progressState).toBe('hidden');
    expect(setSending).toHaveBeenCalledWith(false);

    act(() => {
      send = result.current.beginSend();
    });
    act(() => result.current.callbacksFor(send).onPaymentDispatched());
    act(() => result.current.handleCancelPayment());
    expect(result.current.progressState).toBe('in-flight-extended');
  });

  it('a plain Lightning send cancelled after dispatch warns, then closes the sheet (#1776)', () => {
    const { result, onClose, setSending } = setup();
    let send!: SendInvocation;
    act(() => {
      send = result.current.beginSend();
    });
    act(() => result.current.callbacksFor(send).onPaymentDispatched());
    // Not a swap: no checklist, no swap-only "Continue in background" while sending.
    expect(result.current.swapSteps).toBeNull();
    expect(result.current.canContinueInBackground).toBe(false);
    act(() => result.current.handleCancelPayment());
    expect(send.controller.signal.aborted).toBe(true);
    expect(result.current.progressState).toBe('in-flight-extended');
    expect(setSending).toHaveBeenCalledWith(false);
    // Acknowledging the warning closes the sheet rather than leaving Send armed.
    act(() => result.current.handleOverlayDismiss());
    act(() => jest.runAllTimers());
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Continue in background from in-flight-extended closes the sheet and kicks recovery', () => {
    const { result, onClose } = setup();
    let send!: SendInvocation;
    act(() => {
      send = result.current.beginSend();
    });
    act(() => result.current.showOutcome(send, 'in-flight-extended'));
    act(() => result.current.handleOverlayDismiss());
    act(() => jest.runAllTimers());
    expect(send.dismissed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(swapRecoveryService.recoverPendingSwaps).toHaveBeenCalledTimes(1);
  });
});

describe('useSendProgressOverlay — swap checklist (#1179)', () => {
  const active = (steps: { id: string; status: string }[] | null) =>
    steps?.find((s) => s.status === 'active')?.id;

  it('the reverse-swap callbacks walk the overlay checklist row by row', () => {
    const { result } = setup();
    let send!: SendInvocation;
    act(() => {
      send = result.current.beginSend();
    });
    // A plain Lightning send has no checklist.
    expect(result.current.swapSteps).toBeNull();
    act(() => result.current.setInFlightIsSwap(true));
    const cb = result.current.callbacksFor(send);

    act(() => cb.onStage('createSwap'));
    expect(active(result.current.swapSteps)).toBe('create');
    act(() => cb.onStage('payAndLockup'));
    expect(active(result.current.swapSteps)).toBe('pay');
    act(() => cb.onPaymentDispatched());
    expect(active(result.current.swapSteps)).toBe('lockup');
    act(() => cb.onStage('claimSwap'));
    expect(active(result.current.swapSteps)).toBe('claim');
    expect(result.current.swapSteps?.map((s) => s.status)).toEqual([
      'complete',
      'complete',
      'complete',
      'active',
    ]);
  });
});
