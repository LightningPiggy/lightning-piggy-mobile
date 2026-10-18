import BrandedSpinner from './BrandedSpinner';
import React, { useMemo, useState } from 'react';
import { Text, TextInput, TouchableOpacity, View } from 'react-native';
import { Trash2 } from 'lucide-react-native';
import { useThemeColors } from '../contexts/ThemeContext';
import { useTranslation } from '../contexts/LocaleContext';
import { createSharedAccountStyles } from '../screens/account/sharedStyles';
import { createPublishedRelayListsSectionStyles } from '../styles/PublishedRelayListsSection.styles';
import { createBlossomServersSectionStyles } from '../styles/BlossomServersSection.styles';
import NetworkSectionHeading from './NetworkSectionHeading';
import RelayPublishSheet from './RelayPublishSheet';
import { useRelayPublishSheet } from '../hooks/useRelayPublishSheet';
import { useNostr } from '../contexts/NostrContext';
import RelayStatusDot from './RelayStatusDot';
import { relayRowHost } from '../utils/relayDetails';
import { useRelayReachability } from '../hooks/useRelayReachability';
import { useBlossomServerList } from '../hooks/useBlossomServerList';

/**
 * Image servers (Blossom, #1149): the primary stores uploads; backups get a
 * mirrored copy so media survives one server going down.
 */
export default function BlossomServersSection() {
  const colors = useThemeColors();
  const t = useTranslation();
  const shared = useMemo(() => createSharedAccountStyles(colors), [colors]);
  const list = useMemo(() => createPublishedRelayListsSectionStyles(colors), [colors]);
  const styles = useMemo(() => createBlossomServersSectionStyles(colors), [colors]);
  const { servers, dirty, publishing, editable, addServer, removeServer, makePrimary, publish } =
    useBlossomServerList();
  const reachability = useRelayReachability(servers, 'blossom');
  const { pubkey } = useNostr();
  const publishSheet = useRelayPublishSheet(pubkey);
  const [input, setInput] = useState('');
  const [error, setError] = useState(false);

  const submit = () => {
    if (!input.trim()) return;
    if (addServer(input)) {
      setInput('');
      setError(false);
    } else setError(true);
  };

  const onPublish = () =>
    publishSheet.run(
      t('relayPublishSheet.title', { title: t('blossomServers.title') }),
      publish,
      'blossomServers',
    );

  return (
    <View testID="blossom-servers">
      <NetworkSectionHeading
        title={t('blossomServers.title')}
        explanation={t('networkInfo.blossomHint')}
        testID="blossom"
        spec="https://github.com/hzrd149/blossom/blob/master/buds/03.md"
      />
      <RelayPublishSheet state={publishSheet} />
      <View style={list.list} testID="blossom-server-list">
        {servers.map((url, i) => (
          <View key={url} style={list.row}>
            <RelayStatusDot
              probe
              status={reachability.get(url)?.reachable}
              testID={`blossom-dot-${i}`}
            />
            <View style={list.urlColumn}>
              <Text
                style={list.url}
                numberOfLines={2}
                ellipsizeMode="tail"
                accessibilityLabel={url}
              >
                {url}
              </Text>
            </View>
            {i === 0 ? (
              <View style={styles.primaryBadge} testID={`blossom-primary-${url}`}>
                <Text style={styles.primaryBadgeText}>{t('blossomServers.primary')}</Text>
              </View>
            ) : (
              <TouchableOpacity
                style={[styles.makePrimary, !editable && list.publishButtonDisabled]}
                onPress={() => makePrimary(url)}
                disabled={!editable}
                accessibilityRole="button"
                accessibilityLabel={t('blossomServers.makePrimaryLabel', { url })}
                testID={`blossom-make-primary-${url}`}
              >
                <Text style={styles.makePrimaryText}>{t('blossomServers.makePrimary')}</Text>
              </TouchableOpacity>
            )}
            {servers.length > 1 && (
              <TouchableOpacity
                style={[list.removeButton, !editable && list.publishButtonDisabled]}
                onPress={() => removeServer(url)}
                disabled={!editable}
                accessibilityRole="button"
                accessibilityLabel={t('publishedRelays.removeHostLabel', {
                  host: relayRowHost(url),
                })}
                testID={`relay-row-remove-blossom-${i}`}
                hitSlop={8}
              >
                <Trash2 size={16} color={colors.brandPink} />
              </TouchableOpacity>
            )}
          </View>
        ))}
      </View>
      <View style={list.addRow}>
        <TextInput
          style={[shared.textInput, list.addInput]}
          value={input}
          onChangeText={(v) => {
            setInput(v);
            if (error) setError(false);
          }}
          placeholder="https://blossom.example.com"
          placeholderTextColor="rgba(0,0,0,0.3)"
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          onSubmitEditing={submit}
          editable={editable}
          testID="blossom-add-input"
          accessibilityLabel={t('blossomServers.addLabel')}
        />
        <TouchableOpacity
          style={[list.addButton, !editable && list.publishButtonDisabled]}
          onPress={submit}
          disabled={!editable}
          accessibilityRole="button"
          accessibilityLabel={t('blossomServers.addLabel')}
          testID="blossom-add-button"
        >
          <Text style={list.addButtonText}>{t('blossomServers.add')}</Text>
        </TouchableOpacity>
      </View>
      {error && (
        <Text style={[shared.fieldHint, { color: colors.white }]} testID="blossom-add-error">
          {t('blossomServers.invalid')}
        </Text>
      )}

      <TouchableOpacity
        style={[list.publishButton, (!dirty || !editable) && list.publishButtonDisabled]}
        onPress={() => void onPublish()}
        disabled={!dirty || !editable}
        accessibilityRole="button"
        accessibilityState={{ disabled: !dirty || !editable, busy: publishing }}
        accessibilityLabel={t('blossomServers.publish')}
        testID="blossom-publish"
      >
        {publishing ? (
          <BrandedSpinner />
        ) : (
          <Text style={list.publishButtonText}>{t('blossomServers.publish')}</Text>
        )}
      </TouchableOpacity>
    </View>
  );
}
