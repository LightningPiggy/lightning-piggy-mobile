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

/** An open sheet's state. `key` changes on every open, so opening a sheet
 * that is already up (a home-screen widget tap, #1849) re-runs its open
 * setup and it re-captures the now-active wallet instead of keeping the old. */
export interface SheetOpen {
  visible: boolean;
  key: number;
}

/** null means never opened. Once mounted, sheets stay mounted when closed:
 * payment/recovery work and their dismissal effects must survive closing. */
export function useHomeSheetState() {
  const [receive, setReceive] = useState<SheetOpen | null>(null);
  const [send, setSend] = useState<(SheetOpen & SendTarget) | null>(null);
  const [transfer, setTransfer] = useState<boolean | null>(null);
  const [wizard, setWizard] = useState<boolean | null>(null);
  const [settings, setSettings] = useState<{ walletId: string | null } | null>(null);

  const actions = useMemo(
    () => ({
      openReceive: () => setReceive((r) => ({ visible: true, key: (r?.key ?? 0) + 1 })),
      openSend: (target: SendTarget = {}) =>
        setSend((s) => ({ ...target, visible: true, key: (s?.key ?? 0) + 1 })),
      openTransfer: () => setTransfer(true),
      openWizard: () => setWizard(true),
      openSettings: (walletId: string) => setSettings({ walletId }),
    }),
    [],
  );
  const closeReceive = useCallback(
    () => setReceive((r) => ({ visible: false, key: r?.key ?? 0 })),
    [],
  );
  const closeSend = useCallback(() => setSend((s) => ({ visible: false, key: s?.key ?? 0 })), []);
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
