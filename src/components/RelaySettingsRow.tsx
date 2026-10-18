import React, { useMemo } from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { Trash2 } from 'lucide-react-native';
import RelayStatusDot from './RelayStatusDot';
import { useTranslation } from '../contexts/LocaleContext';
import { useThemeColors } from '../contexts/ThemeContext';
import { createPublishedRelayListsSectionStyles } from '../styles/PublishedRelayListsSection.styles';
import { relayAccessTag, relayRowHost, relayDisplayName } from '../utils/relayDetails';

export default React.memo(function RelaySettingsRow({
  url,
  read,
  write,
  status,
  inUse = false,
  probeIndex,
  inbox = false,
  testIDPrefix = '',
  onOpen,
  onRemove,
  removeDisabled = false,
  removeTestID,
}: {
  url: string;
  read?: boolean;
  write?: boolean;
  status?: boolean;
  inUse?: boolean;
  probeIndex?: number;
  inbox?: boolean;
  testIDPrefix?: string;
  onOpen: (url: string, kind: 'nip65' | 'inbox') => void;
  onRemove?: (url: string) => void;
  removeDisabled?: boolean;
  removeTestID?: string;
}) {
  const colors = useThemeColors();
  const t = useTranslation();
  const styles = useMemo(() => createPublishedRelayListsSectionStyles(colors), [colors]);
  const tag = read === undefined || write === undefined ? null : relayAccessTag({ read, write });
  return (
    <View style={styles.rowContainer}>
      <TouchableOpacity
        style={[styles.row, styles.openRow]}
        onPress={() => onOpen(url, inbox ? 'inbox' : 'nip65')}
        testID={`${testIDPrefix}${inbox ? 'inbox-' : ''}relay-row-${relayRowHost(url)}`}
        accessibilityRole="button"
        accessibilityLabel={url}
      >
        <RelayStatusDot
          status={status}
          probe={probeIndex !== undefined}
          testID={probeIndex === undefined ? undefined : `relay-dot-${probeIndex}`}
        />
        <View style={styles.urlColumn}>
          <Text style={styles.url}>{relayDisplayName(url)}</Text>
        </View>
        {inUse && (
          <Text
            style={styles.accessTag}
            testID={`relay-in-use-${probeIndex}`}
            accessibilityLabel={t('relayReachability.inUse')}
          >
            {t('relayReachability.inUse')}
          </Text>
        )}
        {tag && <Text style={styles.accessTag}>{t(`relayDetails.${tag}`)}</Text>}
      </TouchableOpacity>
      {onRemove && (
        <TouchableOpacity
          style={[
            styles.removeButton,
            styles.rowRemoveButton,
            removeDisabled && styles.publishButtonDisabled,
          ]}
          onPress={() => onRemove(url)}
          disabled={removeDisabled}
          accessibilityRole="button"
          accessibilityLabel={t('publishedRelays.removeHostLabel', { host: relayRowHost(url) })}
          accessibilityState={{ disabled: removeDisabled }}
          testID={removeTestID}
          hitSlop={8}
        >
          <Trash2 size={16} color={colors.brandPink} />
        </TouchableOpacity>
      )}
    </View>
  );
});
