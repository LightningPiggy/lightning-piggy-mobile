import { useAppRelayPrefs } from './useAppRelayPrefs';
import type { PublishProgress } from '../utils/relayPublishProgress';
import { lockRelays } from '../config/testRelayLockdown';
import { enabledAppRelays } from '../services/appRelayPrefs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Event } from 'nostr-tools';
import { useNostr } from '../contexts/NostrContext';
import { DEFAULT_RELAYS } from '../services/nostrService';
import {
  fetchLatestReplaceable,
  publishToRelays,
  type RelayPublishResult,
} from '../services/nostrRelayLists';
import {
  DEFAULT_BLOSSOM_SERVER,
  getBlossomServersCreatedAt,
  getPublishedBlossomServers,
  getSavedBlossomServers,
  getSavedLegacyBlossomServer,
  setBlossomServers,
  setBlossomServersCreatedAt,
  setPublishedBlossomServers,
} from '../services/walletStorageService';
import { RELAY_LIST_INDEXERS } from '../utils/relayListEvents';
import {
  BLOSSOM_SERVER_LIST_KIND,
  blossomServersFromTags,
  buildBlossomServerListEvent,
  normalizeBlossomServer,
} from '../utils/blossomServerList';

export type BlossomPublishOutcome =
  | { ok: true; accepted: number; total: number; results: RelayPublishResult[] }
  | {
      ok: false;
      results?: RelayPublishResult[];
      error: 'not-signed' | 'none-accepted' | 'no-valid-servers' | 'busy';
    };

const sameList = (a: string[], b: string[]) =>
  a.length === b.length && a.every((s, i) => s === b[i]);

/**
 * The user's Blossom servers (#1149): primary first, the rest backups that
 * uploads are mirrored to. Edits are saved on the device straight away (they
 * apply to the next upload); Publish shares the list as a BUD-03 kind-10063
 * event so other Nostr apps use the same servers.
 *
 * On load: a saved list wins; else a server the user explicitly set before
 * lists existed becomes the list; only a device on the default adopts a
 * published list. Editing is frozen while loading and while publishing, so
 * neither a late lookup nor a publish result can override a newer edit.
 */
