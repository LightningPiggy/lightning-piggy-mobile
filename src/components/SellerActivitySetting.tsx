import React, { useCallback } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { MessageCircle } from 'lucide-react-native';
import { useNostr } from '../contexts/NostrContext';
import { useAccountState } from '../contexts/useAccountState';
import { useTranslation } from '../contexts/LocaleContext';
import { useOptimisticSwitch } from '../hooks/useOptimisticSwitch';
import {
  loadSellerActivityEnabled,
  setSellerActivityEnabled,
} from '../services/sellerActivityPreference';
import { Toast } from './BrandedToast';
import SettingsRow from './SettingsRow';

export default function SellerActivitySetting() {
  const { pubkey } = useNostr();
  const t = useTranslation();
  const [enabled, setEnabled] = useAccountState(pubkey, true);
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      if (pubkey)
        void loadSellerActivityEnabled(pubkey)
          .then((value) => {
            if (alive) setEnabled(value);
          })
          .catch(() => {});
      return () => {
        alive = false;
      };
    }, [pubkey, setEnabled]),
  );
  const toggle = useOptimisticSwitch(enabled, setEnabled, () =>
    Toast.show({ type: 'error', text1: t('notificationSettingsScreen.updateFailed') }),
  );
  if (!pubkey) return null;
  return (
    <SettingsRow
      kind="toggle"
      icon={MessageCircle}
      title={t('sellerActivity.settings')}
      testID="notifications-seller-activity"
      toggle={{
        value: enabled,
        pending: toggle.pending,
        onValueChange: (next) => toggle.run(next, () => setSellerActivityEnabled(pubkey, next)),
        testID: 'notifications-seller-activity-toggle',
      }}
    />
  );
}
