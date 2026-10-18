import SellerActivitySetting from '../../components/SellerActivitySetting';
import React, { useCallback, useEffect, useState } from 'react';
import { Platform } from 'react-native';
import { BellRing, Radio, MapPin, Server, BellOff, KeyRound } from 'lucide-react-native';
import Toast from '../../components/BrandedToast';
import { useOptimisticSwitch } from '../../hooks/useOptimisticSwitch';
import AccountScreenLayout from './AccountScreenLayout';
import { useTranslation } from '../../contexts/LocaleContext';
import { useNavigation, useFocusEffect } from '@react-navigation/native';
import type { AccountDrawerNavigation } from '../../navigation/types';
import { useMutedSenders } from '../../hooks/useMutedSenders';
import { useNostr } from '../../contexts/NostrContext';
import { loadMarmotPushSettings } from '../../services/marmotPushRegistration';
import { loadShopAlertStatus } from '../../services/shopAlertStatus';
import MarmotPushSection from '../../components/MarmotPushSection';
import SettingsSection from '../../components/SettingsSection';
import NotificationPermissionRow from '../../components/NotificationPermissionRow';
import SettingsRow from '../../components/SettingsRow';
import {
  getLockScreenContentEnabled,
  setLockScreenContentEnabled,
  requestNotificationPermission,
} from '../../services/notificationService';
import {
  loadBackgroundDmEnabled,
  setBackgroundDmEnabled,
} from '../../services/backgroundDmPreference';
import { startBackgroundDmWatch, stopBackgroundDmWatch } from '../../services/backgroundDmService';
import {
  areKeyBackupRemindersEnabled,
  setKeyBackupRemindersEnabled,
} from '../../services/keyBackupReminder';

