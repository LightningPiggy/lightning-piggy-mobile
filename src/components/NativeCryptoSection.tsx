import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Text, View } from 'react-native';
import { LockKeyhole } from 'lucide-react-native';
import SettingsRow from './SettingsRow';
import { createSettingsInfoSheetStyles } from '../styles/SettingsInfoSheet.styles';
import { useFocusEffect } from '@react-navigation/native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { isNativeCryptoActive, isNativeCryptoAvailable } from '../services/nostrCrypto';
import {
  loadNativeCryptoEnabled,
  saveNativeCryptoEnabled,
} from '../services/nativeCryptoPreference';

/**
 * Settings → Advanced → On this phone: "Faster encryption" — routes NIP-44
 * encryption and signature checks through the native rust-nostr module
 * (#1057). On by default since #1727; this toggle is the opt-out.
 */
const NativeCryptoSection: React.FC = () => {
  const t = useTranslation();
  const colors = useThemeColors();
  const styles = useMemo(() => createSettingsInfoSheetStyles(colors), [colors]);

  // Availability is a stable capability probe (native platform + module
  // linked) — compute once. `active` is re-read on a focus tick so a tester
  // can watch it flip to "yes" only AFTER restarting with the pref on.
  const available = useMemo(() => isNativeCryptoAvailable(), []);
  const [on, setOn] = useState(true); // the default (#1727) until the pref loads
  const [active, setActive] = useState(false);

  useEffect(() => {
    loadNativeCryptoEnabled().then(setOn);
  }, []);

  useFocusEffect(
    useCallback(() => {
      const tick = () => setActive(isNativeCryptoActive());
      tick();
      const id = setInterval(tick, 3000);
      return () => clearInterval(id);
    }, []),
  );

  // Toggling only WRITES the pref — routing is applied once at startup
  // (index.ts), so this deliberately does not call setNativeCryptoEnabled;
  // the row's caption tells the tester to restart to apply.
  const handleToggle = useCallback(async (next: boolean) => {
    setOn(next);
    await saveNativeCryptoEnabled(next);
  }, []);

  return (
    <View testID="advanced-experimental">
      <SettingsRow
        kind="toggle"
        icon={LockKeyhole}
        title={t('nostrScreen.nativeCryptoLabel')}
        subtitle={
          available
            ? t('nostrScreen.nativeCryptoRestartCaption')
            : t('nostrScreen.nativeCryptoUnavailable')
        }
        testID="advanced-native-crypto"
        infoTestID="nostr-native-crypto-info"
        toggle={{
          value: available && on,
          onValueChange: handleToggle,
          disabled: !available,
          testID: 'nostr-native-crypto-toggle',
        }}
        details={
          <>
            <Text style={styles.body}>{t('nostrScreen.nativeCryptoHint')}</Text>
            <Text style={styles.body} testID="nostr-native-crypto-active">
              {active
                ? t('nostrScreen.nativeCryptoActiveYes')
                : t('nostrScreen.nativeCryptoActiveNo')}
            </Text>
          </>
        }
      />
    </View>
  );
};

export default NativeCryptoSection;
