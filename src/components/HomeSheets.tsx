import React, { forwardRef, memo, useImperativeHandle } from 'react';
import ReceiveSheet from './ReceiveSheet';
import SendSheet from './SendSheet';
import TransferSheet from './TransferSheet';
import AddWalletWizard from './AddWalletWizard';
import WalletSettingsSheet from './WalletSettingsSheet';
import { useHomeSheetState, type HomeSheetActions } from '../hooks/useHomeSheetState';

const Receive = memo(ReceiveSheet);
const Send = memo(SendSheet);
const Transfer = memo(TransferSheet);
const Wizard = memo(AddWalletWizard);
const Settings = memo(WalletSettingsSheet);

// Own modal state BELOW Home. Opening a sheet must not rerender the wallet
// carousel / transaction list first. Don't mount five invisible trees on
// cold start; retain each after first use to preserve in-flight operations.
const HomeSheets = forwardRef<HomeSheetActions>(function HomeSheets(_props, ref) {
  const state = useHomeSheetState();
  useImperativeHandle(ref, () => state.actions, [state.actions]);
  return (
    <React.Profiler
      id="HomeSheets"
      onRender={(id, phase, duration) => {
        // Retained sheets re-render on every balance/price tick; gate at the
        // same 100 ms jank floor as HomeScreen's Profiler so only slow commits
        // (e.g. a heavy lazy first open) are logged.
        if (duration <= 100) return;
        if (__DEV__ || process.env.EXPO_PUBLIC_KEEP_PERF_LOGS === '1') {
          console.log(`[PerfBlock] render:${id} ${phase}=${duration.toFixed(1)}ms`);
        }
      }}
    >
      {state.receive !== null && <Receive visible={state.receive} onClose={state.closeReceive} />}
      {state.send !== null && (
        <Send
          visible={state.send.visible}
          onClose={state.closeSend}
          initialAddress={state.send.address}
          initialPicture={state.send.picture}
          recipientPubkey={state.send.pubkey}
          recipientName={state.send.name}
          initialMode={state.send.mode}
        />
      )}
      {state.transfer !== null && (
        <Transfer visible={state.transfer} onClose={state.closeTransfer} />
      )}
      {state.wizard !== null && <Wizard visible={state.wizard} onClose={state.closeWizard} />}
      {state.settings !== null && (
        <Settings walletId={state.settings.walletId} onClose={state.closeSettings} />
      )}
    </React.Profiler>
  );
});
export default memo(HomeSheets);
