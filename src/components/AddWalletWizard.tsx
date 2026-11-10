import BrandedSpinner from './BrandedSpinner';
import React, { useState, useCallback, useRef, useEffect, useMemo } from 'react';
import { View, Text, TouchableOpacity, Image } from 'react-native';
import { ensurePermission } from '../utils/permissionPrompt';
import { CameraView, useCameraPermissions } from 'expo-camera';
import {
  BottomSheetBackdrop,
  type BottomSheetBackdropProps,
  BottomSheetScrollView,
  BottomSheetTextInput,
  type BottomSheetScrollViewMethods,
} from '@gorhom/bottom-sheet';
import { BottomSheetModal } from './AccessibleBottomSheetModal';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useAddWalletWizardKeyboard } from '../utils/useAddWalletWizardKeyboard';
import * as Clipboard from 'expo-clipboard';
import { useWallet } from '../contexts/WalletContext';
import { useGroups } from '../contexts/GroupsContext';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createAddWalletWizardStyles } from '../styles/AddWalletWizard.styles';
import type { CardTheme, WalletType } from '../types/wallet';
import { defaultCardThemeFor } from '../themes/cardThemes';
import WalletCardPicker from './WalletCardPicker';
import { validateNwcUrl } from '../services/nwcService';
import { validateOnchainImport } from '../services/onchainService';
import { LightningIcon, ChainIcon } from './icons/ArrowIcons';
import { ClipboardPaste, QrCode } from 'lucide-react-native';
import CreateCoinosWalletSheet from './CreateCoinosWalletSheet';

interface Props {
  visible: boolean;
  onClose: () => void;
}

type Step = 'type' | 'url' | 'xpub' | 'mnemonic' | 'alias' | 'theme';