export function useBlossomServerList() {
  const relayScope = useAppRelayPrefs();
  const { pubkey, relays, signEvent } = useNostr();
  const [servers, setServers] = useState<string[]>([]);
  // The list last published (null = never): Publish is offered whenever the
  // current list differs, including a list that was never published.
  const [publishedList, setPublishedList] = useState<string[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [publishing, setPublishing] = useState(false);
  const activePubkeyRef = useRef(pubkey);
  activePubkeyRef.current = pubkey;
  // Newest kind-10063 created_at seen per identity (fetched or published):
  // each publish is signed strictly after it, or relays keep the old list.
  // Also persisted, so it survives leaving the screen (a failed lookup can't
  // then make the next publish older than a list already published).
  const latestCreatedAtRef = useRef(new Map<string, number>());
  const noteCreatedAt = (pk: string, createdAt: number) => {
    const next = Math.max(latestCreatedAtRef.current.get(pk) ?? 0, createdAt);
    latestCreatedAtRef.current.set(pk, next);
    void setBlossomServersCreatedAt(pk, next);
  };
  const mountedRef = useRef(true);
  // Synchronous re-entrancy guard: two quick taps land before the
  // `publishing` state re-render disables the button.
  const publishingRef = useRef(false);
  useEffect(
    () => () => {
      mountedRef.current = false;
    },
    [],
  );
  const relayUrls = useMemo(() => relays.map((r) => r.url), [relays]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void (async () => {
      try {
        const publishedBaseline = pubkey ? await getPublishedBlossomServers(pubkey) : null;
        if (!cancelled) setPublishedList(publishedBaseline);
        if (cancelled) return;
        const saved = await getSavedBlossomServers();
        if (cancelled) return;
        if (saved) {
          if (!cancelled) setServers(saved);
          return;
        }
        // A server explicitly chosen before lists existed: keep it.
        // (The old field also saved an unchanged default — not a real choice.)
        const savedLegacy = await getSavedLegacyBlossomServer();
        // Same form as every other entry (e.g. no trailing slash), so it
        // matches what gets published and isn't duplicated on re-add.
        const legacy = savedLegacy ? (normalizeBlossomServer(savedLegacy) ?? savedLegacy) : null;
        if (cancelled) return;
        if (legacy && legacy !== DEFAULT_BLOSSOM_SERVER) {
          await setBlossomServers([legacy]);
          if (!cancelled) setServers([legacy]);
          return;
        }
        if (!cancelled) setServers([DEFAULT_BLOSSOM_SERVER]);
        if (!pubkey) return;
        const event = await fetchLatestReplaceable(pubkey, BLOSSOM_SERVER_LIST_KIND, [
          ...new Set([
            ...relayUrls,
            ...enabledAppRelays('default', DEFAULT_RELAYS),
            ...enabledAppRelays('indexers', RELAY_LIST_INDEXERS),
          ]),
        ]).catch(() => null);
        if (cancelled) return;
        if (event) noteCreatedAt(pubkey, event.created_at);
        const published = event ? blossomServersFromTags(event.tags) : [];
        if (cancelled || published.length === 0 || activePubkeyRef.current !== pubkey) return;
        await setBlossomServers(published);
        await setPublishedBlossomServers(pubkey, published);
        // The account may have changed while those writes were pending.
        if (cancelled || activePubkeyRef.current !== pubkey) return;
        setServers(published);
        setPublishedList(published);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Retry on app preference hydration/edits; saved choices still win.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pubkey, relayScope]);

  const editable = !loading && !publishing;
  const dirty = publishedList === null || !sameList(servers, publishedList);

  const update = useCallback((next: string[]) => {
    setServers(next);
    void setBlossomServers(next);
  }, []);

  /** Add a server as a backup; false if the URL isn't a valid https server. */
  const addServer = useCallback(
    (input: string): boolean => {
      const url = normalizeBlossomServer(input);
      if (!url) return false;
      if (editable && !servers.includes(url)) update([...servers, url]);
      return true;
    },
    [editable, servers, update],
  );

  // The last server can't be removed — uploads always need one.
  const removeServer = useCallback(
    (url: string) => {
      if (editable && servers.length > 1) update(servers.filter((s) => s !== url));
    },
    [editable, servers, update],
  );

  const makePrimary = useCallback(
    (url: string) => {
      if (editable) update([url, ...servers.filter((s) => s !== url)]);
    },
    [editable, servers, update],
  );

  const publish = useCallback(
    async (progress?: PublishProgress): Promise<BlossomPublishOutcome> => {
      const pk = pubkey;
      if (!pk) return { ok: false, error: 'not-signed' };
      if (publishingRef.current) return { ok: false, error: 'busy' };
      publishingRef.current = true;
      const snapshot = servers;
      setPublishing(true);
      const targets = [
        ...new Set(
          lockRelays(
            [
              ...relayUrls,
              ...enabledAppRelays('default', DEFAULT_RELAYS),
              ...enabledAppRelays('indexers', RELAY_LIST_INDEXERS),
            ],
            pk,
          ),
        ),
      ];
      progress?.({ targets });
      try {
        // The newest list on the relays (another client, or a future-dated one).
        const current = await fetchLatestReplaceable(pk, BLOSSOM_SERVER_LIST_KIND, [
          ...new Set([
            ...relayUrls,
            ...enabledAppRelays('default', DEFAULT_RELAYS),
            ...enabledAppRelays('indexers', RELAY_LIST_INDEXERS),
          ]),
        ]).catch(() => null);
        if (current) noteCreatedAt(pk, current.created_at);
        noteCreatedAt(pk, await getBlossomServersCreatedAt(pk));
        const unsigned = buildBlossomServerListEvent(snapshot);
        // Never publish an empty list (e.g. only a legacy http:// server), which
        // would replace an existing one with nothing.
        if (unsigned.tags.length === 0) return { ok: false, error: 'no-valid-servers' };
        unsigned.created_at = Math.max(
          unsigned.created_at,
          (latestCreatedAtRef.current.get(pk) ?? 0) + 1,
        );
        const signed = await signEvent(unsigned);
        if (!signed || signed.pubkey !== pk || activePubkeyRef.current !== pk)
          return { ok: false, error: 'not-signed' };
        progress?.({ signed: true });
        const results = await publishToRelays(signed as unknown as Event, targets, 8000, (result) =>
          progress?.({ result }),
        );
        const accepted = results.filter((r) => r.ok).length;
        if (accepted === 0) return { ok: false, error: 'none-accepted', results };
        noteCreatedAt(pk, unsigned.created_at);
        // Record exactly what was published; a list edited meanwhile (here or in
        // another screen instance) still differs from it, so stays publishable.
        // What was actually signed (invalid entries are dropped from the event).
        const sent = blossomServersFromTags(signed.tags);
        await setPublishedBlossomServers(pk, sent);
        // Only reflect it on screen if this is still the identity being shown.
        if (mountedRef.current && activePubkeyRef.current === pk) setPublishedList(sent);
        return { ok: true, accepted, total: results.length, results };
      } finally {
        publishingRef.current = false;
        if (mountedRef.current) setPublishing(false);
      }
    },
    [pubkey, servers, signEvent, relayUrls],
  );

  return {
    servers,
    dirty,
    loading,
    publishing,
    editable,
    addServer,
    removeServer,
    makePrimary,
    publish,
  };
}
