import { APP_RELAY_PREFS_KEY, forgetAppRelayPrefs } from '../services/appRelayPrefs';
import { wipeCheckoutAddress } from '../services/checkoutAddressStorage';
import { cancelSellerActivity } from '../services/sellerActivityService';
import { drainSellerReceiveWalletWrites } from '../services/sellerReceiveWallet';
import { drainBuyerOrderTitleWrites } from '../services/buyerOrderTitles';
import { drainSellerInvoiceWrites } from '../services/sellerInvoiceStore';
import { drainOrderAdmission, orderBudgetKey } from '../services/orderAdmission';
import { wipeRemoteMediaForOwner } from '../services/remoteMediaCache';
import { retireBuyerOrderTitles, waitForBuyerOrderTitleWrites } from '../services/buyerOrderTitles';
import { FOLLOW_SNAPSHOT_KEY } from '../services/contactFollowFreshness';
/**
 * wipeAccountCaches — delete every per-account persisted artifact for a
 * signed-out identity: per-wallet secrets (SecureStore), all per-wallet
 * caches (balance / tx history / receipt-dedup, not just txs), the
 * per-account namespaced caches from the #288 storage refactor,
 * per-conversation DM caches, decrypted group-chat plaintext, the encrypted
 * DM store rows (#848), decrypted voice notes / photos (#1241), and the
 * device-global nostr places cache.
 *
 * Extracted from NostrContext (#703 file-size effort) — it was a
 * zero-dependency useCallback (empty deps array) closing over no provider
 * state, so it's a pure module function. Called by logout and
 * signOutIdentity.
 */
import { wipeMarketAccount } from '../services/marketStorage';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { perAccountKey } from '../services/perAccountStorage';
import {
  forgetSellerAccount,
  sellerCacheStorageKey,
  sellerHiddenStorageKey,
} from '../services/sellerEventStore';
import {
  deleteNwcUrl,
  deleteXpub,
  deleteMnemonic,
  deleteWalletCaches,
  bestEffortMultiRemove,
  BLOSSOM_SERVERS_PUBLISHED_KEY_BASE,
  BLOSSOM_SERVERS_CREATED_AT_KEY_BASE,
} from '../services/walletStorageService';
import { deleteGroupMessagesForOwner } from '../services/groupMessagesStorageService';
import { clearCacheStorage as clearNostrPlacesCache } from '../services/nostrPlacesStorage';
import { clearNotificationHistory } from '../services/notificationHistory';
import { PER_ACCOUNT_SETTING_BASES } from '../services/safetySettingsMigration';
import { forgetAccountSettings } from '../services/accountSettingsCache';
import { forgetLinkPreviewMirror } from '../services/linkPreviewPreference';
import { forgetRevealedMedia } from '../services/mediaRevealStore';
import { cancelNotificationDefaults } from '../services/notificationDefaults';
import { clearDecryptedMediaCache } from '../services/decryptedMediaCache';
import { WATCHER_PUSH_KEY_BASE } from '../services/watcherPushStore';
import { KEY_BACKED_UP_KEY_BASE } from '../services/keyBackupStatus';
import {
  BANNER_SNOOZE_KEY_BASE,
  REMINDER_ANCHOR_KEY_BASE,
  retireKeyBackupReminder,
} from '../services/keyBackupReminder';
import { CHAT_READ_POSITIONS_KEY_BASE, forgetReadPositions } from '../services/chatReadPositions';
import {
  AMBER_NIP17_CACHE_KEY_BASE,
  NSEC_NIP17_CACHE_KEY_BASE,
  DM_CONV_CACHE_PREFIX,
  DM_CONV_LAST_SEEN_PREFIX,
  inboxCacheKey,
  inboxLastSeenKey,
} from './nostrDmCache';
import { wipeDmStoresForAccount } from './dmAccountWipe';
import { dmStoreMigratedKey } from './dmStoreMigrationRunner';
import { dmBlobMigratedKey } from './dmBlobMigration';
import {
  CONTACTS_CACHE_KEY_BASE,
  PROFILES_CACHE_KEY_BASE,
  CACHE_TIMESTAMP_KEY_BASE,
  CONTACTS_TIMESTAMP_KEY_BASE,
  OWN_PROFILE_CACHE_KEY_BASE,
  OWN_PROFILE_TIMESTAMP_KEY_BASE,
  RELAY_LIST_CACHE_KEY_BASE,
  RELAY_LIST_TIMESTAMP_KEY_BASE,
  RELAY_LIST_CREATED_AT_KEY_BASE,
  DM_INBOX_RELAYS_CACHE_KEY_BASE,
  DM_INBOX_CREATED_AT_KEY_BASE,
} from './nostrCacheKeys';

