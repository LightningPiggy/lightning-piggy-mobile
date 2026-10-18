import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import { View, Text, TextInput, TouchableOpacity } from 'react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createSharedAccountStyles } from '../screens/account/sharedStyles';
import ServerConnectionTest from './ServerConnectionTest';
import { createSwapBackendSettingsStyles } from '../styles/SwapBackendSettings.styles';
import SaveResultBox from './SaveResultBox';
import {
  DEFAULT_SWAP_BACKEND,
  getSwapBackend,
  checkAndSaveSwapBackend,
  checkSwapBackend,
  swapBackendSaveErrorKey,
} from '../services/swapBackendService';

export default function SwapBackendSettings() {
  const colors = useThemeColors();
  const t = useTranslation();
  const shared = useMemo(() => createSharedAccountStyles(colors), [colors]);
  const styles = useMemo(() => createSwapBackendSettingsStyles(), []);
  const [url, setUrl] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const mounted = useRef(true);
  const translation = useRef(t);
  translation.current = t;

  useEffect(() => {
    let active = true;
    mounted.current = true;
    getSwapBackend()
      .then((value) => {
        if (active) setUrl(value);
      })
      .catch(() => {
        if (!active) return;
        setFailed(true);
        setMessage(translation.current('swapBackend.loadError'));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      mounted.current = false;
    };
  }, []);

  const testBackend = useCallback((signal: AbortSignal) => checkSwapBackend(url, signal), [url]);

  const save = async () => {
    setBusy(true);
    setMessage('');
    try {
      const saved = await checkAndSaveSwapBackend(url);
      if (!mounted.current) return;
      setUrl(saved);
      setFailed(false);
      setMessage(t(saved ? 'swapBackend.saved' : 'swapBackend.cleared'));
    } catch (error) {
      if (!mounted.current) return;
      setFailed(true);
      setMessage(t(swapBackendSaveErrorKey(error)));
    } finally {
      if (mounted.current) setBusy(false);
    }
  };

  return (
    <View style={styles.section}>
      <Text style={shared.sectionLabel}>{t('swapBackend.title')}</Text>
      <TextInput
        style={shared.textInput}
        value={url}
        onChangeText={(value) => {
          setUrl(value);
          setMessage('');
        }}
        editable={!loading && !busy}
        placeholder={t('swapBackend.placeholder')}
        placeholderTextColor={colors.textSupplementary}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="url"
        testID="swap-backend-url"
        accessibilityLabel={t('swapBackend.title')}
      />
      <Text style={shared.fieldHint}>{t('swapBackend.hint')}</Text>
      <ServerConnectionTest
        inputKey={url}
        probe={testBackend}
        disabled={loading || busy || !url.trim()}
        label={t('serverConnection.boltzTest')}
        testID="boltz-connection"
      />
      <TouchableOpacity
        style={shared.saveButton}
        onPress={save}
        disabled={loading || busy}
        accessibilityRole="button"
        accessibilityState={{ disabled: loading || busy, busy }}
        accessibilityLabel={t('swapBackend.save')}
        testID="swap-backend-save"
      >
        <Text style={shared.saveButtonText}>
          {t(busy ? 'swapBackend.checking' : 'swapBackend.save')}
        </Text>
      </TouchableOpacity>
      {!!message && (
        <SaveResultBox message={message} failed={failed} testID="swap-backend-message" />
      )}
      <TouchableOpacity
        style={styles.reset}
        onPress={() => {
          setUrl(DEFAULT_SWAP_BACKEND);
          setMessage('');
        }}
        disabled={loading || busy}
        accessibilityRole="button"
        accessibilityState={{ disabled: loading || busy }}
        accessibilityLabel={t('swapBackend.default')}
        testID="swap-backend-default"
      >
        <Text style={shared.fieldHint}>{t('swapBackend.default')}</Text>
      </TouchableOpacity>
    </View>
  );
}