const AddWalletWizard: React.FC<Props> = ({ visible, onClose }) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createAddWalletWizardStyles(colors), [colors]);
  const { addNwcWallet, addOnchainWallet, addHotWallet } = useWallet();
  const [step, setStep] = useState<Step>('type');
  const [walletType, setWalletType] = useState<WalletType>('nwc');
  const [nwcUrl, setNwcUrl] = useState('');
  const [xpub, setXpub] = useState('');
  const [mnemonicInput, setMnemonicInput] = useState('');
  const [alias, setAlias] = useState('');
  // Per-account Secret Mode (GroupsContext owns the active account's value).
  const { secretMode } = useGroups();
  const [selectedTheme, setSelectedTheme] = useState<CardTheme>(defaultCardThemeFor('nwc'));
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const [coinosOpen, setCoinosOpen] = useState(false);
  const bottomSheetRef = useRef<BottomSheetModal>(null);
  const scrollRef = useRef<BottomSheetScrollViewMethods>(null);
  const insets = useSafeAreaInsets();
  const paddingBottom = useAddWalletWizardKeyboard(visible, step, scrollRef);
  // No explicit snapPoints — content-height only, not user-draggable.

  const reset = useCallback(() => {
    setStep('type');
    setWalletType('nwc');
    setNwcUrl('');
    setXpub('');
    setMnemonicInput('');
    setAlias('');
    setSelectedTheme(defaultCardThemeFor('nwc'));
    setError(null);
    setConnecting(false);
    setScanning(false);
  }, []);

  const handleClose = useCallback(() => {
    reset();
    onClose();
  }, [reset, onClose]);

  // --- Step: Wallet Type Selection ---
  const handleTypeSelect = (type: WalletType) => {
    setWalletType(type);
    setError(null);
    setSelectedTheme(defaultCardThemeFor(type));
    if (type === 'nwc') {
      setStep('url');
    } else {
      setStep('xpub');
    }
  };

  const handleMnemonicSelect = () => {
    setWalletType('onchain');
    setSelectedTheme(defaultCardThemeFor('onchain'));
    setError(null);
    setStep('mnemonic');
  };

  // --- Step: Mnemonic ---
  const handleMnemonicNext = () => {
    const normalized = mnemonicInput
      .replace(/[0-9.:;,]/g, '')
      .replace(/[\r\n\t]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const wordCount = normalized.split(' ').length;
    if (wordCount !== 12 && wordCount !== 24) {
      setError(t('addWalletWizard.errorWordCount', { count: wordCount }));
      return;
    }
    setError(null);
    setStep('alias');
  };

  // --- Step: NWC URL ---
  const handleUrlNext = () => {
    const validation = validateNwcUrl(nwcUrl.trim());
    if (!validation.valid) {
      setError(validation.error || t('addWalletWizard.errorInvalidNwc'));
      return;
    }
    setError(null);
    setStep('alias');
  };

  // --- Step: xpub ---
  const handleXpubNext = () => {
    const err = validateOnchainImport(xpub.trim());
    if (err) {
      setError(err);
      return;
    }
    setError(null);
    setStep('alias');
  };

  const handleAliasNext = () => {
    if (!alias.trim()) {
      setError(t('addWalletWizard.errorAliasRequired'));
      return;
    }
    setError(null);
    setStep('theme');
  };

  const handleConnect = async () => {
    setConnecting(true);
    setError(null);
    try {
      if (walletType === 'onchain' && mnemonicInput.trim()) {
        // Hot wallet (mnemonic)
        const result = await addHotWallet(mnemonicInput, alias.trim(), selectedTheme);
        if (result.success) {
          handleClose();
        } else {
          setError(result.error || t('addWalletWizard.errorAddWalletFailed'));
        }
      } else if (walletType === 'onchain') {
        // Watch-only (xpub)
        const result = await addOnchainWallet(xpub.trim(), alias.trim(), selectedTheme);
        if (result.success) {
          handleClose();
        } else {
          setError(result.error || t('addWalletWizard.errorAddWalletFailed'));
        }
      } else {
        const result = await addNwcWallet(nwcUrl.trim(), alias.trim(), selectedTheme);
        if (result.success) {
          handleClose();
        } else {
          setError(result.error || t('addWalletWizard.errorConnectionFailed'));
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t('addWalletWizard.errorConnectionFailed'));
    } finally {
      setConnecting(false);
    }
  };

  const handleScan = async () => {
    if (
      !permission?.granted &&
      !(await ensurePermission(
        requestPermission,
        t('addWalletWizard.permissionRequiredTitle'),
        t('addWalletWizard.cameraPermissionMessage'),
      ))
    ) {
      return;
    }
    setScanning(true);
  };

  const handleBarCodeScanned = ({ data }: { data: string }) => {
    setScanning(false);
    const trimmed = data.trim();
    if (walletType === 'onchain') {
      setXpub(trimmed);
    } else {
      setNwcUrl(trimmed);
    }
    setError(null);
  };

  const handleSheetChange = useCallback(
    (index: number) => {
      if (index === -1) handleClose();
    },
    [handleClose],
  );

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />
    ),
    [],
  );

  useEffect(() => {
    if (visible) {
      bottomSheetRef.current?.present();
    } else {
      bottomSheetRef.current?.dismiss();
    }
  }, [visible]);

  // Note: we deliberately don't early-return on `!visible`. The CoinOS
  // create-sheet is rendered alongside this wizard and needs to outlive
  // the wizard's dismissal — the user's path is "Add Wallet → Create
  // Lightning Wallet → CoinOS sheet → Home", so the wizard dismisses
  // mid-flow and the CoinOS sheet keeps going. The underlying
  // BottomSheetModal hides itself via the ref-driven dismiss() above.

  const stepTitle: Record<Step, string> = {
    type: t('addWalletWizard.titleAddWallet'),
    url: t('addWalletWizard.titleConnectWallet'),
    xpub: t('addWalletWizard.titleImportPublicKey'),
    mnemonic: t('addWalletWizard.titleImportSeedPhrase'),
    alias: t('addWalletWizard.titleNameWallet'),
    theme: t('addWalletWizard.titleChooseDesign'),
  };

  const backStep = (): Step => {
    switch (step) {
      case 'url':
      case 'xpub':
      case 'mnemonic':
        return 'type';
      case 'alias':
        return mnemonicInput.trim() ? 'mnemonic' : walletType === 'onchain' ? 'xpub' : 'url';
      case 'theme':
        return 'alias';
      default:
        return 'type';
    }
  };

  return (
    <>
      <BottomSheetModal
        ref={bottomSheetRef}
        enablePanDownToClose
        onChange={handleSheetChange}
        backdropComponent={renderBackdrop}
        backgroundStyle={styles.sheetBackground}
        handleIndicatorStyle={styles.handle}
        topInset={insets.top}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
      >
        <BottomSheetScrollView
          ref={scrollRef}
          style={styles.content}
          contentContainerStyle={{ paddingBottom }}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.title} testID="wizard-step-title">
            {stepTitle[step]}
          </Text>

          {/* Step: Wallet Type Selection */}
          {step === 'type' && (
            <View style={styles.stepContent}>
              <Text style={styles.description}>{t('addWalletWizard.typePrompt')}</Text>
              {/* Auto-provision (CoinOS managed). First in the list because
                it's the zero-friction path for new users. The custody
                disclosure lives in the create flow itself, not here, so
                this tile stays visually consistent with the rest. */}
              <TouchableOpacity
                accessibilityRole="button"
                style={styles.typeCard}
                onPress={() => {
                  // Close THIS sheet so the create-CoinOS sheet can take
                  // its slot — two presented BottomSheetModals stack and
                  // make the lower one un-tappable.
                  bottomSheetRef.current?.dismiss();
                  // Defer opening so the dismiss animation has a frame.
                  setTimeout(() => setCoinosOpen(true), 250);
                }}
                testID="wallet-type-coinos"
                accessibilityLabel={t('addWalletWizard.a11yCreateCoinos')}
              >
                <View style={styles.typeCardIconWrapper}>
                  <Image
                    source={require('../../assets/images/coinos-logo-mark.png')}
                    style={styles.coinosLogo}
                    resizeMode="contain"
                  />
                </View>
                <View style={styles.typeCardText}>
                  <Text style={styles.typeCardTitle}>{t('addWalletWizard.coinosTitle')}</Text>
                  <Text style={styles.typeCardDesc}>{t('addWalletWizard.coinosDesc')}</Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                style={styles.typeCard}
                onPress={() => handleTypeSelect('nwc')}
                testID="wallet-type-nwc"
                accessibilityLabel={t('addWalletWizard.a11yConnectExisting')}
              >
                <View style={styles.typeCardIconWrapper}>
                  <LightningIcon size={28} color={colors.brandPink} strokeWidth={2.5} />
                </View>
                <View style={styles.typeCardText}>
                  <Text style={styles.typeCardTitle}>
                    {t('addWalletWizard.connectExistingTitle')}
                  </Text>
                  <Text style={styles.typeCardDesc}>
                    {t('addWalletWizard.connectExistingDesc')}
                  </Text>
                </View>
              </TouchableOpacity>
              <TouchableOpacity
                accessibilityRole="button"
                style={styles.typeCard}
                onPress={() => handleTypeSelect('onchain')}
                testID="wallet-type-onchain"
                accessibilityLabel={t('addWalletWizard.a11yOnchain')}
              >
                <View style={styles.typeCardIconWrapper}>
                  <ChainIcon size={28} color={colors.brandPink} strokeWidth={2.5} />
                </View>
                <View style={styles.typeCardText}>
                  <Text style={styles.typeCardTitle}>{t('addWalletWizard.onchainTitle')}</Text>
                  <Text style={styles.typeCardDesc}>{t('addWalletWizard.onchainDesc')}</Text>
                </View>
              </TouchableOpacity>
              {secretMode && (
                <TouchableOpacity
                  accessibilityRole="button"
                  style={styles.typeCard}
                  onPress={handleMnemonicSelect}
                  testID="wallet-type-mnemonic"
                  accessibilityLabel={t('addWalletWizard.a11yImportSeed')}
                >
                  <View style={styles.typeCardIconWrapper}>
                    <LightningIcon size={28} color="#FF9800" strokeWidth={2.5} />
                  </View>
                  <View style={styles.typeCardText}>
                    <Text style={styles.typeCardTitle}>{t('addWalletWizard.seedPhraseTitle')}</Text>
                    <Text style={styles.typeCardDesc}>{t('addWalletWizard.seedPhraseDesc')}</Text>
                  </View>
                </TouchableOpacity>
              )}
            </View>
          )}

          {/* Step: NWC URL */}
          {step === 'url' && (
            <View style={styles.stepContent}>
              {scanning ? (
                <View style={styles.scannerContainer}>
                  <CameraView
                    style={styles.scanner}
                    facing="back"
                    barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                    onBarcodeScanned={handleBarCodeScanned}
                  />
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={t('addWalletWizard.cancel')}
                    testID="wizard-nwc-cancel-scan"
                    style={styles.secondaryButton}
                    onPress={() => setScanning(false)}
                  >
                    <Text style={styles.secondaryButtonText}>{t('addWalletWizard.cancel')}</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <>
                  <Text style={styles.description}>{t('addWalletWizard.nwcDescription')}</Text>
                  <BottomSheetTextInput
                    style={styles.nwcInput}
                    placeholder="nostr+walletconnect://..."
                    placeholderTextColor={colors.textSupplementary}
                    value={nwcUrl}
                    onChangeText={(text) => {
                      setNwcUrl(text);
                      setError(null);
                    }}
                    multiline
                    autoCapitalize="none"
                    autoCorrect={false}
                    testID="nwc-url-input"
                    accessibilityLabel={t('addWalletWizard.a11yNwcInput')}
                  />
                  <View style={styles.secondaryButtonRow}>
                    <TouchableOpacity
                      accessibilityRole="button"
                      style={[styles.secondaryButton, styles.secondaryButtonHalf]}
                      onPress={handleScan}
                      accessibilityLabel={t('addWalletWizard.a11yScanQrCode')}
                      testID="wizard-nwc-scan"
                    >
                      <QrCode size={18} color={colors.textBody} strokeWidth={2} />
                      <Text style={styles.secondaryButtonText}>{t('addWalletWizard.scanQr')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      accessibilityRole="button"
                      style={[styles.secondaryButton, styles.secondaryButtonHalf]}
                      onPress={async () => {
                        const text = await Clipboard.getStringAsync();
                        if (text) {
                          setNwcUrl(text.trim());
                          setError(null);
                        }
                      }}
                      accessibilityLabel={t('addWalletWizard.a11yPasteNwc')}
                      testID="wizard-nwc-paste"
                    >
                      <ClipboardPaste size={18} color={colors.textBody} strokeWidth={2} />
                      <Text style={styles.secondaryButtonText}>{t('addWalletWizard.paste')}</Text>
                    </TouchableOpacity>
                  </View>
                  {error && <Text style={styles.errorText}>{error}</Text>}
                  <View style={styles.buttonRow}>
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel={t('addWalletWizard.back')}
                      testID="wizard-nwc-back"
                      style={styles.backButton}
                      onPress={() => {
                        setError(null);
                        setStep('type');
                      }}
                    >
                      <Text style={styles.backButtonText}>{t('addWalletWizard.back')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      accessibilityRole="button"
                      style={[styles.primaryButton, { flex: 1 }]}
                      onPress={handleUrlNext}
                      accessibilityLabel={t('addWalletWizard.a11yNextValidateNwc')}
                      testID="wizard-url-next"
                    >
                      <Text style={styles.primaryButtonText}>{t('addWalletWizard.next')}</Text>
                    </TouchableOpacity>
                  </View>
                </>
              )}
            </View>
          )}

          {/* Step: xpub import */}
          {step === 'xpub' && (
            <View style={styles.stepContent}>
              {scanning ? (
                <View style={styles.scannerContainer}>
                  <CameraView
                    style={styles.scanner}
                    facing="back"
                    barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
                    onBarcodeScanned={handleBarCodeScanned}
                  />
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={t('addWalletWizard.cancel')}
                    testID="wizard-xpub-cancel-scan"
                    style={styles.secondaryButton}
                    onPress={() => setScanning(false)}
                  >
                    <Text style={styles.secondaryButtonText}>{t('addWalletWizard.cancel')}</Text>
                  </TouchableOpacity>
                </View>
              ) : (
                <>
                  <Text style={styles.description}>{t('addWalletWizard.xpubDescription')}</Text>
                  <BottomSheetTextInput
                    style={styles.nwcInput}
                    placeholder="xpub6… or bc1q…"
                    placeholderTextColor={colors.textSupplementary}
                    value={xpub}
                    onChangeText={(text) => {
                      setXpub(text);
                      setError(null);
                    }}
                    multiline
                    autoCapitalize="none"
                    autoCorrect={false}
                    testID="xpub-input"
                    accessibilityLabel={t('addWalletWizard.a11yXpubInput')}
                  />
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={t('addWalletWizard.scanQrCode')}
                    testID="wizard-xpub-scan"
                    style={styles.secondaryButton}
                    onPress={handleScan}
                  >
                    <Text style={styles.secondaryButtonText}>
                      {t('addWalletWizard.scanQrCode')}
                    </Text>
                  </TouchableOpacity>
                  {error && <Text style={styles.errorText}>{error}</Text>}
                  <View style={styles.buttonRow}>
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel={t('addWalletWizard.back')}
                      testID="wizard-xpub-back"
                      style={styles.backButton}
                      onPress={() => {
                        setError(null);
                        setStep('type');
                      }}
                    >
                      <Text style={styles.backButtonText}>{t('addWalletWizard.back')}</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel={t('addWalletWizard.next')}
                      testID="wizard-xpub-next"
                      style={[styles.primaryButton, { flex: 1 }]}
                      onPress={handleXpubNext}
                    >
                      <Text style={styles.primaryButtonText}>{t('addWalletWizard.next')}</Text>
                    </TouchableOpacity>
                  </View>
                </>
              )}
            </View>
          )}

          {/* Step: Mnemonic import (dev mode only) */}
          {step === 'mnemonic' && (
            <View style={styles.stepContent}>
              <Text style={styles.description}>{t('addWalletWizard.mnemonicDescription')}</Text>
              <BottomSheetTextInput
                style={[styles.nwcInput, { minHeight: 100 }]}
                placeholder={t('addWalletWizard.mnemonicPlaceholder')}
                placeholderTextColor={colors.textSupplementary}
                value={mnemonicInput}
                onChangeText={(text) => {
                  setMnemonicInput(text);
                  setError(null);
                }}
                multiline
                autoCapitalize="none"
                autoCorrect={false}
                testID="mnemonic-input"
                accessibilityLabel={t('addWalletWizard.a11yMnemonicInput')}
              />
              {error && <Text style={styles.errorText}>{error}</Text>}
              <View style={styles.buttonRow}>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={t('addWalletWizard.back')}
                  testID="wizard-mnemonic-back"
                  style={styles.backButton}
                  onPress={() => {
                    setError(null);
                    setStep('type');
                  }}
                >
                  <Text style={styles.backButtonText}>{t('addWalletWizard.back')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={t('addWalletWizard.next')}
                  testID="wizard-mnemonic-next"
                  style={[styles.primaryButton, { flex: 1 }]}
                  onPress={handleMnemonicNext}
                >
                  <Text style={styles.primaryButtonText}>{t('addWalletWizard.next')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {step === 'alias' && (
            <View style={styles.stepContent}>
              <Text style={styles.description}>{t('addWalletWizard.aliasDescription')}</Text>
              <BottomSheetTextInput
                style={styles.aliasInput}
                placeholder={t('addWalletWizard.aliasPlaceholder')}
                placeholderTextColor={colors.textSupplementary}
                value={alias}
                onChangeText={(text) => {
                  setAlias(text);
                  setError(null);
                }}
                autoCapitalize="words"
                autoCorrect={false}
                testID="wallet-alias-input"
                accessibilityLabel={t('addWalletWizard.a11yAliasInput')}
              />
              {error && <Text style={styles.errorText}>{error}</Text>}
              <View style={styles.buttonRow}>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={t('addWalletWizard.back')}
                  testID="wizard-alias-back"
                  style={styles.backButton}
                  onPress={() => {
                    setError(null);
                    setStep(backStep());
                  }}
                >
                  <Text style={styles.backButtonText}>{t('addWalletWizard.back')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={t('addWalletWizard.next')}
                  testID="wizard-alias-next"
                  style={[styles.primaryButton, { flex: 1 }]}
                  onPress={handleAliasNext}
                >
                  <Text style={styles.primaryButtonText}>{t('addWalletWizard.next')}</Text>
                </TouchableOpacity>
              </View>
            </View>
          )}

          {step === 'theme' && (
            <View style={styles.stepContent}>
              <Text style={styles.description}>{t('addWalletWizard.themeDescription')}</Text>
              <WalletCardPicker selectedTheme={selectedTheme} onSelect={setSelectedTheme} />
              {error && <Text style={styles.errorText}>{error}</Text>}
              <View style={styles.buttonRow}>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={t('addWalletWizard.back')}
                  testID="wizard-theme-back"
                  style={styles.backButton}
                  onPress={() => {
                    setError(null);
                    setStep('alias');
                  }}
                >
                  <Text style={styles.backButtonText}>{t('addWalletWizard.back')}</Text>
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityState={{ disabled: connecting, busy: connecting }}
                  style={[styles.primaryButton, { flex: 1 }, connecting && { opacity: 0.7 }]}
                  onPress={handleConnect}
                  disabled={connecting}
                  testID="wizard-connect-button"
                  accessibilityLabel={
                    walletType === 'onchain'
                      ? t('addWalletWizard.a11yAddOnchainWallet')
                      : t('addWalletWizard.a11yConnectWallet')
                  }
                >
                  {connecting ? (
                    <BrandedSpinner onGradient />
                  ) : (
                    <Text style={styles.primaryButtonText}>
                      {walletType === 'onchain'
                        ? t('addWalletWizard.addWalletButton')
                        : t('addWalletWizard.connectButton')}
                    </Text>
                  )}
                </TouchableOpacity>
              </View>
            </View>
          )}
        </BottomSheetScrollView>
      </BottomSheetModal>
      {/* CoinOS create flow lives outside the wizard's BottomSheetModal so
        it survives the wizard's dismiss(). Mounted unconditionally so
        the visible={coinosOpen} prop drives presentation. */}
      <CreateCoinosWalletSheet
        visible={coinosOpen}
        onClose={() => setCoinosOpen(false)}
        onComplete={() => {
          setCoinosOpen(false);
          // Roll the wizard back to step 'type' so the next time it opens
          // the user starts at the menu, not in the middle of a previous
          // CoinOS attempt.
          reset();
          onClose();
        }}
      />
    </>
  );
};

export default AddWalletWizard;
