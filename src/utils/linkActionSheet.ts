import {
  Alert,
  type BrandedAlertButton,
  type BrandedAlertOptions,
} from '../components/BrandedAlert';

export interface LinkActionPrompt {
  title: string;
  message: string;
  buttons: BrandedAlertButton[];
  options: BrandedAlertOptions;
}
let listener: ((prompt: LinkActionPrompt) => void) | null = null;
let readyWaiters: (() => void)[] = [];

export function registerLinkActionSheet(next: (prompt: LinkActionPrompt) => void): () => void {
  listener = next;
  const waiters = readyWaiters;
  readyWaiters = [];
  waiters.forEach((run) => run());
  return () => {
    if (listener === next) listener = null;
  };
}

/**
 * Runs `run` once the consent sheet host is mounted (immediately if it already
 * is). A cold-start deep link resolves `Linking.getInitialURL()` while the
 * providers above `LinkActionSheetHost` are still loading; without this wait
 * the prompt falls back to an alert whose host isn't mounted either, and the
 * link is silently dropped.
 */
export function whenLinkActionSheetReady(run: () => void): void {
  if (listener) run();
  else readyWaiters.push(run);
}

/** Test-only: drop the host and any queued readiness callbacks, so a waiter
 *  queued (but never released) by one test can't run in the next. */
export function __resetLinkActionSheetForTests(): void {
  listener = null;
  readyWaiters = [];
}

export function showLinkActionSheet(
  title: string,
  message: string,
  buttons: BrandedAlertButton[],
  options: BrandedAlertOptions,
): void {
  if (listener) listener({ title, message, buttons, options });
  else Alert.alert(title, message, buttons, options);
}
