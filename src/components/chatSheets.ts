// The sheets the 1:1 and group chat screens open, each mounted on first open
// (see mountOnFirstOpen). Same names and props as the components they wrap.
// Sheets that already render nothing while closed (FullscreenGifModal,
// DeliveryDetailSheet) are imported directly.
import ContactProfileSheetBase from './ContactProfileSheet';
import DmMembersSheetBase from './DmMembersSheet';
import FriendPickerSheetBase from './FriendPickerSheet';
import GifPickerSheetBase from './GifPickerSheet';
import GroupMembersSheetBase from './GroupMembersSheet';
import LiveLocationDurationPickerBase from './LiveLocationDurationPicker';
import MessageActionsSheetBase from './MessageActionsSheet';
import NwcWalletShareSheetBase from './NwcWalletShareSheet';
import PollComposerSheetBase from './PollComposerSheet';
import ReceiveSheetBase from './ReceiveSheet';
import RenameGroupSheetBase from './RenameGroupSheet';
import SecretModeCelebrationBase from './SecretModeCelebration';
import SendSheetBase from './SendSheet';
import TransactionDetailSheetBase from './TransactionDetailSheet';
import VoiceRecordingSheetBase from './VoiceRecordingSheet';
import { mountOnFirstOpen } from './mountOnFirstOpen';

const byVisible = (p: { visible: boolean }) => p.visible;

export const ContactProfileSheet = mountOnFirstOpen(ContactProfileSheetBase, 'contact', byVisible);
export const DmMembersSheet = mountOnFirstOpen(DmMembersSheetBase, 'dm-members', byVisible);
export const FriendPickerSheet = mountOnFirstOpen(FriendPickerSheetBase, 'friends', byVisible);
export const GifPickerSheet = mountOnFirstOpen(GifPickerSheetBase, 'gif', byVisible);
export const GroupMembersSheet = mountOnFirstOpen(GroupMembersSheetBase, 'members', byVisible);
export const LiveLocationDurationPicker = mountOnFirstOpen(
  LiveLocationDurationPickerBase,
  'live-location',
  byVisible,
);
export const MessageActionsSheet = mountOnFirstOpen(MessageActionsSheetBase, 'actions', byVisible);
export const NwcWalletShareSheet = mountOnFirstOpen(NwcWalletShareSheetBase, 'nwc', byVisible);
export const PollComposerSheet = mountOnFirstOpen(PollComposerSheetBase, 'poll', byVisible);
export const ReceiveSheet = mountOnFirstOpen(ReceiveSheetBase, 'receive', byVisible);
export const RenameGroupSheet = mountOnFirstOpen(RenameGroupSheetBase, 'rename', byVisible);
export const SecretModeCelebration = mountOnFirstOpen(
  SecretModeCelebrationBase,
  'secret-mode',
  byVisible,
);
export const SendSheet = mountOnFirstOpen(SendSheetBase, 'send', byVisible);
export const TransactionDetailSheet = mountOnFirstOpen(TransactionDetailSheetBase, 'tx', byVisible);
export const VoiceRecordingSheet = mountOnFirstOpen(VoiceRecordingSheetBase, 'voice', byVisible);
