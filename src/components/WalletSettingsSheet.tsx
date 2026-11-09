import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  Platform,
  Keyboard,
  useWindowDimensions,
} from 'react-native';
import { Alert } from './BrandedAlert';
import {
  BottomSheetBackdrop,
  BottomSheetScrollView,
  type BottomSheetBackdropProps,
} from '@gorhom/bottom-sheet';
import { BottomSheetModal } from './AccessibleBottomSheetModal';
import * as Clipboard from 'expo-clipboard';
import { useWallet } from '../contexts/WalletContext';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import type { CardTheme } from '../types/wallet';
import { cardThemes, defaultCardThemeFor } from '../themes/cardThemes';
import {
  getXpub,
  getNwcUrl,
  getCoinosRecovery,
  type CoinosRecoveryInfo,
} from '../services/walletStorageService';
import { createWalletSettingsSheetStyles } from '../styles/WalletSettingsSheet.styles';
import SettingsRow from './SettingsRow';
import { Trash2 } from 'lucide-react-native';
import WalletDesignTab from './WalletDesignTab';
import WalletDetailsTab from './WalletDetailsTab';
import WalletConnectionTab from './WalletConnectionTab';
import FriendPickerSheet from './FriendPickerSheet';
import { useWalletShareFromSettings } from '../hooks/useWalletShareFromSettings';
import { useRemoveWalletConfirm } from '../hooks/useRemoveWalletConfirm';

export type SettingsTab = 'design' | 'details' | 'connection';

interface Props {
  walletId: string | null;
  onClose: () => void;
  /** Tab to open on (default Design). */
  initialTab?: SettingsTab;
}

