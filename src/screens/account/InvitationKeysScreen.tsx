import BrandedSpinner from '../../components/BrandedSpinner';
import React, { useCallback, useMemo, useState } from 'react';
import { FlatList, Text, TouchableOpacity, View } from 'react-native';
import { Info } from 'lucide-react-native';
import SettingsInfoSheet from '../../components/SettingsInfoSheet';
import AccountScreenLayout from './AccountScreenLayout';
import InvitationDeviceRow from '../../components/InvitationDeviceRow';
import { useThemeColors } from '../../contexts/ThemeContext';
import { useLocale } from '../../contexts/LocaleContext';
import { useInvitationKeys } from '../../hooks/useInvitationKeys';
import type { InvitationDevice } from '../../services/marmotInvitationDevices';
import { createInvitationKeysScreenStyles } from '../../styles/InvitationKeysScreen.styles';

const keyExtractor = (device: InvitationDevice) => `${device.kind}:${device.slot}`;

/**
 * "Devices that can get new chats" (#1236): which of the account's devices
 * publish an invitation key (so people can start encrypted chats with them),
 * with Refresh for this phone and removal for devices no longer used.
 */
export default function InvitationKeysScreen() {
  const colors = useThemeColors();
  const { t } = useLocale();
  const styles = useMemo(() => createInvitationKeysScreenStyles(colors), [colors]);
  const state = useInvitationKeys();
  const [infoOpen, setInfoOpen] = useState(false);
  const disabled = state.busy || state.loading;
  const canRemoveOld = !disabled && state.oldCount > 0;

  const renderItem = useCallback(
    ({ item }: { item: InvitationDevice }) => (
      <InvitationDeviceRow
        device={item}
        styles={styles}
        disabled={disabled}
        onRefresh={state.refresh}
        onStop={state.stopInvites}
      />
    ),
    [styles, disabled, state.refresh, state.stopInvites],
  );

  const header = (
    <View style={styles.header}>
      <TouchableOpacity
        style={styles.info}
        onPress={() => setInfoOpen(true)}
        accessibilityRole="button"
        accessibilityLabel={t('securityScreen.details')}
        testID="invitation-keys-info"
      >
        <Info size={22} color={colors.white} />
      </TouchableOpacity>
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel={t('invitationKeys.removeOldA11y', { count: state.oldCount })}
        testID="invitation-keys-remove-old"
        style={[styles.button, !canRemoveOld && styles.disabled]}
        disabled={!canRemoveOld}
        onPress={state.removeOld}
      >
        <Text style={styles.buttonText}>
          {t('invitationKeys.removeOld', { count: state.oldCount })}
        </Text>
      </TouchableOpacity>
      <Text style={styles.note}>{t('invitationKeys.removeOldHint')}</Text>
      {state.publicationFailed && (
        <View testID="invitation-keys-publish-failed">
          <Text style={styles.note}>{t('invitationKeys.refreshFailedTitle')}</Text>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={t('invitationKeys.refresh')}
            testID="invitation-keys-retry-publish"
            style={[styles.link, disabled && styles.disabled]}
            disabled={disabled}
            onPress={state.retryPublication}
          >
            <Text style={styles.linkText}>{t('invitationKeys.refresh')}</Text>
          </TouchableOpacity>
        </View>
      )}
      {state.partial && (
        <Text style={styles.note} testID="invitation-keys-partial">
          {t('invitationKeys.partial')}
        </Text>
      )}
      {state.error && (
        <Text style={styles.note} testID="invitation-keys-error">
          {t('invitationKeys.loadFailed')}
        </Text>
      )}
      <TouchableOpacity
        accessibilityRole="button"
        testID="invitation-keys-reload"
        accessibilityLabel={t('invitationKeys.reload')}
        style={[styles.link, disabled && styles.disabled]}
        disabled={disabled}
        onPress={state.reload}
      >
        <Text style={styles.linkText}>{t('invitationKeys.reload')}</Text>
      </TouchableOpacity>
      {(state.loading || state.busy) && (
        <BrandedSpinner testID="invitation-keys-loading" onGradient />
      )}
    </View>
  );

  return (
    <AccountScreenLayout
      title={t('invitationKeys.title')}
      scrollable={false}
      parent="AccountMessages"
    >
      <SettingsInfoSheet
        visible={infoOpen}
        onClose={() => setInfoOpen(false)}
        title={t('invitationKeys.title')}
        testID="invitation-keys-info-sheet"
        paragraphs={[t('invitationKeys.description')]}
      />
      <FlatList
        testID="invitation-keys-list"
        style={styles.list}
        contentContainerStyle={styles.content}
        // Until the first scan finishes, "This phone" alone would look like the answer.
        data={state.loading && !state.devices.some((d) => d.versions.length) ? [] : state.devices}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        ListHeaderComponent={header}
      />
    </AccountScreenLayout>
  );
}