export async function wipeAccountCaches(loggedOutPubkey: string | null): Promise<void> {
  if (!loggedOutPubkey) return;
  retireBuyerOrderTitles(loggedOutPubkey);
  // Never let a SecureStore failure abort the rest of the per-account wipe.
  await wipeCheckoutAddress(loggedOutPubkey).catch(() => undefined);
  await cancelNotificationDefaults(loggedOutPubkey);
  await cancelSellerActivity(loggedOutPubkey);
  // Its weekly "Back up your key" reminder goes with it (#1546).
  await retireKeyBackupReminder(loggedOutPubkey).catch(() => undefined);
  try {
    await wipeRemoteMediaForOwner(loggedOutPubkey);
  } catch (e) {
    if (__DEV__) console.warn('[wipeAccountCaches] remote media wipe failed:', e);
  }
  await wipeMarketAccount(loggedOutPubkey);
  // In-app notification history (#1143): names, amounts and routing ids.
  await clearNotificationHistory(loggedOutPubkey);
  // Read the per-account wallet list FIRST so we can delete the
  // per-wallet secrets that live in SecureStore (NWC URLs, xpubs,
  // mnemonics) and the per-wallet AsyncStorage tx caches. Without
  // this, signing out of an identity leaves orphaned credentials
  // and tx caches under their walletIds — a real privacy concern
  // on shared devices and what Copilot flagged on #442.
  const walletListKey = `wallet_list_${loggedOutPubkey}`;
  let walletIds: string[] = [];
  try {
    const json = await AsyncStorage.getItem(walletListKey);
    if (json) {
      const list = JSON.parse(json) as { id: string }[];
      if (Array.isArray(list)) walletIds = list.map((w) => w.id).filter(Boolean);
    }
  } catch {
    // Corrupted wallet list — nothing we can clean per-wallet,
    // but the AsyncStorage.multiRemove below still kills the list
    // entry itself so a future load won't surface it.
  }
  // Per-wallet secret cleanup. Each delete is best-effort; an
  // already-absent key is a no-op in expo-secure-store, so we
  // can fan out concurrently without sequencing.
  await Promise.allSettled(
    walletIds.flatMap((id) => [deleteNwcUrl(id), deleteXpub(id), deleteMnemonic(id)]),
  );

  await forgetAppRelayPrefs(loggedOutPubkey);
  const toRemove: string[] = [
    perAccountKey(APP_RELAY_PREFS_KEY, loggedOutPubkey),
    perAccountKey('seller_activity_enabled_v1', loggedOutPubkey),
    perAccountKey('seller_activity_cursor_v1', loggedOutPubkey),
    // Per-account namespaced caches (#288 storage refactor)
    perAccountKey(FOLLOW_SNAPSHOT_KEY, loggedOutPubkey),
    perAccountKey(CONTACTS_CACHE_KEY_BASE, loggedOutPubkey),
    perAccountKey(CONTACTS_TIMESTAMP_KEY_BASE, loggedOutPubkey),
    perAccountKey(PROFILES_CACHE_KEY_BASE, loggedOutPubkey),
    perAccountKey(CACHE_TIMESTAMP_KEY_BASE, loggedOutPubkey),
    perAccountKey(OWN_PROFILE_CACHE_KEY_BASE, loggedOutPubkey),
    perAccountKey(OWN_PROFILE_TIMESTAMP_KEY_BASE, loggedOutPubkey),
    perAccountKey(RELAY_LIST_CACHE_KEY_BASE, loggedOutPubkey),
    perAccountKey(RELAY_LIST_TIMESTAMP_KEY_BASE, loggedOutPubkey),
    perAccountKey(BLOSSOM_SERVERS_PUBLISHED_KEY_BASE, loggedOutPubkey),
    perAccountKey(BLOSSOM_SERVERS_CREATED_AT_KEY_BASE, loggedOutPubkey),
    perAccountKey(RELAY_LIST_CREATED_AT_KEY_BASE, loggedOutPubkey),
    perAccountKey(DM_INBOX_RELAYS_CACHE_KEY_BASE, loggedOutPubkey),
    perAccountKey(DM_INBOX_CREATED_AT_KEY_BASE, loggedOutPubkey),
    perAccountKey(AMBER_NIP17_CACHE_KEY_BASE, loggedOutPubkey),
    perAccountKey(NSEC_NIP17_CACHE_KEY_BASE, loggedOutPubkey),
    // Notification-watcher choices + registration record. The key is gone,
    // so no signed unregister: the registration dies with the push token,
    // which wipeDmStoresForAccount (Marmot push teardown) deletes below.
    perAccountKey(WATCHER_PUSH_KEY_BASE, loggedOutPubkey),
    // Automatic OFF can be persisted after Marmot's settings hydration; remove
    // it even when its runtime ever-enabled set hasn't seen this account.
    `marmot_push_enabled_v1_${loggedOutPubkey.toLowerCase()}`,
    // A future re-login must reconsider notification defaults after preferences are wiped.
    `notification_preference_explicit_v1_${loggedOutPubkey.toLowerCase()}`,
    // The key it vouched for is gone with the account (#1223).
    perAccountKey(KEY_BACKED_UP_KEY_BASE, loggedOutPubkey),
    // Its backup-reminder anchor and banner snooze (#1546).
    perAccountKey(REMINDER_ANCHOR_KEY_BASE, loggedOutPubkey),
    perAccountKey(BANNER_SNOOZE_KEY_BASE, loggedOutPubkey),
    // Where this account had read each chat up to (#1295).
    perAccountKey(CHAT_READ_POSITIONS_KEY_BASE, loggedOutPubkey),
    // DM-store migration flags (#848 wrap cache, #850 blobs) — a future
    // re-login re-runs the (then no-op) migration checks instead of
    // trusting a stale flag.
    dmStoreMigratedKey(loggedOutPubkey),
    dmBlobMigratedKey(loggedOutPubkey),
    // Pre-#288 UNSUFFIXED wrap-cache rows (N9, #850) — plaintext predating
    // per-account keys. Not attributable to an owner, so any account's
    // wipe removes them (the content is re-fetchable from relays).
    AMBER_NIP17_CACHE_KEY_BASE,
    NSEC_NIP17_CACHE_KEY_BASE,
    // Pre-existing per-pubkey caches (already namespaced before #288)
    inboxCacheKey(loggedOutPubkey),
    inboxLastSeenKey(loggedOutPubkey),
    `dm-kind4-retries:${loggedOutPubkey}`,
    `dm-kind4-exhausted:${loggedOutPubkey}`,
    // Product titles reveal this account's purchase history.
    `market-buyer-order-titles:${loggedOutPubkey}`,
    `market-seller-invoices:${loggedOutPubkey}`,
    `market-seller-receive-wallet:${loggedOutPubkey}`,
    orderBudgetKey(loggedOutPubkey),
    `nostr_group_activity_${loggedOutPubkey}`,
    `nostr_groups_${loggedOutPubkey}`,
    `groups_following_only_${loggedOutPubkey}`,
    // Per-account safety settings (threshold, trust tier, Secret Mode, link
    // previews): only THIS account's values go; other accounts keep theirs.
    ...PER_ACCOUNT_SETTING_BASES.map((base) => perAccountKey(base, loggedOutPubkey)),
    walletListKey,
    // Market listings this account deleted on this device (#1273).
    sellerHiddenStorageKey(loggedOutPubkey),
    sellerCacheStorageKey(loggedOutPubkey),
  ];
  forgetSellerAccount(loggedOutPubkey);
  await drainOrderAdmission();
  await drainSellerInvoiceWrites();
  await drainSellerReceiveWalletWrites();
  await drainBuyerOrderTitleWrites();
  forgetLinkPreviewMirror(loggedOutPubkey);
  forgetRevealedMedia(loggedOutPubkey);
  forgetAccountSettings(loggedOutPubkey);
  forgetReadPositions(loggedOutPubkey);
  const allKeys = await AsyncStorage.getAllKeys();
  const convPrefix = DM_CONV_CACHE_PREFIX + loggedOutPubkey + '_';
  const lastSeenPrefix = DM_CONV_LAST_SEEN_PREFIX + loggedOutPubkey + '_';
  for (const k of allKeys) {
    if (k.startsWith(convPrefix) || k.startsWith(lastSeenPrefix)) toRemove.push(k);
  }
  // Decrypted group-chat plaintext (#689) — ONLY this account's logs (#1240):
  // other accounts on the device keep theirs, and Marmot history can't be
  // re-fetched. Runs before the group lists / Marmot state below are deleted,
  // so a not-yet-migrated legacy blob is still attributed to this account
  // (copied to every owner, then this owner's copy removed here).
  try {
    await deleteGroupMessagesForOwner(loggedOutPubkey);
  } catch (e) {
    if (__DEV__) console.warn('[wipeAccountCaches] group history wipe failed:', e);
  }
  // Best-effort so a transient multiRemove rejection can't abort the wipe below.
  await waitForBuyerOrderTitleWrites();
  await bestEffortMultiRemove(toRemove);
  // All per-wallet caches (balance / txs / receipt-dedup), not just txs_ —
  // deleteWalletCaches wipes the full set so a deleted-identity wallet leaves
  // no balance or transaction residue on a shared device.
  await Promise.all(walletIds.map((id) => deleteWalletCaches(id)));
  // Decrypted DM plaintext must not survive logout / account wipe (#689
  // review / #690): delete the file-backed wrap + skip-set caches and this
  // owner's rows in the encrypted DB (#848) — see dmAccountWipe.
  await wipeDmStoresForAccount(loggedOutPubkey);
  // Decrypted voice notes and photos (files + memory), same rule (#1241).
  await clearDecryptedMediaCache(loggedOutPubkey);
  // Nostr places cache is device-global and not pubkey-namespaced, yet holds
  // this identity's own by-author Piglets — wipe it on logout / switch so
  // pins don't leak across accounts (the next live sub repopulates it).
  await clearNostrPlacesCache();
}