const WalletSettingsSheet: React.FC<Props> = ({ walletId, onClose, initialTab = 'design' }) => {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createWalletSettingsSheetStyles(colors), [colors]);
  const { wallets, updateWalletSettings, removeWallet } = useWallet();
  const wallet = wallets.find((w) => w.id === walletId);
  // "Share this wallet" flow (NWC only). Reuses #988's gift-wrapped NWC-share
  // send + redaction; adds a recipient-pick step since settings has no open
  // conversation. See useWalletShareFromSettings.
  const { pickerOpen, startShare, closePicker, shareToFriend } = useWalletShareFromSettings(wallet);
  const bottomSheetRef = useRef<BottomSheetModal>(null);
  const { height: windowHeight } = useWindowDimensions();
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  // Content-height snap point, measured per tab. gorhom's own
  // `enableDynamicSizing` can't size this sheet — its scroll view reports no
  // intrinsic height, so the sheet collapses to header+footer and squashes the
  // content. Instead we measure the header, the active tab's scroll content and
  // the footer, sum them (+ handle + a little slack), clamp between a sensible
  // floor and 92% of the screen, and drive a single pixel snap point. The sheet
  // then animates to fit whichever tab is showing. `enableDynamicSizing` stays
  // OFF, which also avoids the v5 "collapses to a strip when a
  // BottomSheetTextInput is focused" bug (see docs/TROUBLESHOOTING.adoc).
  const [headerHeight, setHeaderHeight] = useState(0);
  const [footerHeight, setFooterHeight] = useState(0);
  const [contentHeight, setContentHeight] = useState(0);
  const snapPoints = useMemo(() => {
    const floor = windowHeight * 0.4;
    const ceiling = windowHeight * 0.92;
    // Only trust the measured height once ALL three parts have laid out —
    // otherwise header/content/footer are still 0 and the `+ 24` slack alone
    // would make it look "measured" and snap to the 40% floor, then jump when
    // the real sizes arrive. Until then, open at the generous ceiling and let
    // it settle DOWN to content (smoother than growing up from a thin strip).
    const allMeasured = headerHeight > 0 && contentHeight > 0 && footerHeight > 0;
    const target = allMeasured
      ? Math.min(ceiling, Math.max(floor, headerHeight + contentHeight + footerHeight + 24))
      : ceiling;
    return [Math.round(target)];
  }, [headerHeight, contentHeight, footerHeight, windowHeight]);

  // Active tab of the segmented control. Defaults to Design — the
  // cover-flow card picker is the showcase surface of this redesign.
  const [activeTab, setActiveTab] = useState<SettingsTab>(initialTab);

  // Canonical keyboard-height tracking — mirrors SendSheet / NostrLoginSheet.
  // Rule 5 of docs/TROUBLESHOOTING.adoc "Bottom sheet doesn't slide up…".
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const showSub = Keyboard.addListener(showEvent, (e) => {
      setKeyboardHeight(e.endCoordinates.height);
    });
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));
    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  const [alias, setAlias] = useState('');
  const [lnAddress, setLnAddress] = useState('');
  const [selectedTheme, setSelectedTheme] = useState<CardTheme>(defaultCardThemeFor('nwc'));
  // `undefined` = on-chain load in progress; `null` = not applicable / loaded
  // but absent; `string` = loaded xpub ready to display.
  const [xpubDisplay, setXpubDisplay] = useState<string | null | undefined>(null);
  const [relayUrl, setRelayUrl] = useState<string | null>(null);
  // CoinOS managed-wallet recovery info (#287). Loaded eagerly when
  // the sheet opens so we can render the username inline and surface a
  // masked password row with a copy button. Null = either not a CoinOS
  // wallet or SecureStore had no record.
  const [coinosRecovery, setCoinosRecovery] = useState<CoinosRecoveryInfo | null>(null);
  // Eye-toggle for the password row in the CoinOS recovery callout —
  // defaults hidden so a password isn't on-screen by default when
  // the user opens settings near a colleague / camera.
  const [passwordRevealed, setPasswordRevealed] = useState(false);
  // Full NWC connection string. Surfaced for every NWC wallet (#588 —
  // not just CoinOS) so users can copy it back out and move the
  // wallet to another device / NWC client without losing access.
  // Hidden behind dots + eye toggle by default since the secret in
  // the URL grants wallet access; a QR overlay is also available.
  const [nwcConnection, setNwcConnection] = useState<string | null>(null);
  const [nwcRevealed, setNwcRevealed] = useState(false);
  const [nwcQrShown, setNwcQrShown] = useState(false);
  // Surface a non-fatal error if something prevents us from rendering
  // the recovery callout fully. Currently always null (no failure path sets
  // it yet) — a plain const rather than unused state; promote to `useState`
  // when a setter is actually needed.
  const recoveryError: string | null = null;

  // Populate fields ONCE when the sheet opens for a given walletId. Using
  // `wallet` as a dep would re-fire on every `wallets` array update (balance
  // polls, NWC reconnect pings, etc.), each time stomping the user's in-
  // progress edits with the stored value — symptom: typing into Lightning
  // Address makes characters disappear.
  // Reset to the opening tab when the sheet opens for a different wallet — keyed
  // ONLY on walletId (not `wallet?.id`), so it fires once per open and can't
  // re-fire when the wallet hydrates a moment later and stomp a fast tab tap.
  useEffect(() => {
    setActiveTab(initialTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletId]);

  useEffect(() => {
    // Cancellation flag so a fast wallet-switch / sheet dismiss
    // doesn't leak the previous wallet's CoinOS recovery / NWC string
    // after the new wallet is active. Each .then() bails when
    // cancelled is true.
    let cancelled = false;

    // Eager-clear all secret-bearing state on every walletId change —
    // covers wallet switch, sheet close, on-chain branch. Without
    // this the previous wallet's CoinOS username/password callout
    // or NWC connection string would briefly remain visible while
    // the new wallet's getCoinosRecovery / getNwcUrl promises were
    // still in-flight (privacy leak).
    setRelayUrl(null);
    setNwcConnection(null);
    setNwcRevealed(false);
    setNwcQrShown(false);
    setCoinosRecovery(null);
    setPasswordRevealed(false);

    if (wallet) {
      setAlias(wallet.alias);
      setLnAddress(wallet.lightningAddress ?? '');
      // Fall back per wallet type when the stored theme is missing or a
      // stale/unknown id (on-chain → Bitcoin, Lightning/NWC → Lightning Piggy).
      setSelectedTheme(
        cardThemes[wallet.theme] ? wallet.theme : defaultCardThemeFor(wallet.walletType),
      );

      // Load xpub for on-chain wallets. Set to `undefined` (loading) before the
      // async call so switching between two on-chain wallets never shows the
      // previous wallet's xpub while the new one is resolving — the Connection
      // tab will show a loading placeholder instead of stale data.
      if (wallet.walletType === 'onchain' && walletId) {
        setXpubDisplay(undefined);
        getXpub(walletId).then((xpub) => {
          if (cancelled) return;
          setXpubDisplay(xpub);
        });
      } else if (wallet.walletType === 'nwc' && walletId) {
        setXpubDisplay(null);
        // Extract relay URL from NWC connection string. Also stash
        // the full NWC string so:
        // - every NWC wallet's settings can surface a copyable +
        //   QR-able NWC row (#588)
        // - the CoinOS recovery callout (#287) can surface it
        //   alongside the username/password for managed wallets.
        getNwcUrl(walletId).then((url) => {
          if (cancelled) return;
          setNwcConnection(url);
          if (url) {
            try {
              const params = new URLSearchParams(url.split('?')[1] || '');
              setRelayUrl(params.get('relay'));
            } catch {
              setRelayUrl(null);
            }
          }
        });
        // CoinOS managed-wallet recovery info. Held in JS state for
        // the sheet's lifetime so we can render the username inline +
        // a masked password row. The password is never logged or
        // serialised — it only travels from SecureStore → state →
        // Clipboard.setStringAsync when the user explicitly taps copy.
        getCoinosRecovery(walletId).then((rec) => {
          if (cancelled) return;
          setCoinosRecovery(rec);
        });
      } else {
        setXpubDisplay(null);
      }
    } else {
      setXpubDisplay(null);
    }

    return () => {
      cancelled = true;
    };
    // Depend on `wallet?.id` (not the whole `wallet` object) as well as
    // `walletId`: this re-runs once if the sheet mounts with `walletId`
    // set before `wallet` has hydrated into the array (so the fields
    // populate when it arrives), yet stays stable across balance-poll /
    // NWC-reconnect updates that replace the wallet object but keep its
    // id — so it never stomps the user's in-progress edits.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [walletId, wallet?.id]);

  const handleSheetChange = useCallback(
    (index: number) => {
      if (index === -1) onClose();
    },
    [onClose],
  );

  const renderBackdrop = useCallback(
    (props: BottomSheetBackdropProps) => (
      <BottomSheetBackdrop {...props} disappearsOnIndex={-1} appearsOnIndex={0} />
    ),
    [],
  );

  // Present/dismiss keyed on whether a wallet EXISTS, not the `wallet` object
  // itself — the object identity changes on every balance poll / reconnect ping,
  // and depending on it would re-run this effect (calling present() again) on
  // every such update. A boolean only flips when the wallet appears/disappears.
  const hasWallet = !!wallet;
  useEffect(() => {
    if (walletId && hasWallet) {
      bottomSheetRef.current?.present();
    } else {
      bottomSheetRef.current?.dismiss();
    }
  }, [walletId, hasWallet]);

  const handleSave = useCallback(async () => {
    if (!walletId || !wallet) return;
    await updateWalletSettings(walletId, {
      alias: alias.trim() || wallet.alias,
      theme: selectedTheme,
      lightningAddress: lnAddress.trim() || null,
    });
    onClose();
  }, [walletId, wallet, alias, selectedTheme, lnAddress, updateWalletSettings, onClose]);

  const handleCopyXpub = useCallback(async () => {
    if (xpubDisplay) {
      await Clipboard.setStringAsync(xpubDisplay);
      Alert.alert(t('walletSettingsSheet.copiedTitle'), t('walletSettingsSheet.xpubCopied'));
    }
  }, [xpubDisplay, t]);

  // Switch tabs, re-masking any credential revealed on the Connection tab
  // when the user navigates away — so a revealed NWC string / CoinOS
  // password / QR doesn't linger on-screen after leaving the tab that
  // shows it (privacy; a returning user has to re-reveal deliberately).
  const selectTab = useCallback((tab: SettingsTab) => {
    setActiveTab((prev) => {
      if (prev === 'connection' && tab !== 'connection') {
        setNwcRevealed(false);
        setPasswordRevealed(false);
        setNwcQrShown(false);
      }
      return tab;
    });
  }, []);

  const confirmRemoveWallet = useRemoveWalletConfirm();
  const handleDisconnect = useCallback(() => {
    if (!walletId || !wallet) return;
    void confirmRemoveWallet({
      wallet,
      title: t('walletSettingsSheet.removeWalletTitle'),
      fallbackMessage:
        wallet.walletType === 'onchain'
          ? t('walletSettingsSheet.removeConfirmMessage', { alias: wallet.alias })
          : t('walletSettingsSheet.disconnectConfirmMessage', { alias: wallet.alias }),
      onConfirm: async () => {
        await removeWallet(walletId);
        onClose();
      },
      // The CoinOS login is shown on the Connection tab of this sheet.
      onViewRecovery: () => selectTab('connection'),
    });
  }, [walletId, wallet, t, removeWallet, onClose, confirmRemoveWallet, selectTab]);

  if (!walletId || !wallet) return null;

  const tabs: { key: SettingsTab; label: string }[] = [
    { key: 'design', label: t('walletSettingsSheet.tabDesign') },
    { key: 'details', label: t('walletSettingsSheet.tabDetails') },
    { key: 'connection', label: t('walletSettingsSheet.tabConnection') },
  ];

  return (
    <>
      <BottomSheetModal
        ref={bottomSheetRef}
        snapPoints={snapPoints}
        // Sized via the measured `snapPoints` above, not gorhom's dynamic sizing
        // (which collapses a header+scroll+footer sheet). Keep it off — it also
        // triggers the v5 text-input-focus collapse bug.
        enableDynamicSizing={false}
        enablePanDownToClose
        onChange={handleSheetChange}
        backdropComponent={renderBackdrop}
        backgroundStyle={styles.sheetBackground}
        handleIndicatorStyle={styles.handle}
        keyboardBehavior="interactive"
        keyboardBlurBehavior="restore"
        android_keyboardInputMode="adjustResize"
      >
        {/* Fixed header: title + segmented control. Kept outside the scroll
          view so the tab switcher stays put while the active tab scrolls. */}
        <View style={styles.header} onLayout={(e) => setHeaderHeight(e.nativeEvent.layout.height)}>
          <Text style={styles.title} testID="wallet-settings-title">
            {t('walletSettingsSheet.title')}
          </Text>
          <View style={styles.segmentedControl} accessibilityRole="tablist">
            {tabs.map(({ key, label }) => {
              const active = activeTab === key;
              return (
                <TouchableOpacity
                  key={key}
                  style={[styles.segment, active && styles.segmentActive]}
                  onPress={() => selectTab(key)}
                  accessibilityRole="tab"
                  accessibilityState={{ selected: active }}
                  accessibilityLabel={label}
                  testID={`wallet-settings-tab-${key}`}
                >
                  <Text style={[styles.segmentText, active && styles.segmentTextActive]}>
                    {label}
                  </Text>
                </TouchableOpacity>
              );
            })}
          </View>
        </View>

        <BottomSheetScrollView
          contentContainerStyle={[
            styles.content,
            { paddingBottom: keyboardHeight > 0 ? keyboardHeight + 80 : 24 },
          ]}
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={(_w: number, h: number) => setContentHeight(h)}
        >
          {activeTab === 'design' && (
            <WalletDesignTab
              styles={styles}
              t={t}
              selectedTheme={selectedTheme}
              onSelectTheme={setSelectedTheme}
              onSave={handleSave}
            />
          )}

          {activeTab === 'details' && (
            <WalletDetailsTab
              styles={styles}
              colors={colors}
              t={t}
              walletType={wallet.walletType}
              alias={alias}
              onChangeAlias={setAlias}
              lnAddress={lnAddress}
              onChangeLnAddress={setLnAddress}
              onSave={handleSave}
            />
          )}

          {activeTab === 'connection' && (
            <WalletConnectionTab
              styles={styles}
              colors={colors}
              t={t}
              walletType={wallet.walletType}
              xpubDisplay={xpubDisplay}
              onCopyXpub={handleCopyXpub}
              relayUrl={relayUrl}
              nwcConnection={nwcConnection}
              nwcRevealed={nwcRevealed}
              onToggleNwcRevealed={() => setNwcRevealed((v) => !v)}
              nwcQrShown={nwcQrShown}
              onToggleNwcQr={() => setNwcQrShown((v) => !v)}
              coinosRecovery={coinosRecovery}
              passwordRevealed={passwordRevealed}
              onTogglePasswordRevealed={() => setPasswordRevealed((v) => !v)}
              recoveryError={recoveryError}
              onShare={startShare}
            />
          )}
        </BottomSheetScrollView>

        {/* Fixed footer: Remove stays outside the tabs, always visible. */}
        <View style={styles.footer} onLayout={(e) => setFooterHeight(e.nativeEvent.layout.height)}>
          <SettingsRow
            kind="action"
            appearance="surface"
            icon={Trash2}
            title={t('walletSettingsSheet.removeWalletTitle')}
            testID="wallet-settings-remove"
            onPress={handleDisconnect}
            destructive
          />
        </View>
      </BottomSheetModal>

      {/* Recipient step for "Share this wallet" — settings has no open
          conversation, so pick who to send the gift-wrapped NWC share to.
          Reuses the app's contact picker; onSelect runs the same send. */}
      <FriendPickerSheet
        visible={pickerOpen}
        onClose={closePicker}
        onSelect={shareToFriend}
        title={t('walletSettingsSheet.shareWalletPickTitle')}
      />
    </>
  );
};

export default WalletSettingsSheet;
