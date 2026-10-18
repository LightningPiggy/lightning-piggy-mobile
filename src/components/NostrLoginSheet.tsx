import { enabledAppRelays, loadAppRelayPrefs } from '../services/appRelayPrefs';
import { TEST_ACCOUNT_KEYS } from '../utils/testAccounts';
import { isTestRelayLockdown, TEST_RELAY_URL } from '../config/testRelayLockdown';
import BrandedSpinner from './BrandedSpinner';
import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Platform,
  BackHandler,
  Keyboard,
  Linking,
} from 'react-native';
import { Alert } from './BrandedAlert';
import Svg, { Path } from 'react-native-svg';
import QRCode from 'react-native-qrcode-svg';
import * as Clipboard from 'expo-clipboard';
import {
  BottomSheetBackdrop,
  BottomSheetBackdropProps,
  BottomSheetScrollView,
  type BottomSheetScrollViewMethods,
  BottomSheetTextInput,
} from '@gorhom/bottom-sheet';
import { BottomSheetModal } from './AccessibleBottomSheetModal';
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure';
import { bytesToHex } from '@noble/hashes/utils.js';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createNostrLoginSheetStyles } from '../styles/NostrLoginSheet.styles';
import { setUpNewAccountContactList } from '../services/newAccountContactList';
import { useNostr } from '../contexts/NostrContext';
import * as nostrService from '../services/nostrService';
import * as nostrConnectService from '../services/nostrConnectService';
// Relays named in the `nostrconnect://` pairing URI (several, so one dead
// relay can't break sign-in: #1198, #1326).
import { NIP46_PAIRING_RELAYS } from '../services/nostrRelayDefaults';

import { NIP46_PERMS } from '../services/signerPermissions';

interface Props {
  visible: boolean;
  onClose: () => void;
}

type Mode = 'login' | 'create' | 'backup' | 'nip46-pair';

