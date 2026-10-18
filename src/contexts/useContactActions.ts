import { enabledAppRelays } from '../services/appRelayPrefs';
import { PROFILE_RELAYS } from '../services/nostrRelayDefaults';
import { getEventHash } from 'nostr-tools/pure';
import { captureFollowSession } from '../services/followSetEvents';
import { adoptFollowSnapshot } from '../services/contactFollowFreshness';
import {
  useCallback,
  useEffect,
  useRef,
  startTransition,
  type Dispatch,
  type SetStateAction,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import * as nip19 from 'nostr-tools/nip19';
import * as nostrService from '../services/nostrService';
import * as amberService from '../services/amberService';
import { nip46Sign } from './nip46DmDecrypt';
import { NSEC_KEY } from './nostrAuthKeys';
import { perAccountKey } from '../services/perAccountStorage';
import { CONTACTS_CACHE_KEY_BASE, CONTACTS_TIMESTAMP_KEY_BASE } from './nostrCacheKeys';
import {
  prepareContactListUpdate,
  type ContactChange,
  type ContactListBase,
} from '../services/contactListSync';
import { clearAccountCreatedHere, isAccountCreatedHere } from '../services/newAccountContactList';
import { Toast } from '../components/BrandedToast';
import { t } from '../i18n';
import type { NostrContact, RelayConfig, SignerType } from '../types/nostr';

/**
 * The follow-list WRITE path (#779) — everything that mutates the user's
 * kind-3 contact list — pulled out of `NostrProvider` so the provider file
 * stays reviewable (file-size cap). This is the action half of the sibling
 * `NostrContactsContext`: `refreshContacts` / `followContact` /
 * `unfollowContact` / `addContact`, plus the private `publishContactList`
 * they all funnel through to sign + broadcast the updated kind-3.
 *
 * Every write is a read-modify-write against the newest kind-3 on the
 * relays, never the in-memory `contacts` (#1271): see `contactListSync`.
 *
 * The `contacts` STATE itself still lives in the provider (it feeds
 * `followPubkeys` → the DM inbox), so this hook takes `contacts` +
 * `setContacts` as inputs and drives them; the relay-fetch `loadContacts`
 * loader is likewise owned by the provider (shared with the login paths)
 * and threaded in for `refreshContacts` to force-refresh through.
 */
export interface UseContactActionsParams {
  pubkey: string | null;
  isLoggedIn: boolean;
  signerType: SignerType | null;
  relays: RelayConfig[];
  contacts: NostrContact[];
  setContacts: Dispatch<SetStateAction<NostrContact[]>>;
  getReadRelays: () => string[];
  loadContacts: (
    pk: string,
    relayUrls: string[],
    opts?: { force?: boolean; awaitProfiles?: boolean },
  ) => Promise<void>;
}

export interface UseContactActionsResult {
  refreshContacts: () => Promise<void>;
  followContact: (pubkey: string) => Promise<boolean>;
  unfollowContact: (pubkey: string) => Promise<boolean>;
  addContact: (
    npubOrHex: string,
  ) => Promise<
    | { success: true; pubkey: string; alreadyFollowing?: boolean }
    | { success: false; error: string }
  >;
}

export function useContactActions({
  pubkey,
  isLoggedIn,
  signerType,
  relays,
  contacts,
  setContacts,
  getReadRelays,
  loadContacts,
}: UseContactActionsParams): UseContactActionsResult {
  const refreshContacts = useCallback(async () => {
    if (!pubkey) return;
    const readRelays = getReadRelays();
    // User-initiated refresh (e.g. pull-to-refresh) — bypass the 24h
    // contacts cache so newly-added follows surface immediately. Resolve
    // as soon as the (force-fetched) contact LIST is in state, without
    // blocking on the kind-0 profile batch: the caller's spinner should
    // clear in seconds, and avatars stream in progressively via the
    // profile batch's onBatch hook. This is what keeps pull-to-refresh
    // from hanging ~90s on a large follow list, while the follow-gate /
    // DM-inbox refresh (which only needs the contact list) still sees an
    // up-to-date follow set. (#852)
    await loadContacts(pubkey, readRelays, { force: true, awaitProfiles: false });
  }, [pubkey, getReadRelays, loadContacts]);

  const publishContactList = useCallback(
    async (
      event: { kind: number; created_at: number; tags: string[][]; content: string },
      isCurrentSession: () => boolean,
    ): Promise<boolean> => {
      if (!pubkey || !isLoggedIn || !isCurrentSession()) return false;
      try {
        const writeRelays = relays.filter((r) => r.write).map((r) => r.url);
        const targetRelays =
          writeRelays.length > 0
            ? writeRelays
            : enabledAppRelays('default', nostrService.DEFAULT_RELAYS);

        if (signerType === 'nsec') {
          const nsec = await SecureStore.getItemAsync(NSEC_KEY);
          if (!nsec || !isCurrentSession()) return false;
          const { secretKey } = nostrService.decodeNsec(nsec);
          await nostrService.signAndPublishEvent(event, secretKey, targetRelays);
        } else if (signerType === 'amber') {
          const eventJson = JSON.stringify(event);
          const { event: signedEventJson } = await amberService.requestEventSignature(
            eventJson,
            '',
            pubkey,
          );
          if (!signedEventJson || !isCurrentSession()) return false;
          const signed = JSON.parse(signedEventJson);
          await nostrService.publishSignedEvent(signed, targetRelays);
        } else if (signerType === 'nip46') {
          const signedEventJson = await nip46Sign(event, pubkey);
          if (!signedEventJson || !isCurrentSession()) return false;
          await nostrService.publishSignedEvent(JSON.parse(signedEventJson), targetRelays);
        } else {
          // No usable signer (null / unsupported): nothing was published, so
          // report failure. Returning true here would let the callers commit
          // the follow/unfollow to local state + cache while the kind-3 never
          // hit a relay, silently diverging the device from the network.
          console.warn('Failed to publish contact list: no active signer');
          return false;
        }
        return true;
      } catch (error) {
        console.warn('Failed to publish contact list:', error);
        return false;
      }
    },
    [pubkey, isLoggedIn, signerType, relays],
  );

  // A loaded, non-empty follow list (from any read path, e.g. the provider's
  // background contacts load) proves the account has a kind-3, so it must
  // never again be treated as a brand-new, list-less account (#1271).
  useEffect(() => {
    if (pubkey && contacts.length > 0) void clearAccountCreatedHere(pubkey);
  }, [pubkey, contacts.length]);

  // Writes are serialised: each one fetches the newest list, so two
  // overlapping follows would otherwise both build on the same base and the
  // second publish would drop the first. The last event this session
  // published is remembered too, in case relays still serve the older copy.
  const writeQueue = useRef<Promise<unknown>>(Promise.resolve());
  const lastPublished = useRef<Map<string, ContactListBase>>(new Map());

  // Fetch-merge-publish one follow/unfollow, then mirror the result into
  // state + the per-account cache (#288). Resolves to true when the follow
  // list now reflects the change, false when nothing was published (no
  // verified kind-3 to build on, or the signer declined).
  const updateContactList = useCallback(
    (change: ContactChange): Promise<boolean> => {
      const isCurrentSession = captureFollowSession();
      const run = async (): Promise<boolean> => {
        if (!pubkey || !isLoggedIn || !isCurrentSession()) return false;
        const writeRelays = relays.filter((r) => r.write).map((r) => r.url);
        const update = await prepareContactListUpdate({
          pubkey,
          relays: [
            ...getReadRelays(),
            ...writeRelays,
            ...enabledAppRelays('default', nostrService.DEFAULT_RELAYS),
            ...PROFILE_RELAYS,
          ],
          localContacts: contacts,
          change,
          lastPublished: lastPublished.current.get(pubkey),
          // Only an account created here may start a fresh list when relays
          // confirm it has none; an imported key's list may be elsewhere.
          allowEmptyList: await isAccountCreatedHere(pubkey),
          onListSeen: () => clearAccountCreatedHere(pubkey),
        });
        if (!isCurrentSession()) return false;
        if (!update) {
          // No verified relay copy to build on: publishing from the local
          // list could replace the user's real follow list (#1271).
          Toast.show({ type: 'error', text1: t('followList.unavailable') });
          return false;
        }
        if (update.changed) {
          if (!(await publishContactList(update.event, isCurrentSession))) return false;
          if (!isCurrentSession()) return false;
          lastPublished.current.set(pubkey, {
            tags: update.event.tags,
            content: update.event.content,
            createdAt: update.event.created_at,
          });
          await clearAccountCreatedHere(pubkey);
        }
        await adoptFollowSnapshot(
          pubkey,
          {
            contacts: update.contacts,
            createdAt: update.changed ? update.event.created_at : update.base.createdAt,
            id: update.changed ? getEventHash({ ...update.event, pubkey }) : update.base.id,
          },
          (next) => startTransition(() => setContacts(next)),
          isCurrentSession,
        );
        // Bumps the *contacts* timestamp (the freshness clock for kind-3 list
        // reads), not the profiles one (#442).
        AsyncStorage.setItem(
          perAccountKey(CONTACTS_TIMESTAMP_KEY_BASE, pubkey),
          Date.now().toString(),
        ).catch(() => {});
        return true;
      };
      const next = writeQueue.current.then(run, run);
      writeQueue.current = next.catch(() => {});
      return next;
    },
    [pubkey, isLoggedIn, relays, getReadRelays, contacts, publishContactList, setContacts],
  );

  const followContact = useCallback(
    async (contactPubkey: string): Promise<boolean> => {
      if (contacts.some((c) => c.pubkey === contactPubkey)) return true; // already following
      if (!(await updateContactList({ type: 'follow', pubkey: contactPubkey }))) return false;
      // Fetch the new contact's profile so the row gets a name + avatar.
      const profileData = await nostrService.fetchProfile(contactPubkey, getReadRelays());
      if (profileData) {
        const cKey = perAccountKey(CONTACTS_CACHE_KEY_BASE, pubkey);
        startTransition(() =>
          setContacts((prev) => {
            const next = prev.map((c) =>
              c.pubkey === contactPubkey ? { ...c, profile: profileData } : c,
            );
            AsyncStorage.setItem(cKey, JSON.stringify(next)).catch(() => {});
            return next;
          }),
        );
      }
      return true;
    },
    [contacts, updateContactList, getReadRelays, pubkey, setContacts],
  );

  const unfollowContact = useCallback(
    (contactPubkey: string): Promise<boolean> =>
      updateContactList({ type: 'unfollow', pubkey: contactPubkey }),
    [updateContactList],
  );

  const addContact = useCallback(
    async (
      npubOrHex: string,
    ): Promise<
      | { success: true; pubkey: string; alreadyFollowing?: boolean }
      | { success: false; error: string }
    > => {
      try {
        let hex = npubOrHex.trim();
        // Strip nostr: URI prefix (NIP-21)
        if (hex.startsWith('nostr:')) {
          hex = hex.slice(6);
        }
        if (hex.startsWith('npub1')) {
          const decoded = nip19.decode(hex);
          if (decoded.type !== 'npub') return { success: false, error: 'Invalid npub' };
          hex = decoded.data;
        }
        if (!/^[0-9a-f]{64}$/i.test(hex)) {
          return { success: false, error: 'Invalid public key format' };
        }
        if (contacts.some((c) => c.pubkey === hex)) {
          // Already a follow — not a failure. Surface it as a neutral
          // "already connected" so the UI doesn't show a red error (#660).
          return { success: true, alreadyFollowing: true, pubkey: hex };
        }
        const success = await followContact(hex);
        return success
          ? { success: true, pubkey: hex }
          : { success: false, error: 'Failed to publish contact list' };
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : 'Invalid key' };
      }
    },
    [contacts, followContact],
  );

  return { refreshContacts, followContact, unfollowContact, addContact };
}
