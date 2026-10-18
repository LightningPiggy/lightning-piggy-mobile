import BrandedSpinner from './BrandedSpinner';
import React, { useCallback, useMemo, useState } from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createSharedAccountStyles } from '../screens/account/sharedStyles';
import {
  createPublishedRelayListsSectionStyles,
  type PublishedRelayListsSectionStyles,
} from '../styles/PublishedRelayListsSection.styles';
import { useRelayListDraft } from '../contexts/RelayListEditorContext';
import { useRelayReachability } from '../hooks/useRelayReachability';
import RelaySettingsRow from './RelaySettingsRow';
import { useNavigation } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RelaySettingsParamList } from '../navigation/types';

import { useNostr } from '../contexts/NostrContext';
import NetworkSectionHeading from './NetworkSectionHeading';
import RelayPublishSheet from './RelayPublishSheet';
import { useRelayPublishSheet } from '../hooks/useRelayPublishSheet';

type T = ReturnType<typeof useTranslation>;

/** URL input + Add button; reports invalid (non-public) URLs inline. */
function AddRelayInput({
  onAdd,
  editable,
  testIDPrefix,
  styles,
  t,
}: {
  onAdd: (url: string) => boolean;
  editable: boolean;
  testIDPrefix: string;
  styles: PublishedRelayListsSectionStyles;
  t: T;
}) {
  const colors = useThemeColors();
  const shared = useMemo(() => createSharedAccountStyles(colors), [colors]);
  const [value, setValue] = useState('');
  const [error, setError] = useState(false);
  const submit = () => {
    if (!value.trim()) return;
    if (onAdd(value)) {
      setValue('');
      setError(false);
    } else setError(true);
  };
  return (
    <>
      <View style={styles.addRow}>
        <TextInput
          style={[shared.textInput, styles.addInput]}
          value={value}
          onChangeText={(v) => {
            setValue(v);
            if (error) setError(false);
          }}
          placeholder="wss://relay.example.com"
          placeholderTextColor="rgba(0,0,0,0.3)"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          onSubmitEditing={submit}
          editable={editable}
          testID={`${testIDPrefix}-add-input`}
          accessibilityLabel={t('publishedRelays.addUrlLabel')}
        />
        <TouchableOpacity
          style={[styles.addButton, !editable && styles.publishButtonDisabled]}
          onPress={submit}
          disabled={!editable}
          testID={`${testIDPrefix}-add-button`}
          accessibilityState={{ disabled: !editable }}
          accessibilityRole="button"
          accessibilityLabel={t('publishedRelays.addLabel')}
        >
          <Text style={styles.addButtonText}>{t('publishedRelays.add')}</Text>
        </TouchableOpacity>
      </View>
      {error && (
        <Text
          style={[shared.fieldHint, { color: colors.brandPink }]}
          testID={`${testIDPrefix}-add-error`}
        >
          {t('publishedRelays.invalidUrl')}
        </Text>
      )}
    </>
  );
}

function PublishButton({
  onPress,
  disabled,
  busy,
  testID,
  styles,
  t,
}: {
  onPress: () => void;
  disabled: boolean;
  busy: boolean;
  testID: string;
  styles: PublishedRelayListsSectionStyles;
  t: T;
}) {
  return (
    <TouchableOpacity
      style={[styles.publishButton, (disabled || busy) && styles.publishButtonDisabled]}
      onPress={onPress}
      disabled={disabled || busy}
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled: disabled || busy, busy }}
      accessibilityLabel={t('publishedRelays.publish')}
    >
      {busy ? (
        <BrandedSpinner />
      ) : (
        <Text style={styles.publishButtonText}>{t('publishedRelays.publish')}</Text>
      )}
    </TouchableOpacity>
  );
}

/**
 * Edit and publish the user's PUBLIC relay lists — NIP-65 (where other apps
 * read/write their posts) and the NIP-17 DM inbox (where others send DMs).
 * Unlike the in-app relay overrides above it, these are signed and published.
 */