const NostrLoginSheet: React.FC<Props> = ({ visible, onClose }) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createNostrLoginSheetStyles(colors), [colors]);
  const { loginWithNsec, loginWithAmber, loginWithNip46, publishProfile, isLoggingIn } = useNostr();
  const [nsecInput, setNsecInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [mode, setMode] = useState<Mode>('login');
  const [newName, setNewName] = useState('');
  const [generatedNsec, setGeneratedNsec] = useState('');
  const [creating, setCreating] = useState(false);
  const [nip46Uri, setNip46Uri] = useState<string | null>(null);
  const [nip46Pairing, setNip46Pairing] = useState(false);
  /** True once the bunker has acked and we're finalising the login
   *  (adopt signer → loginWithNip46). Cancel is hidden in this window: the
   *  flow has committed and `loginWithNip46` already mutates NostrContext
   *  state, so a late Cancel can't cleanly roll it back — better to prevent
   *  it than to race it (Copilot review). */
  const [nip46Finalizing, setNip46Finalizing] = useState(false);
  /** Abort signal for an in-flight bunker pairing — set so dismissing
   *  the sheet (or tapping Cancel) aborts the BunkerSigner.fromURI
   *  promise instead of leaving a relay subscription hanging. */
  const nip46AbortRef = useRef<AbortController | null>(null);
  const sheetRef = useRef<BottomSheetModal>(null);
  const scrollRef = useRef<BottomSheetScrollViewMethods>(null);
  // No explicit snapPoints — content-height only, not user-draggable.

  useEffect(() => {
    if (visible) {
      setMode('login');
      setNewName('');
      setGeneratedNsec('');
      setNip46Uri(null);
      setNip46Pairing(false);
      setNip46Finalizing(false);
      setError(null);
      sheetRef.current?.present();
    } else {
      // Sheet closed externally — abort any in-flight bunker pairing
      // so the relay subscription doesn't outlive the UI.
      if (nip46AbortRef.current) {
        nip46AbortRef.current.abort();
        nip46AbortRef.current = null;
      }
      sheetRef.current?.dismiss();
    }
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose();
      return true;
    });
    return () => sub.remove();
  }, [visible, onClose]);

  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, (e) => {
      setKeyboardHeight(e.endCoordinates.height);
      setTimeout(() => scrollRef.current?.scrollToEnd?.({ animated: true }), 100);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />
    ),
    [],
  );

  const handleLogin = async () => {
    setError(null);
    const result = await loginWithNsec(nsecInput.trim());
    if (result.success) {
      setNsecInput('');
      onClose();
    } else {
      setError(result.error || t('nostrLoginSheet.loginFailed'));
    }
  };

  const handlePaste = async () => {
    const text = await Clipboard.getStringAsync();
    if (text) {
      setNsecInput(text.trim());
      setError(null);
    }
  };

  const handleCreate = () => {
    const { nsec } = nostrService.generateKeypair();
    setGeneratedNsec(nsec);
    setMode('create');
  };

  const handleFinishCreate = async () => {
    if (!newName.trim()) {
      setError(t('nostrLoginSheet.enterDisplayName'));
      return;
    }
    setCreating(true);
    setError(null);

    // Login with the generated nsec first
    const result = await loginWithNsec(generatedNsec);
    if (!result.success) {
      setError(result.error || t('nostrLoginSheet.createAccountFailed'));
      setCreating(false);
      return;
    }

    // Brand-new key: flag it as created here and publish an empty follow
    // list, so later follows always have a kind-3 to build on (#1271).
    // Best-effort and never for imported / signed-in keys.
    const { pubkey: newPubkey, secretKey } = nostrService.decodeNsec(generatedNsec);
    await loadAppRelayPrefs(newPubkey).catch(() => {});
    void setUpNewAccountContactList({
      pubkey: newPubkey,
      secretKey,
      relays: enabledAppRelays('default', nostrService.DEFAULT_RELAYS, newPubkey),
    }).catch((e) => {
      if (__DEV__) console.warn('[ContactList] new-account setup failed:', e);
    });

    // Publish initial profile with display name (best-effort, don't block)
    const published = await publishProfile({
      display_name: newName.trim(),
      name: newName.trim(),
    });
    if (!published) {
      // Profile publish failed but account is created — user can edit later
      if (__DEV__) console.warn('Initial profile publish failed');
    }

    // Show backup screen
    setMode('backup');
    setCreating(false);
  };

  const handleCopyNsec = async () => {
    await Clipboard.setStringAsync(generatedNsec);
    Alert.alert(t('nostrLoginSheet.copiedTitle'), t('nostrLoginSheet.copiedMessage'));
  };

  const handleDone = () => {
    setNsecInput('');
    onClose();
  };

  const handleAmber = async () => {
    setError(null);
    const result = await loginWithAmber();
    if (result.success) {
      onClose();
    } else {
      setError(result.error || t('nostrLoginSheet.amberLoginFailed'));
    }
  };

  /**
   * Begin a NIP-46 ("Nostr Connect" / bunker) pairing. Generates a
   * fresh per-app keypair, builds a `nostrconnect://` URI, renders it
   * as a QR for the user's bunker (Clave, Aegis, nsec.app) to scan,
   * then awaits the bunker's `connect` ack. On success, hands the
   * persisted connection to NostrContext.
   *
   * The per-app secret key is generated *here*, not in the service —
   * the URI's `clientPubkey` derives from it, and we need it locally
   * for the BunkerSigner to set up its inbound subscription.
   *
   * Two failure modes worth distinguishing:
   *  - User dismisses the sheet / taps Cancel → AbortController fires,
   *    BunkerSigner.fromURI rejects, we just close quietly.
   *  - 120s timeout reached → reject with a clear "took too long" so
   *    the user can retry without thinking it's an app bug.
   */
  const handleNip46 = async (targetPubkey?: string) => {
    // Single-flight guard: a live `nip46AbortRef` means a pairing run is
    // already in progress. Without this, a double-tap (before `setMode`
    // re-renders the button away) would start a second run whose
    // AbortController overwrites the first's ref — leaking the first
    // bunker subscription/signer, since Cancel could then only abort one.
    if (nip46AbortRef.current) return;
    const abort = new AbortController();
    nip46AbortRef.current = abort;
    setError(null);
    // Per-app keypair — never the user's real nsec. The bunker side
    // sees this as the "client" pubkey for the lifetime of the
    // pairing; it's persisted to SecureStore so app restarts don't
    // require re-pairing.
    const clientSecretKey = generateSecretKey();
    const clientPubkey = getPublicKey(clientSecretKey);
    // 16 random bytes → 32 hex chars. Used by the bunker to verify
    // that the inbound `connect` request matches the URI they scanned.
    // crypto.getRandomValues is polyfilled in src/polyfills.ts.
    const secretBytes = new Uint8Array(16);
    crypto.getRandomValues(secretBytes);
    const secret = bytesToHex(secretBytes);
    const relays = nostrConnectService.pairingRelays(NIP46_PAIRING_RELAYS, targetPubkey);
    const uri = nostrConnectService.buildPairingUri({
      clientPubkey,
      relays,
      secret,
      perms: NIP46_PERMS,
      name: 'Lightning Piggy',
    });
    setNip46Uri(uri);
    // Never log the full URI: it carries `secret=`, a pairing token that
    // could be used to impersonate this app session against the bunker.
    // In dev only, log a secret-redacted copy for debugging.
    if (__DEV__) {
      console.log('[Nostr][NIP46] pairing URI:', uri.replace(/(secret=)[^&]*/i, '$1[redacted]'));
    }
    setMode('nip46-pair');
    setNip46Pairing(true);
    try {
      const { signer, connection } = await nostrConnectService.awaitBunkerPair({
        clientSecretKey,
        clientPubkey,
        relays,
        secret,
        perms: NIP46_PERMS,
        name: 'Lightning Piggy',
        maxWaitSeconds: 120,
        signal: abort.signal,
      });
      // Bail out if the user dismissed the sheet between scan and ack. The
      // service closes the orphaned signer on abort, so nothing to clean up.
      if (abort.signal.aborted) return;
      // Bunker acked — we're now committing to login. Hide Cancel for this
      // window (see nip46Finalizing) so a late tap can't race the login that
      // has already started mutating NostrContext state.
      setNip46Finalizing(true);
      // Adopt the live signer (reuses its open subscription — no second
      // connect round-trip) now that we're committing to the login.
      nostrConnectService.adoptPairedSigner(connection, signer);
      const result = await loginWithNip46(connection);
      if (result.success) {
        setNip46Pairing(false);
        onClose();
      } else {
        // Login failed after adopt — tear down the live subscription so it
        // doesn't linger under a half-logged-in identity.
        await nostrConnectService.setActiveConnection(null).catch(() => {});
        setNip46Pairing(false);
        setError(result.error || t('nostrLoginSheet.nip46LoginFailed'));
        setMode('login');
      }
    } catch (e) {
      if (abort.signal.aborted) return; // user cancelled — silent
      setNip46Pairing(false);
      const msg = e instanceof Error ? e.message : t('nostrLoginSheet.nip46PairingFailed');
      setError(msg.includes('subscription closed') ? t('nostrLoginSheet.nip46TookTooLong') : msg);
      setMode('login');
    } finally {
      nip46AbortRef.current = null;
      setNip46Finalizing(false);
    }
  };

  const handleCancelNip46 = () => {
    if (nip46AbortRef.current) {
      nip46AbortRef.current.abort();
      nip46AbortRef.current = null;
    }
    setNip46Pairing(false);
    setNip46Finalizing(false);
    setNip46Uri(null);
    setMode('login');
  };

  const handleCopyNip46Uri = async () => {
    if (nip46Uri) {
      await Clipboard.setStringAsync(nip46Uri);
      Alert.alert(t('nostrLoginSheet.nip46CopiedTitle'), t('nostrLoginSheet.nip46CopiedMessage'));
    }
  };

  /**
   * Same-device hand-off: open the `nostrconnect://` URI directly in an
   * installed bunker (Clave / Aegis / … all register the scheme), so the user
   * doesn't have to scan the QR or copy-paste. The `awaitBunkerPair` relay
   * subscription keeps running in the background — when the user approves in
   * the bunker and returns, the `connect` ack completes the login. If no app
   * handles the scheme, `openURL` rejects and we point the user at the QR.
   */
  const handleOpenInBunker = async () => {
    if (!nip46Uri) return;
    try {
      await Linking.openURL(nip46Uri);
    } catch {
      setError(t('nostrLoginSheet.nip46NoBunker'));
    }
  };

  return (
    <BottomSheetModal
      ref={sheetRef}
      onDismiss={onClose}
      backdropComponent={renderBackdrop}
      backgroundStyle={styles.sheetBackground}
      handleIndicatorStyle={styles.handleIndicator}
      keyboardBehavior="interactive"
      keyboardBlurBehavior="restore"
      android_keyboardInputMode="adjustResize"
    >
      <BottomSheetScrollView
        ref={scrollRef}
        style={styles.content}
        contentContainerStyle={{ paddingBottom: keyboardHeight > 0 ? keyboardHeight + 80 : 40 }}
        keyboardShouldPersistTaps="handled"
      >
        {mode === 'login' && (
          <>
            <Text style={styles.title}>{t('nostrLoginSheet.connectTitle')}</Text>
            <Text style={styles.subtitle}>{t('nostrLoginSheet.connectSubtitle')}</Text>

            <View style={styles.inputRow}>
              <BottomSheetTextInput
                style={styles.input}
                placeholder="nsec1..."
                placeholderTextColor={colors.textSupplementary}
                value={nsecInput}
                onChangeText={(text) => {
                  setNsecInput(text);
                  setError(null);
                }}
                autoCapitalize="none"
                autoCorrect={false}
                secureTextEntry
                editable={!isLoggingIn}
                accessibilityLabel={t('nostrLoginSheet.nsecInputLabel')}
                testID="nsec-input"
              />
              <TouchableOpacity
                accessibilityRole="button"
                style={styles.pasteButton}
                onPress={handlePaste}
                accessibilityLabel={t('nostrLoginSheet.paste')}
                testID="paste-nsec"
              >
                <Svg width={18} height={18} viewBox="0 0 24 24" fill="none">
                  <Path
                    d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"
                    stroke={colors.textSupplementary}
                    strokeWidth={2}
                    strokeLinecap="round"
                  />
                  <Path
                    d="M15 2H9a1 1 0 0 0-1 1v2a1 1 0 0 0 1 1h6a1 1 0 0 0 1-1V3a1 1 0 0 0-1-1Z"
                    stroke={colors.textSupplementary}
                    strokeWidth={2}
                  />
                </Svg>
              </TouchableOpacity>
            </View>

            {error && <Text style={styles.error}>{error}</Text>}

            <TouchableOpacity
              accessibilityRole="button"
              accessibilityState={{ disabled: !nsecInput.trim() || isLoggingIn, busy: isLoggingIn }}
              style={[styles.loginButton, (!nsecInput.trim() || isLoggingIn) && styles.disabled]}
              onPress={handleLogin}
              disabled={!nsecInput.trim() || isLoggingIn}
              accessibilityLabel={t('nostrLoginSheet.login')}
              testID="login-button"
            >
              {isLoggingIn ? (
                <BrandedSpinner onGradient />
              ) : (
                <Text style={styles.loginButtonText}>{t('nostrLoginSheet.login')}</Text>
              )}
            </TouchableOpacity>

            {Platform.OS === 'android' && (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityState={{ disabled: isLoggingIn }}
                style={styles.amberButton}
                onPress={handleAmber}
                disabled={isLoggingIn}
                accessibilityLabel={t('nostrLoginSheet.useAmber')}
                testID="amber-button"
              >
                <Text style={styles.amberButtonText}>{t('nostrLoginSheet.useAmber')}</Text>
              </TouchableOpacity>
            )}

            {/* NIP-46 ("Nostr Connect") — cross-platform signer button.
                Visible on every platform (iOS users have no Amber
                option, NIP-46 is their only hardware-isolated route;
                Android users get NIP-46 as an alternative when their
                bunker isn't installed locally — useful for the
                nsec.app web bunker etc). See issue #283. */}
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityState={{ disabled: isLoggingIn }}
              style={styles.amberButton}
              onPress={() => handleNip46()}
              disabled={isLoggingIn}
              accessibilityLabel={t('nostrLoginSheet.useNip46A11y')}
              testID="nip46-button"
            >
              <Text style={styles.amberButtonText}>
                {Platform.OS === 'ios'
                  ? t('nostrLoginSheet.useNip46Ios')
                  : t('nostrLoginSheet.useNip46Android')}
              </Text>
            </TouchableOpacity>

            {isTestRelayLockdown(TEST_ACCOUNT_KEYS.little) && (
              <TouchableOpacity
                accessibilityRole="button"
                accessibilityState={{ disabled: isLoggingIn }}
                style={styles.amberButton}
                onPress={() => handleNip46(TEST_ACCOUNT_KEYS.little)}
                disabled={isLoggingIn}
                accessibilityLabel={t('nostrScreen.testRelayLockdown', { url: TEST_RELAY_URL })}
                testID="nip46-test-account-button"
              >
                <Text style={styles.amberButtonText}>{t('nostrLoginSheet.useNip46A11y')}</Text>
                <Text style={styles.amberButtonText}>
                  {t('nostrScreen.testRelayLockdown', { url: TEST_RELAY_URL })}
                </Text>
              </TouchableOpacity>
            )}

            <View style={styles.dividerRow}>
              <View style={styles.dividerLine} />
              <Text style={styles.dividerText}>{t('nostrLoginSheet.or')}</Text>
              <View style={styles.dividerLine} />
            </View>

            <TouchableOpacity
              accessibilityRole="button"
              style={styles.createButton}
              onPress={handleCreate}
              accessibilityLabel={t('nostrLoginSheet.createAccount')}
              testID="create-account-button"
            >
              <Text style={styles.createButtonText}>{t('nostrLoginSheet.createAccount')}</Text>
            </TouchableOpacity>
          </>
        )}

        {mode === 'create' && (
          <>
            <Text style={styles.title}>{t('nostrLoginSheet.createAccountTitle')}</Text>
            <Text style={styles.subtitle}>{t('nostrLoginSheet.createAccountSubtitle')}</Text>
            <Text style={styles.safetyTip}>{t('nostrLoginSheet.safetyTip')}</Text>

            <Text style={styles.fieldLabel}>{t('nostrLoginSheet.displayName')}</Text>
            <BottomSheetTextInput
              style={styles.createInput}
              placeholder={t('nostrLoginSheet.yourName')}
              placeholderTextColor={colors.textSupplementary}
              value={newName}
              onChangeText={(text) => {
                setNewName(text);
                setError(null);
              }}
              autoCapitalize="words"
              autoCorrect={false}
              accessibilityLabel={t('nostrLoginSheet.displayName')}
              testID="create-name-input"
            />

            {error && <Text style={styles.error}>{error}</Text>}

            <TouchableOpacity
              accessibilityRole="button"
              accessibilityState={{ disabled: creating, busy: creating }}
              style={[styles.loginButton, creating && styles.disabled]}
              onPress={handleFinishCreate}
              disabled={creating}
              accessibilityLabel={t('nostrLoginSheet.createAccountTitle')}
              testID="create-account-submit"
            >
              {creating ? (
                <BrandedSpinner onGradient />
              ) : (
                <Text style={styles.loginButtonText}>
                  {t('nostrLoginSheet.createAccountTitle')}
                </Text>
              )}
            </TouchableOpacity>

            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel={t('nostrLoginSheet.backToLogin')}
              testID="nostr-back-to-login"
              style={styles.backLink}
              onPress={() => setMode('login')}
            >
              <Text style={styles.backLinkText}>{t('nostrLoginSheet.backToLogin')}</Text>
            </TouchableOpacity>
          </>
        )}

        {mode === 'nip46-pair' && (
          <>
            <Text style={styles.title}>{t('nostrLoginSheet.nip46Title')}</Text>
            <Text style={styles.subtitle}>
              {Platform.OS === 'ios'
                ? t('nostrLoginSheet.nip46SubtitleIos')
                : t('nostrLoginSheet.nip46SubtitleAndroid')}
            </Text>

            {/* Black-on-white QR for max scan reliability across themes
                — same rationale as QrSheet.tsx's qrContainer. */}
            <View style={styles.nip46QrContainer}>
              {nip46Uri ? (
                <QRCode value={nip46Uri} size={220} backgroundColor="#FFFFFF" color="#000000" />
              ) : null}
            </View>

            {(nip46Pairing || nip46Finalizing) && (
              <View style={styles.nip46WaitingRow}>
                <BrandedSpinner />
                <Text style={styles.nip46WaitingText}>
                  {nip46Finalizing
                    ? t('nostrLoginSheet.nip46Finalizing')
                    : t('nostrLoginSheet.nip46Waiting')}
                </Text>
              </View>
            )}

            {error && <Text style={styles.error}>{error}</Text>}

            {/* Once the bunker has acked we're committing to login — hide the
                pairing actions (Open / Copy / Cancel) so a late tap can't race
                the finalizing login (Copilot review). */}
            {!nip46Finalizing && (
              <>
                {/* Same-device primary action: hand the URI straight to an
                    installed bunker via its nostrconnect:// scheme. QR (cross-
                    device) + Copy (web bunkers like nsec.app) remain below. */}
                <TouchableOpacity
                  accessibilityRole="button"
                  style={styles.loginButton}
                  onPress={handleOpenInBunker}
                  accessibilityLabel={t('nostrLoginSheet.nip46OpenBunker')}
                  testID="open-nip46-bunker"
                >
                  <Text style={styles.loginButtonText}>{t('nostrLoginSheet.nip46OpenBunker')}</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  accessibilityRole="button"
                  style={styles.copyButton}
                  onPress={handleCopyNip46Uri}
                  accessibilityLabel={t('nostrLoginSheet.nip46CopyUri')}
                  testID="copy-nip46-uri"
                >
                  <Text style={styles.copyButtonText}>{t('nostrLoginSheet.nip46CopyUri')}</Text>
                </TouchableOpacity>

                <TouchableOpacity
                  accessibilityRole="button"
                  style={styles.backLink}
                  onPress={handleCancelNip46}
                  accessibilityLabel={t('nostrLoginSheet.nip46CancelA11y')}
                  testID="cancel-nip46"
                >
                  <Text style={styles.backLinkText}>{t('nostrLoginSheet.nip46Cancel')}</Text>
                </TouchableOpacity>
              </>
            )}
          </>
        )}

        {mode === 'backup' && (
          <>
            <Text style={styles.title}>{t('nostrLoginSheet.backupTitle')}</Text>
            <Text style={styles.warningText}>{t('nostrLoginSheet.backupWarning')}</Text>

            <Text style={styles.fieldLabel}>{t('nostrLoginSheet.privateKeyLabel')}</Text>
            <View style={styles.nsecDisplay}>
              <Text style={styles.nsecText} selectable>
                {generatedNsec}
              </Text>
            </View>

            <TouchableOpacity
              accessibilityRole="button"
              style={styles.copyButton}
              onPress={handleCopyNsec}
              accessibilityLabel={t('nostrLoginSheet.copyPrivateKey')}
              testID="copy-nsec"
            >
              <Text style={styles.copyButtonText}>{t('nostrLoginSheet.copyToClipboard')}</Text>
            </TouchableOpacity>

            <TouchableOpacity
              accessibilityRole="button"
              style={styles.loginButton}
              onPress={handleDone}
              accessibilityLabel={t('nostrLoginSheet.done')}
              testID="backup-done"
            >
              <Text style={styles.loginButtonText}>{t('nostrLoginSheet.savedMyKey')}</Text>
            </TouchableOpacity>
          </>
        )}
      </BottomSheetScrollView>
    </BottomSheetModal>
  );
};

export default NostrLoginSheet;
