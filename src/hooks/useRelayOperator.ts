import { enabledAppRelays } from '../services/appRelayPrefs';
import { useCallback, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';
import { npubEncode } from 'nostr-tools/nip19';
import { fetchProfilesBatch } from '../services/nostrProfileBatch';
import { DEFAULT_RELAYS, PROFILE_RELAYS } from '../services/nostrRelayDefaults';
import { parseProfileContent } from '../utils/profileContent';
import { slimDisplayProfile } from '../utils/profileSanitize';
import { useNostr } from '../contexts/NostrContext';
import * as profileCache from '../services/zapSenderProfileStorage';
import type { NostrProfile } from '../types/nostr';

/** One operator through the existing bounded kind-0 batch/cache, never `self`. */
export function useRelayOperator(pubkey?: string) {
  const { relays, dmInboxRelays } = useNostr();
  const [profile, setProfile] = useState<NostrProfile | null>(null);
  const [verifiedNip05, setVerifiedNip05] = useState<string | null>(null);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      setProfile(null);
      setVerifiedNip05(null);
      if (pubkey)
        void (async () => {
          const cached = await profileCache.get(pubkey);
          if (!active) return;
          let fetched: NostrProfile | null = null;
          if (!cached) {
            const read = relays.filter((relay) => relay.read).map((relay) => relay.url);
            const targets = [
              ...new Set([
                ...(read.length ? read : enabledAppRelays('default', DEFAULT_RELAYS)),
                ...dmInboxRelays,
                ...PROFILE_RELAYS,
              ]),
            ];
            await fetchProfilesBatch(
              [pubkey],
              targets,
              10000,
              (event) => {
                fetched = slimDisplayProfile({
                  ...parseProfileContent(event.content),
                  pubkey,
                  npub: npubEncode(pubkey),
                });
              },
              false,
              controller.signal,
            );
          }
          const next: NostrProfile | null = cached
            ? {
                pubkey,
                npub: cached.npub ?? '',
                name: cached.name ?? null,
                displayName: cached.displayName ?? null,
                picture: cached.picture ?? null,
                nip05: cached.nip05 ?? null,
                banner: null,
                about: null,
                lud16: null,
              }
            : fetched;
          if (!active) return;
          setProfile(next);
          if (next && !cached)
            void profileCache
              .setMany(
                new Map([
                  [
                    pubkey,
                    {
                      npub: next.npub,
                      name: next.name,
                      displayName: next.displayName,
                      picture: next.picture,
                      nip05: next.nip05,
                    },
                  ],
                ]),
              )
              .catch(() => {});
          const identifier = next?.nip05;
          if (!identifier) return;
          const match = /^([^\s@]+)@([a-z0-9.-]+)$/i.exec(identifier);
          if (!match) return;
          timer = setTimeout(() => controller.abort(), 5000);
          try {
            const response = await fetch(
              `https://${match[2]}/.well-known/nostr.json?name=${encodeURIComponent(match[1])}`,
              { signal: controller.signal },
            );
            if (!response.ok) return;
            const value = await response.json();
            if (active && value?.names?.[match[1]]?.toLowerCase() === pubkey)
              setVerifiedNip05(identifier);
          } catch {
            /* optional identity verification */
          } finally {
            clearTimeout(timer);
          }
        })().catch(() => {});
      return () => {
        active = false;
        controller.abort();
        clearTimeout(timer);
      };
    }, [pubkey, relays, dmInboxRelays]),
  );
  return { profile, verifiedNip05 };
}
