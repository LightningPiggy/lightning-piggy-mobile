import React, { useCallback, useMemo, useState } from 'react';
import { useNavigation, useRoute, type RouteProp } from '@react-navigation/native';
import type { NativeStackNavigationProp } from '@react-navigation/native-stack';
import type { RootStackParamList } from '../navigation/types';
import DmProtocolTag from './DmProtocolTag';
import DmProtocolPickerSheet from './DmProtocolPickerSheet';
import { isDmProtocolAvailable, type DmProtocol } from '../utils/dmProtocol';

export default function ConversationProtocolControl({
  protocol,
  name,
}: {
  protocol: DmProtocol;
  /** The peer's display name, for the picker's Marmot availability line. */
  name?: string;
}) {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParamList>>();
  const { pubkey } = useRoute<RouteProp<RootStackParamList, 'Conversation'>>().params;
  const peer = useMemo(() => ({ pubkey, name }), [pubkey, name]);
  const [visible, setVisible] = useState(false);
  const open = useCallback(() => setVisible(true), []);
  const close = useCallback(() => setVisible(false), []);
  const select = useCallback(
    (value: DmProtocol) => {
      if (!isDmProtocolAvailable(value)) return;
      close();
      if (value !== protocol) {
        // Switch in place rather than replace(): the picker is a sheet portalled
        // to the app root, and unmounting its screen mid-dismiss orphaned its
        // backdrop over the new thread, swallowing taps (e.g. Back). The loader
        // already handles a protocol change on a reused screen.
        navigation.setParams({ protocol: value });
      }
    },
    [navigation, protocol, close],
  );
  return (
    <>
      <DmProtocolTag protocol={protocol} onPress={open} testID="conversation-protocol-tag" />
      <DmProtocolPickerSheet
        visible={visible}
        selected={protocol}
        onSelect={select}
        onClose={close}
        peer={peer}
      />
    </>
  );
}
