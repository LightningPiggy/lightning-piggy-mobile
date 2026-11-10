import type { SendInputMode } from '../components/SendModeTabs';
import { useCallback, useMemo, useState } from 'react';

export interface SendTarget {
  address?: string;
  picture?: string;
  pubkey?: string;
  name?: string;
  /** Open on this tab instead of the default (widget Scan button, #1849). */
  mode?: SendInputMode;
}

/** null means never opened. Once mounted, sheets stay mounted when closed:
 * payment/recovery work and their dismissal effects must survive closing. */
export function useHomeSheetState() {
  const [receive, setReceive] = useState<boolean | null>(null);
  const [send, setSend] = useState<({ visible: boolean } & SendTarget) | null>(null);
  const [transfer, setTransfer] = useState<boolean | null>(null);
  const [wizard, setWizard] = useState<boolean | null>(null);
  const [settings, setSettings] = useState<{ walletId: string | null } | null>(null);

  const actions = useMemo(
    () => ({
      openReceive: () => setReceive(true),
      openSend: (target: SendTarget = {}) => setSend({ ...target, visible: true }),
      openTransfer: () => setTransfer(true),
      openWizard: () => setWizard(true),
      openSettings: (walletId: string) => setSettings({ walletId }),
    }),
    [],
  );
  const closeReceive = useCallback(() => setReceive(false), []);
  const closeSend = useCallback(() => setSend({ visible: false }), []);
  const closeTransfer = useCallback(() => setTransfer(false), []);
  const closeWizard = useCallback(() => setWizard(false), []);
  const closeSettings = useCallback(() => setSettings({ walletId: null }), []);

  return {
    receive,
    send,
    transfer,
    wizard,
    settings,
    actions,
    closeReceive,
    closeSend,
    closeTransfer,
    closeWizard,
    closeSettings,
  };
}
export type HomeSheetActions = ReturnType<typeof useHomeSheetState>['actions'];
