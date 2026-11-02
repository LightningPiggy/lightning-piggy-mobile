// "Repair secure chat": start a fresh Marmot 1:1 with the contact's current
// devices. For a chat that split into two groups (or that the peer can no
// longer read): the new group takes over on both sides — it's the newest
// for them on older versions, and supersedes the old groups here. Old
// messages still arrive and remain visible. Nothing is deleted.
import { useCallback, useState } from 'react';

import { Alert } from '../components/BrandedAlert';
import Toast from '../components/BrandedToast';
import { useTranslation } from '../contexts/LocaleContext';
import { marmotSendError, requireMarmotSession, restartDmWithin } from '../services/marmotSend';

export function useRepairMarmotDm(viewer: string | null, peer: string | undefined, name: string) {
  const t = useTranslation();
  const [repairing, setRepairing] = useState(false);
  const run = useCallback(async () => {
    if (!viewer || !peer) return;
    setRepairing(true);
    try {
      await restartDmWithin(requireMarmotSession(viewer), peer);
      Toast.show({ type: 'success', text1: t('chatMenu.repairDone') });
    } catch (e) {
      Toast.show({ type: 'error', text1: t('chatMenu.repairFailed'), text2: marmotSendError(e) });
    } finally {
      setRepairing(false);
    }
  }, [viewer, peer, t]);
  const repair = useCallback(() => {
    Alert.alert(t('chatMenu.repairTitle'), t('chatMenu.repairMessage', { name }), [
      { text: t('addWalletWizard.cancel'), style: 'cancel' },
      { text: t('chatMenu.repair'), onPress: () => void run() },
    ]);
  }, [t, name, run]);
  return { repair, repairing };
}
