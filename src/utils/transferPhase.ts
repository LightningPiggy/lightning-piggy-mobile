/**
 * Phase model for the Transfer sheet's in-flight UI (issue #62).
 *
 * The sheet replaces its From/To/Amount form with a step-by-step status
 * card while a transfer is executing. This module owns the pure data
 * model — what steps each transfer type goes through, and how a
 * caller advances + completes + fails them — so the React component
 * just renders the result.
 *
 * Each transfer type has its own ordered step list. The component
 * holds a `TransferProgress` value, calls the helpers below to advance
 * it as the existing transfer flow makes progress, and the renderer
 * walks the steps deciding whether to show a checkmark / spinner /
 * empty circle for each row.
 *
 * Boltz cross-chain transfers ("ln-to-onchain", "onchain-to-ln") finish
 * the foreground portion at the "handoff" step — the background IIFE
 * continues to settle on-chain, but from the sheet's POV the work is
 * done and the user can close. The final step label is therefore
 * "Handoff to background" rather than the eventual on-chain settle.
 */

import type { ChecklistStep } from '../components/StepChecklist';

export type TransferType = 'ln-to-ln' | 'ln-to-onchain' | 'onchain-to-ln' | 'onchain-to-onchain';

/**
 * `unknown`: the payment / broadcast went out but its result never came back,
 * so the sats may or may not have moved (#1778). Distinct from `failed` so the
 * checklist doesn't claim a failure.
 */
export type TransferPhase = 'idle' | 'in-progress' | 'done' | 'failed' | 'unknown';

export interface TransferStep {
  id: string;
  label: string;
}

export interface TransferProgress {
  phase: TransferPhase;
  steps: TransferStep[];
  /**
   * Index of the step currently in flight. While `phase === 'in-progress'`
   * this is the row that should render a spinner; rows < activeIndex are
   * complete (checkmark), rows > activeIndex are pending (empty circle).
   * On `done`, all rows are complete (activeIndex === steps.length).
   * On `failed`, the row at activeIndex is the one that errored.
   */
  activeIndex: number;
  /** Populated when `phase` is `'failed'` or `'unknown'`. */
  errorMessage?: string;
}

/**
 * Step lists per transfer type. Wording matches the issue's mock
 * (issue #62) and the existing `progressMsg` strings in TransferSheet,
 * so the new step-list UI tells the same story the toasts/messages
 * have always told — just laid out as a checklist.
 */
export const STEPS_BY_TYPE: Record<TransferType, TransferStep[]> = {
  'ln-to-ln': [
    { id: 'invoice', label: 'Creating invoice' },
    { id: 'pay', label: 'Sending payment' },
    { id: 'refresh', label: 'Refreshing wallets' },
  ],
  'onchain-to-onchain': [
    { id: 'broadcast', label: 'Broadcasting on-chain transaction' },
    { id: 'refresh', label: 'Refreshing wallets' },
  ],
  'ln-to-onchain': [
    { id: 'swap', label: 'Creating Boltz swap' },
    { id: 'handoff', label: 'Handing off to background swap' },
  ],
  'onchain-to-ln': [
    { id: 'swap', label: 'Creating Boltz swap' },
    { id: 'broadcast', label: 'Broadcasting on-chain transaction' },
    { id: 'handoff', label: 'Handing off to background swap' },
  ],
};

/** Initial idle progress for a brand-new sheet (no transfer in flight). */
export const idleProgress = (): TransferProgress => ({
  phase: 'idle',
  steps: [],
  activeIndex: 0,
});

/**
 * Begin a transfer of the given type. The first step starts spinning
 * immediately; activeIndex is 0, phase flips to 'in-progress'.
 */
export const startTransfer = (transferType: TransferType): TransferProgress => ({
  phase: 'in-progress',
  steps: STEPS_BY_TYPE[transferType],
  activeIndex: 0,
});

/**
 * Mark the current step complete and start the next one. Caller invokes
 * this each time the existing transfer flow finishes a logical phase
 * (e.g. after `payInvoiceForWallet` resolves). Advancing off the final
 * step auto-completes: the call delegates to `completeTransfer()` and
 * lands in the terminal 'done' state. Only mutates while
 * `phase === 'in-progress'`; on any other phase it's a no-op.
 */
export const advanceTransfer = (progress: TransferProgress): TransferProgress => {
  if (progress.phase !== 'in-progress') return progress;
  const nextIndex = progress.activeIndex + 1;
  if (nextIndex >= progress.steps.length) {
    return completeTransfer(progress);
  }
  return { ...progress, activeIndex: nextIndex };
};

/**
 * Mark every step complete and flip phase to 'done'. Called by the
 * sheet at the end of the synchronous transfer paths (LN→LN,
 * on-chain→on-chain) and at the handoff point of the Boltz paths.
 * Clears any `errorMessage` left over from an earlier failed attempt so
 * the terminal success state never carries stale error data/UI.
 */
export const completeTransfer = (progress: TransferProgress): TransferProgress => ({
  ...progress,
  phase: 'done',
  activeIndex: progress.steps.length,
  errorMessage: undefined,
});

/**
 * Mark the current step failed. Stays at the same activeIndex so the
 * UI can render an X / error icon on the row that broke. The caller's
 * existing Alert.alert flow still surfaces the human-readable reason —
 * this is just to keep the step list honest.
 *
 * Only mutates while `phase === 'in-progress'`; on any terminal or idle
 * phase it's a no-op, so a late error can't flip an already-`done`
 * transfer back to `failed`. (While in-progress `activeIndex` is always
 * a valid step index — `completeTransfer` is what pushes it to
 * `steps.length` — so the failing row is always renderable.)
 */
export const failTransfer = (
  progress: TransferProgress,
  errorMessage: string,
): TransferProgress => {
  if (progress.phase !== 'in-progress') return progress;
  return {
    ...progress,
    phase: 'failed',
    errorMessage,
  };
};

/**
 * Like {@link failTransfer}, but the outcome is unknown rather than failed:
 * the row that was in flight renders as not-yet-done (○), never ✗ (#1778).
 */
export const unknownTransfer = (progress: TransferProgress, message: string): TransferProgress => {
  if (progress.phase !== 'in-progress') return progress;
  return { ...progress, phase: 'unknown', errorMessage: message };
};

/** The transfer stopped without succeeding — keep the progress view up. */
export const isTransferStopped = (progress: TransferProgress): boolean =>
  progress.phase === 'failed' || progress.phase === 'unknown';

/**
 * The checklist rows for `progress`: rows before `activeIndex` (or every row
 * once `done`) are complete, the failing row is failed, the in-flight row is
 * active — unless `suppressActive` (the background swap task errored, so
 * nothing is actually spinning) — and the rest are pending.
 */
export const transferChecklistSteps = (
  progress: TransferProgress,
  suppressActive: boolean,
): ChecklistStep[] =>
  progress.steps.map((s, idx) => ({
    id: s.id,
    label: s.label,
    status:
      progress.phase === 'done' || idx < progress.activeIndex
        ? 'complete'
        : progress.phase === 'failed' && idx === progress.activeIndex
          ? 'failed'
          : progress.phase === 'in-progress' && idx === progress.activeIndex && !suppressActive
            ? 'active'
            : 'pending',
  }));
