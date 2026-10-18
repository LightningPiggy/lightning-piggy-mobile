import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity } from 'react-native';
import AccountScreenLayout from './AccountScreenLayout';
import { createSharedAccountStyles } from './sharedStyles';
import { useThemeColors } from '../../contexts/ThemeContext';
import { useTranslation } from '../../contexts/LocaleContext';
import SwapBackendSettings from '../../components/SwapBackendSettings';
import { getElectrumServer } from '../../services/walletStorageService';
import ServerConnectionTest from '../../components/ServerConnectionTest';
import SaveResultBox from '../../components/SaveResultBox';
import {
  checkAndSaveElectrumServer,
  checkElectrumConnection,
  electrumSaveErrorKey,
} from '../../services/onchainConnectionService';

const DEFAULT_ELECTRUM = 'electrum.blockstream.info:50002';

/**
 * Settings → Advanced → Bitcoin network: the Electrum server on-chain
 * wallets use, and the swap server. The default refund wallet moved to
 * Settings → Wallets.
 */
const OnChainScreen: React.FC = () => {
  const colors = useThemeColors();
  const t = useTranslation();
  const sharedAccountStyles = useMemo(() => createSharedAccountStyles(colors), [colors]);
  const [electrumHostPort, setElectrumHostPort] = useState(DEFAULT_ELECTRUM);
  const [electrumSSL, setElectrumSSL] = useState(true);
  const [electrumLoading, setElectrumLoading] = useState(true);
  const [electrumLoaded, setElectrumLoaded] = useState(false);
  const [electrumError, setElectrumError] = useState(false);
  const [electrumBusy, setElectrumBusy] = useState(false);
  const [electrumMessage, setElectrumMessage] = useState('');
  const [electrumFailed, setElectrumFailed] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    getElectrumServer()
      .then((server) => {
        if (!mounted.current) return;
        const parts = server.split(':');
        const protocol = parts.pop(); // 's' or 't'
        setElectrumHostPort(parts.join(':'));
        setElectrumSSL(protocol === 's');
        setElectrumLoaded(true);
      })
      .catch(() => {
        if (mounted.current) setElectrumError(true);
      })
      .finally(() => {
        if (mounted.current) setElectrumLoading(false);
      });
    return () => {
      mounted.current = false;
    };
  }, []);

  const editElectrum = () => {
    setElectrumLoaded(true);
    setElectrumError(false);
    setElectrumMessage('');
  };
  const saveElectrum = async () => {
    setElectrumBusy(true);
    setElectrumMessage('');
    try {
      await checkAndSaveElectrumServer(electrumHostPort, electrumSSL);
      if (!mounted.current) return;
      setElectrumFailed(false);
      setElectrumMessage(t('onChainScreen.saved'));
    } catch (error) {
      if (!mounted.current) return;
      setElectrumFailed(true);
      setElectrumMessage(t(electrumSaveErrorKey(error)));
    } finally {
      if (mounted.current) setElectrumBusy(false);
    }
  };
  const testElectrum = useCallback(
    (signal: AbortSignal) => checkElectrumConnection(electrumHostPort, electrumSSL, signal),
    [electrumHostPort, electrumSSL],
  );
  const electrumDisabled = electrumLoading || electrumBusy || !electrumLoaded;

  return (
    <AccountScreenLayout title={t('onChainScreen.title')} parent="AccountAdvanced">
      <Text style={sharedAccountStyles.sectionLabel}>{t('onChainScreen.electrumServer')}</Text>
      <TextInput
        style={sharedAccountStyles.textInput}
        value={electrumHostPort}
        onChangeText={(value) => {
          setElectrumHostPort(value);
          editElectrum();
        }}
        editable={!electrumLoading && !electrumBusy}
        placeholder={DEFAULT_ELECTRUM}
        placeholderTextColor="rgba(0,0,0,0.3)"
        autoCapitalize="none"
        autoCorrect={false}
        testID="electrum-server-input"
        accessibilityLabel={t('onChainScreen.electrumServerA11y')}
      />
      <View style={sharedAccountStyles.sslRow}>
        <Text style={sharedAccountStyles.sslLabel}>{t('onChainScreen.useSsl')}</Text>
        <TouchableOpacity
          style={[
            sharedAccountStyles.sslToggle,
            electrumSSL && sharedAccountStyles.sslToggleActive,
          ]}
          onPress={() => {
            setElectrumSSL(!electrumSSL);
            editElectrum();
          }}
          disabled={electrumDisabled}
          testID="electrum-ssl-toggle"
          accessibilityLabel={t('onChainScreen.useSsl')}
          accessibilityRole="switch"
          accessibilityState={{
            checked: electrumSSL,
            disabled: electrumDisabled,
          }}
        >
          <View
            style={[
              sharedAccountStyles.sslToggleThumb,
              electrumSSL && sharedAccountStyles.sslToggleThumbActive,
            ]}
          />
        </TouchableOpacity>
      </View>
      <Text style={sharedAccountStyles.fieldHint}>{t('onChainScreen.hint')}</Text>
      <ServerConnectionTest
        inputKey={`${electrumHostPort}:${electrumSSL}`}
        probe={testElectrum}
        disabled={electrumDisabled}
        label={t('serverConnection.electrumTest')}
        testID="electrum-connection"
      />
      <TouchableOpacity
        style={sharedAccountStyles.saveButton}
        onPress={saveElectrum}
        disabled={electrumDisabled}
        accessibilityRole="button"
        accessibilityState={{ disabled: electrumDisabled, busy: electrumBusy }}
        accessibilityLabel={t('onChainScreen.save')}
        testID="electrum-save"
      >
        <Text style={sharedAccountStyles.saveButtonText}>
          {t(electrumBusy ? 'swapBackend.checking' : 'onChainScreen.save')}
        </Text>
      </TouchableOpacity>
      {!!electrumMessage && (
        <SaveResultBox
          message={electrumMessage}
          failed={electrumFailed}
          testID="electrum-save-message"
        />
      )}
      {electrumError && (
        <Text
          style={sharedAccountStyles.fieldHint}
          testID="electrum-settings-error"
          accessibilityLiveRegion="polite"
        >
          {t('serverConnection.electrumLoadError')}
        </Text>
      )}

      <SwapBackendSettings />
    </AccountScreenLayout>
  );
};

export default OnChainScreen;