const NotificationSettingsScreen: React.FC = () => {
  const t = useTranslation();
  const navigation = useNavigation<AccountDrawerNavigation>();
  const { mutedSenders } = useMutedSenders();
  const { pubkey } = useNostr();
  const [shopOn, setShopOn] = useState(false);
  const [customServer, setCustomServer] = useState(false);
  useFocusEffect(
    useCallback(() => {
      let alive = true;
      void loadShopAlertStatus().then((active) => {
        if (alive) setShopOn(active);
      });
      if (pubkey)
        void loadMarmotPushSettings(pubkey)
          .then((s) => {
            if (alive) setCustomServer(!!s.customServer);
          })
          .catch(() => undefined);
      return () => {
        alive = false;
      };
    }, [pubkey]),
  );
  const [lockScreenContentOn, setLockScreenContentOn] = useState<boolean>(false);
  // Background DM watch is Android-only (iOS can't hold a background socket).
  const [backgroundDmOn, setBackgroundDmOn] = useState<boolean>(false);
  const [permissionGranted, setPermissionGranted] = useState(false);
  const isAndroid = Platform.OS === 'android';

  const [backupRemindersOn, setBackupRemindersOn] = useState<boolean>(true);

  useEffect(() => {
    getLockScreenContentEnabled().then(setLockScreenContentOn);
    areKeyBackupRemindersEnabled().then(setBackupRemindersOn);
    if (isAndroid) loadBackgroundDmEnabled().then(setBackgroundDmOn);
  }, [isAndroid]);

  const reportFailure = () =>
    Toast.show({ type: 'error', text1: t('notificationSettingsScreen.updateFailed') });
  const lockScreen = useOptimisticSwitch(
    lockScreenContentOn,
    setLockScreenContentOn,
    reportFailure,
  );
  const background = useOptimisticSwitch(backgroundDmOn, setBackgroundDmOn, reportFailure);
  const backupReminders = useOptimisticSwitch(
    backupRemindersOn,
    setBackupRemindersOn,
    reportFailure,
  );

  const handleToggleLockScreenContent = (next: boolean) =>
    lockScreen.run(next, () => setLockScreenContentEnabled(next, true));

  // Never asks for notification permission: without it, the Wallets tab
  // shows a banner instead (#1546).
  const handleToggleBackupReminders = (next: boolean) =>
    backupReminders.run(next, () => setKeyBackupRemindersEnabled(next));

  const handleToggleBackgroundDm = (next: boolean) =>
    background.run(next, async () => {
      if (next && !(await requestNotificationPermission())) {
        Toast.show({ type: 'error', text1: t('securityScreen.marmotPushNoPermission') });
        return false;
      }
      try {
        await setBackgroundDmEnabled(next, true);
        if (next) await startBackgroundDmWatch(true);
        else await stopBackgroundDmWatch();
      } catch (error) {
        await setBackgroundDmEnabled(backgroundDmOn);
        throw error;
      }
    });

  return (
    <AccountScreenLayout title={t('notificationSettingsScreen.title')}>
      <NotificationPermissionRow onPermissionChange={setPermissionGranted} />

      <SettingsSection scope="account" testID="notifications-account">
        <MarmotPushSection permissionGranted={permissionGranted} />
        <SellerActivitySetting />

        <SettingsRow
          kind="navigate"
          icon={BellOff}
          title={t('notificationMute.accounts')}
          subtitle={t('notificationSettingsScreen.mutedCount', { count: mutedSenders.size })}
          testID="notifications-muted-accounts"
          onPress={() => navigation.navigate('AccountMutedAccounts')}
        />
      </SettingsSection>
      <SettingsSection scope="phone" testID="notifications-phone">
        <SettingsRow
          kind="toggle"
          icon={BellRing}
          title={t('notificationSettingsScreen.showDetails')}
          subtitle={t(
            lockScreenContentOn
              ? 'notificationSettingsScreen.detailsOn'
              : 'notificationSettingsScreen.detailsOff',
          )}
          testID="notifications-content"
          details={t('securityScreen.notificationContentHint')}
          toggle={{
            value: lockScreenContentOn,
            pending: lockScreen.pending,
            onValueChange: handleToggleLockScreenContent,
            accessibilityLabel: t('securityScreen.showMessagePaymentDetailsA11y'),
            testID: 'security-lockscreen-content-toggle',
          }}
        />
        {isAndroid && (
          <SettingsRow
            kind="toggle"
            icon={Radio}
            title={t('notificationSettingsScreen.checkClosed')}
            subtitle={t(
              backgroundDmOn ? 'notificationSettingsScreen.on' : 'notificationSettingsScreen.off',
            )}
            testID="notifications-background"
            infoTestID="security-background-dm-details"
            details={[
              t('securityScreen.backgroundNotificationsHint'),
              t('securityScreen.backgroundDetailsNoGoogle'),
              t('securityScreen.backgroundDetailsBattery'),
              t('securityScreen.backgroundDetailsPayments'),
            ].join('\n\n')}
            toggle={{
              value: backgroundDmOn,
              pending: background.pending,
              onValueChange: handleToggleBackgroundDm,
              testID: 'security-background-dm-toggle',
            }}
          />
        )}

        <SettingsRow
          kind="toggle"
          icon={KeyRound}
          title={t('keyBackupReminder.settingsTitle')}
          subtitle={t(
            backupRemindersOn ? 'notificationSettingsScreen.on' : 'notificationSettingsScreen.off',
          )}
          testID="notifications-backup-reminders"
          details={t('keyBackupReminder.settingsDetails')}
          toggle={{
            value: backupRemindersOn,
            pending: backupReminders.pending,
            onValueChange: handleToggleBackupReminders,
            testID: 'notif-backup-reminders-toggle',
          }}
        />

        <SettingsRow
          kind="navigate"
          icon={MapPin}
          title={t('shopAlerts.title')}
          subtitle={t(shopOn ? 'notificationSettingsScreen.on' : 'notificationSettingsScreen.off')}
          testID="notifications-shop-alerts"
          onPress={() => navigation.navigate('AccountShopAlerts')}
        />
        <SettingsRow
          kind="navigate"
          icon={Server}
          title={t('securityScreen.marmotPushServerTitle')}
          details={t('securityScreen.marmotPushServerHint')}
          subtitle={t(
            customServer
              ? 'notificationSettingsScreen.customServer'
              : 'notificationSettingsScreen.defaultServer',
          )}
          testID="notifications-notification-server"
          onPress={() => navigation.navigate('AccountNotificationServer')}
        />
      </SettingsSection>
    </AccountScreenLayout>
  );
};

export default NotificationSettingsScreen;
