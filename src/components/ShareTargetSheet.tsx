import React, { useCallback, useEffect, useRef } from 'react';
import FriendPickerSheet, { type PickedFriend } from './FriendPickerSheet';
import ShareTargetRecents from './ShareTargetRecents';
import { useNostr } from '../contexts/NostrContext';
import { useTranslation } from '../contexts/LocaleContext';
import { navigationRef } from '../navigation/AppNavigator';
import type { RootStackParamList } from '../navigation/types';
import { preferredConversationParams } from '../services/preferredDmProtocol';
import { stagePendingShare } from '../services/pendingShareStore';
import { DEFAULT_DM_PROTOCOL } from '../utils/dmProtocol';
import { dmShareTarget, groupShareTarget, type IncomingShare } from '../utils/incomingShare';
import type { ConversationSummary } from '../utils/conversationSummaries';
import type { GroupSummary } from '../types/groups';

interface Props {
  share: IncomingShare;
  /** Account (hex pubkey) that was active when the share arrived. */
  owner: string;
  /** `picked` is false when the sheet was dismissed without choosing a chat
   *  (or the account changed) — the host then deletes the share's files. */
  onDone: (picked: boolean) => void;
}

/**
 * "Send to…" picker for a share from another app (#1692): recent chats first,
 * then friends, with search. Picking a chat stages the share for that chat's
 * composer and opens it — the composer only prefills; nothing is sent until
 * the user taps Send there. Loaded lazily by `ShareIntentHost`, so none of
 * this is on the cold-start path.
 */
const ShareTargetSheet: React.FC<Props> = ({ share, owner, onDone }) => {
  const t = useTranslation();
  const { pubkey } = useNostr();
  const pickedRef = useRef(false);
  // The host remounts this sheet (new `key`) for each share. A friend lookup
  // still pending when a newer share replaced this one, or the account
  // changed, must not stage this share or dismiss the newer one: the host
  // has already deleted this share's files.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // The share must only ever go out from the account that received it.
  const stillOwner = useCallback(
    () => !!pubkey && pubkey.toLowerCase() === owner.toLowerCase(),
    [pubkey, owner],
  );

  const finish = useCallback(
    (target: string, open: () => void) => {
      if (!mountedRef.current) return;
      if (!stillOwner() || !navigationRef.isReady()) {
        onDone(false);
        return;
      }
      stagePendingShare(target, owner, share);
      onDone(true);
      open();
    },
    [owner, share, onDone, stillOwner],
  );

  const openConversation = useCallback(
    (params: RootStackParamList['Conversation']) =>
      finish(dmShareTarget(params.pubkey, params.protocol), () =>
        navigationRef.navigate('Conversation', params),
      ),
    [finish],
  );

  const handleFriend = useCallback(
    (friend: PickedFriend) => {
      if (pickedRef.current) return;
      pickedRef.current = true;
      void preferredConversationParams(owner, friend)
        .catch(() => ({ ...friend, protocol: DEFAULT_DM_PROTOCOL }))
        .then(openConversation);
    },
    [owner, openConversation],
  );

  const handleDm = useCallback(
    (summary: ConversationSummary) => {
      if (pickedRef.current || !summary.pubkey) return;
      pickedRef.current = true;
      openConversation({
        protocol: summary.protocol ?? DEFAULT_DM_PROTOCOL,
        pubkey: summary.pubkey,
        name: summary.name,
        picture: summary.picture,
        lightningAddress: summary.lightningAddress,
      });
    },
    [openConversation],
  );

  const handleGroup = useCallback(
    (summary: GroupSummary) => {
      if (pickedRef.current) return;
      pickedRef.current = true;
      const groupId = summary.group.id;
      finish(groupShareTarget(groupId), () =>
        navigationRef.navigate('GroupConversation', { groupId }),
      );
    },
    [finish],
  );

  // Dismissed (swipe, back, backdrop) before a chat was picked: keep nothing.
  const handleClose = useCallback(() => {
    if (pickedRef.current) return;
    pickedRef.current = true;
    onDone(false);
  }, [onDone]);

  const renderRecents = useCallback(
    (query: string) => (
      <ShareTargetRecents query={query} onSelectDm={handleDm} onSelectGroup={handleGroup} />
    ),
    [handleDm, handleGroup],
  );

  const photos = share.images.length;
  const subtitle =
    photos > 0 ? t('shareIntent.subtitlePhotos', { count: photos }) : t('shareIntent.subtitleText');

  return (
    <FriendPickerSheet
      visible
      onClose={handleClose}
      onSelect={handleFriend}
      title={t('shareIntent.title')}
      subtitle={subtitle}
      listHeader={renderRecents}
    />
  );
};

export default ShareTargetSheet;
