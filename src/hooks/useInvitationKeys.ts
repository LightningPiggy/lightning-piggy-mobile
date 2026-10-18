import { useCallback, useMemo, useRef, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { useNostr } from '../contexts/NostrContext';
import { useTranslation } from '../contexts/LocaleContext';
import { Alert } from '../components/BrandedAlert';
import Toast from '../components/BrandedToast';
import { getMarmotSession } from '../services/marmotSession';
import {
  loadInvitationKeys,
  removeInvitationDevices,
  type InvitationInventory,
} from '../services/marmotInvitationKeys';
import { groupInvitationDevices, type InvitationDevice } from '../services/marmotInvitationDevices';
import {
  beginInvitationDeviceSummaryScan,
  completeInvitationDeviceSummaryScan,
} from '../utils/invitationDeviceSummary';

const EMPTY: InvitationInventory = { keys: [], partial: false };
/** Signer approvals one removal needs: the deletion, plus one replacement per device. */
export const signerApprovals = (devices: number) => devices + 1;

/** State + actions for "Devices that can get new chats" (#1236). */
export function useInvitationKeys() {
  const { pubkey, userRelays, signEvent, signerType } = useNostr();
  const t = useTranslation();
  const [inventory, setInventory] = useState<InvitationInventory>(EMPTY);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const owner = useRef(pubkey);
  owner.current = pubkey;
  const sequence = useRef(0);
  const action = useRef(false);
  const relays = useMemo(() => userRelays.map((r) => r.url), [userRelays]);

  const reload = useCallback(async () => {
    const seq = ++sequence.current;
    if (!pubkey) return;
    const scan = beginInvitationDeviceSummaryScan(pubkey);
    setLoading(true);
    setError(false);
    try {
      const result = await loadInvitationKeys(pubkey, relays);
      if (seq === sequence.current && owner.current === pubkey) {
        // Keeps Settings → Messages' "Devices for new chats" value in step.
        completeInvitationDeviceSummaryScan(pubkey, scan, result);
        setInventory(result);
      }
    } catch {
      if (seq === sequence.current) setError(true);
    } finally {
      if (seq === sequence.current) setLoading(false);
    }
  }, [pubkey, relays]);

  useFocusEffect(
    useCallback(() => {
      setInventory(EMPTY);
      void reload();
      return () => {
        ++sequence.current;
      };
    }, [reload]),
  );

  // One action at a time; the list is re-read afterwards either way.
  const run = useCallback(
    async (task: () => Promise<void>) => {
      if (!pubkey || action.current) return;
      action.current = true;
      setBusy(true);
      try {
        await task();
      } finally {
        action.current = false;
        setBusy(false);
        if (owner.current === pubkey) await reload();
      }
    },
    [pubkey, reload],
  );

  const refresh = useCallback(() => {
    void run(async () => {
      const session = getMarmotSession();
      const published =
        session?.pubkey === pubkey
          ? await session.refreshInvitationKey().catch(() => false)
          : false;
      if (owner.current !== pubkey) return;
      // Only a relay's acceptance counts: success is never assumed.
      if (published) Toast.show({ type: 'success', text1: t('invitationKeys.refreshed') });
      else
        Alert.alert(t('invitationKeys.refreshFailedTitle'), t('invitationKeys.refreshFailedBody'));
    });
  }, [run, pubkey, t]);

  const retryPublication = useCallback(() => {
    void run(async () => {
      const session = getMarmotSession();
      if (session?.pubkey === pubkey) await session.ensureKeyPackage();
    });
  }, [run, pubkey]);

  const remove = useCallback(
    (devices: InvitationDevice[], bulk: boolean) => {
      void run(async () => {
        if (!pubkey) return;
        try {
          const removed = await removeInvitationDevices({
            owner: pubkey,
            devices,
            relays,
            onlyIfStillOld: bulk,
            isCurrent: () => owner.current === pubkey,
            sign: async (template) => {
              const event = await signEvent(template);
              if (!event) throw new Error('Signature declined');
              return event;
            },
          });
          if (owner.current !== pubkey) return;
          if (removed === 0)
            Toast.show({ type: 'info', text1: t('invitationKeys.nothingRemoved') });
          else
            Toast.show({
              type: 'success',
              text1: t(bulk ? 'invitationKeys.removedOld' : 'invitationKeys.stopped', {
                count: removed,
              }),
            });
        } catch {
          if (owner.current === pubkey)
            Alert.alert(t('invitationKeys.failedTitle'), t('invitationKeys.failedBody'));
        }
      });
    },
    [run, pubkey, relays, signEvent, t],
  );

  // Amber / NIP-46 prompt once per signature; a local key signs silently.
  const approvalsNote = useCallback(
    (devices: number) =>
      signerType === 'nsec'
        ? ''
        : `\n\n${t('invitationKeys.signerApprovals', { count: signerApprovals(devices) })}`,
    [signerType, t],
  );

  const devices = useMemo(
    () => groupInvitationDevices(inventory.keys, inventory.localSlot),
    [inventory.keys, inventory.localSlot],
  );
  // An incomplete scan can't tell an old device from one we failed to see refreshed.
  const oldDevices = useMemo(
    () => (inventory.partial ? [] : devices.filter((d) => d.old)),
    [devices, inventory.partial],
  );

  const stopInvites = useCallback(
    (device: InvitationDevice, summary: string) => {
      const confirmedOwner = pubkey;
      Alert.alert(
        t('invitationKeys.stopTitle'),
        t('invitationKeys.stopBody', { device: summary }) + approvalsNote(1),
        [
          { text: t('invitationKeys.cancel'), style: 'cancel' },
          {
            text: t('invitationKeys.stopConfirm'),
            style: 'destructive',
            onPress: () => {
              if (owner.current === confirmedOwner) remove([device], false);
            },
          },
        ],
      );
    },
    [pubkey, t, approvalsNote, remove],
  );

  const removeOld = useCallback(() => {
    const confirmedOwner = pubkey;
    const selected = oldDevices;
    Alert.alert(
      t('invitationKeys.removeOldTitle', { count: selected.length }),
      t('invitationKeys.removeOldBody') + approvalsNote(selected.length),
      [
        { text: t('invitationKeys.cancel'), style: 'cancel' },
        {
          text: t('invitationKeys.removeOldConfirm'),
          style: 'destructive',
          onPress: () => {
            if (owner.current === confirmedOwner) remove(selected, true);
          },
        },
      ],
    );
  }, [pubkey, oldDevices, t, approvalsNote, remove]);

  return {
    devices,
    partial: inventory.partial,
    publicationFailed: inventory.publicationFailed,
    loading,
    busy,
    error,
    reload,
    refresh,
    retryPublication,
    stopInvites,
    removeOld,
    oldCount: oldDevices.length,
  };
}
