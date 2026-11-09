import BrandedSpinner from './BrandedSpinner';
import { useLocale } from '../contexts/LocaleContext';
import React, { useMemo } from 'react';
import { View, Text, TouchableOpacity } from 'react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { createTransferProgressStyles } from '../styles/TransferProgress.styles';
import {
  transferChecklistSteps,
  type TransferProgress as TransferProgressState,
} from '../utils/transferPhase';
import StepChecklist from './StepChecklist';

interface Props {
  /** Amount being transferred, in sats. */
  amountSats: number;
  /** Source wallet alias (top of the "route" line). */
  sourceAlias?: string;
  /** Destination wallet alias (bottom of the "route" line). */
  destAlias?: string;
  /** Pre-formatted fee/eta string ("~X sats · ~10-60 min"), or null. */
  feeEstimate: string | null;
  /** Step-model state driving the ✓ / spinner / ○ checklist. */
  progress: TransferProgressState;
  /** Legacy per-step sublabel shown under the checklist. */
  progressMsg: string | null;
  /**
   * Non-null once the background swap task errored — suppresses the
   * active-step spinner and surfaces the "Retry now" button.
   */
  backgroundError: string | null;
  /** True once a recovery retry has been acknowledged (hides Retry). */
  recoveryAcked: boolean;
  /** True while a recovery retry is in flight (disables + spins Retry). */
  retryingRecovery: boolean;
  /** Fired when the user taps "Retry now". */
  onRetry: () => void;
  /** Fired when the user taps "Close". */
  onClose: () => void;
}

/**
 * Renders the Transfer sheet's in-flight step-by-step progress view
 * (issue #62) — the checklist that replaces the From/To/Amount form
 * while a transfer is executing. Purely presentational: it walks the
 * `progress` step model deciding whether each row shows a checkmark,
 * spinner, X, or empty circle, and exposes Retry / Close actions whose
 * orchestration lives in the parent TransferSheet.
 */
const TransferProgress: React.FC<Props> = ({
  amountSats,
  sourceAlias,
  destAlias,
  feeEstimate,
  progress,
  progressMsg,
  backgroundError,
  recoveryAcked,
  retryingRecovery,
  onRetry,
  onClose,
}) => {
  const { formatLocale } = useLocale();
  const colors = useThemeColors();
  const styles = useMemo(() => createTransferProgressStyles(colors), [colors]);

  return (
    <View style={styles.progressView}>
      <Text style={styles.progressSummary}>{amountSats.toLocaleString(formatLocale)} sats</Text>
      <Text style={styles.progressRoute}>
        {sourceAlias} → {destAlias}
      </Text>
      {feeEstimate && (
        <Text style={styles.feeText}>
          Fee: {feeEstimate.split('·')[0].trim()}
          {feeEstimate.includes('·') ? ` · ${feeEstimate.split('·')[1].trim()}` : ''}
        </Text>
      )}
      {/* Step-by-step status (issue #62). Walks the steps for the
          current transferType and renders ✓ / spinner / ○ per row.
          The legacy `progressMsg` renders as a separate block below
          the entire step list (see below) so the rich Boltz "swap
          underway / safe to close" copy still surfaces. */}
      <StepChecklist
        steps={transferChecklistSteps(progress, backgroundError !== null)}
        testID="transfer-step-list"
        stepTestIDPrefix="transfer-step-"
      />
      {progressMsg && (
        <Text style={styles.progressText} testID="transfer-progress-msg">
          {progressMsg}
        </Text>
      )}
      {/* On failure, `finally` has cleared `progressMsg`, so surface the
          step model's `errorMessage` here (same spot) — otherwise the
          sheet would show only an X on a step row with no explanation
          once the alert is dismissed (issue #62). */}
      {progress.phase === 'failed' && progress.errorMessage && (
        <Text style={styles.errorText} testID="transfer-error-msg">
          {progress.errorMessage}
        </Text>
      )}
      {/* Unknown outcome (#1778): neutral text, not error styling — the sats
          may well have moved. */}
      {progress.phase === 'unknown' && progress.errorMessage && (
        <Text style={styles.progressText} testID="transfer-unknown-msg">
          {progress.errorMessage}
        </Text>
      )}
      {backgroundError !== null && !recoveryAcked && (
        <TouchableOpacity
          style={[styles.closeButton, retryingRecovery && styles.closeButtonDisabled]}
          onPress={onRetry}
          disabled={retryingRecovery}
          accessibilityLabel="Retry swap recovery"
          testID="transfer-retry-now"
        >
          {retryingRecovery ? (
            <BrandedSpinner onGradient />
          ) : (
            <Text style={styles.closeButtonText}>Retry now</Text>
          )}
        </TouchableOpacity>
      )}
      <TouchableOpacity
        style={styles.closeButton}
        onPress={onClose}
        accessibilityLabel="Close"
        testID="transfer-progress-close"
      >
        <Text style={styles.closeButtonText}>Close</Text>
      </TouchableOpacity>
    </View>
  );
};

export default TransferProgress;