export default function PublishedRelayListsSection({
  connection,
}: {
  /** Live pool membership by relay URL, for the In use chips. */
  connection?: Map<string, boolean>;
}) {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createPublishedRelayListsSectionStyles(colors), [colors]);
  const editor = useRelayListDraft();
  const reachability = useRelayReachability([
    ...editor.nip65Draft.map((r) => r.url),
    ...editor.inboxDraft,
  ]);
  const { pubkey } = useNostr();
  const publishSheet = useRelayPublishSheet(pubkey);
  const navigation = useNavigation<NativeStackNavigationProp<RelaySettingsParamList>>();
  const openRelay = useCallback(
    (url: string, kind: 'nip65' | 'inbox') => {
      navigation.navigate('RelayDetails', { url, kind });
    },
    [navigation],
  );

  const publish = (which: 'nip65' | 'inbox') => {
    void publishSheet.run(
      t('relayPublishSheet.title', {
        title: t(which === 'nip65' ? 'publishedRelays.nip65Title' : 'publishedRelays.inboxTitle'),
      }),
      which === 'nip65' ? editor.publishNip65 : editor.publishInbox,
      'publishedRelays',
    );
  };

  return (
    <View testID="published-relay-lists">
      <NetworkSectionHeading
        title={t('publishedRelays.nip65Title')}
        explanation={`${t('networkInfo.nip65Hint')}\n\n${t('relayReachability.explanation')}`}
        testID="nip65"
        spec="https://github.com/nostr-protocol/nips/blob/master/65.md"
      />
      <RelayPublishSheet state={publishSheet} />
      <View style={styles.list} testID="nip65-relay-list">
        {editor.nip65Loading ? (
          <BrandedSpinner style={{ paddingVertical: 10 }} testID="nip65-loading" />
        ) : (
          editor.nip65Draft.length === 0 && (
            <Text style={styles.empty}>{t('publishedRelays.nip65Empty')}</Text>
          )
        )}
        {editor.nip65Draft.map((r, index) => (
          <RelaySettingsRow
            key={r.url}
            url={r.url}
            read={r.read}
            write={r.write}
            status={reachability.get(r.url)?.reachable}
            inUse={connection?.get(r.url) === true}
            probeIndex={index}
            onOpen={openRelay}
            onRemove={editor.removeNip65}
            removeDisabled={!editor.nip65Editable}
            removeTestID={`relay-row-remove-nip65-${index}`}
          />
        ))}
      </View>
      <AddRelayInput
        onAdd={editor.addNip65}
        editable={editor.nip65Editable}
        testIDPrefix="nip65"
        styles={styles}
        t={t}
      />

      <PublishButton
        onPress={() => publish('nip65')}
        disabled={editor.nip65Loading || editor.nip65Draft.length === 0}
        busy={editor.publishing === 'nip65'}
        testID="nip65-publish"
        styles={styles}
        t={t}
      />

      <NetworkSectionHeading
        title={t('publishedRelays.inboxTitle')}
        explanation={`${t('networkInfo.inboxHint')}\n\n${t('relayReachability.explanation')}`}
        testID="inbox"
        spec="https://github.com/nostr-protocol/nips/blob/master/17.md"
      />
      <View style={styles.list} testID="inbox-relay-list">
        {editor.inboxLoading ? (
          <BrandedSpinner style={{ paddingVertical: 10 }} />
        ) : (
          editor.inboxDraft.length === 0 && (
            <Text style={styles.empty}>{t('publishedRelays.inboxEmpty')}</Text>
          )
        )}
        {editor.inboxDraft.map((url, index) => (
          <RelaySettingsRow
            key={url}
            url={url}
            inbox
            status={reachability.get(url)?.reachable}
            inUse={connection?.get(url) === true}
            probeIndex={editor.nip65Draft.length + index}
            onOpen={openRelay}
            onRemove={editor.removeInbox}
            removeDisabled={!editor.inboxEditable}
            removeTestID={`relay-row-remove-inbox-${index}`}
          />
        ))}
      </View>
      <AddRelayInput
        onAdd={editor.addInbox}
        editable={editor.inboxEditable}
        testIDPrefix="inbox"
        styles={styles}
        t={t}
      />

      <PublishButton
        onPress={() => publish('inbox')}
        disabled={editor.inboxLoading || editor.inboxDraft.length === 0}
        busy={editor.publishing === 'inbox'}
        testID="inbox-publish"
        styles={styles}
        t={t}
      />
    </View>
  );
}
