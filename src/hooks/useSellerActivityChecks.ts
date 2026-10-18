import { enabledAppRelays } from '../services/appRelayPrefs';
import { useCallback, useEffect, useMemo } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from '@react-navigation/native';
import { useNostr, useNostrContacts } from '../contexts/NostrContext';
import { useGroups } from '../contexts/GroupsContext';
import { useTranslation } from '../contexts/LocaleContext';
import { DEFAULT_RELAYS } from '../services/nostrService';
import { checkSellerActivity } from '../services/sellerActivityService';

/** One-shot reads only. Mounted once for resume, separately on Notifications focus. */
export function useSellerActivityChecks(mode: 'resume' | 'focus') {
  const { pubkey, relays } = useNostr();
  const { contacts } = useNostrContacts();
  const { effectiveWotTier } = useGroups();
  const t = useTranslation();
  const friends = useMemo(
    () =>
      new Map(
        contacts.map((c) => [
          c.pubkey,
          c.profile?.displayName || c.profile?.name || c.petname || c.pubkey.slice(0, 12),
        ]),
      ),
    [contacts],
  );
  const urls = useMemo(() => {
    const configured = relays.filter((r) => r.read || r.write).map((r) => r.url);
    return [
      ...new Set(configured.length ? configured : enabledAppRelays('default', DEFAULT_RELAYS)),
    ].slice(0, 8);
  }, [relays]);
  const check = useCallback(
    (signal: AbortSignal) => {
      if (!pubkey) return;
      void checkSellerActivity({
        owner: pubkey,
        relays: urls,
        friends,
        onlyFriends: effectiveWotTier !== 'all',
        t,
        signal,
      }).catch(() => {});
    },
    [pubkey, urls, friends, effectiveWotTier, t],
  );
  useFocusEffect(
    useCallback(() => {
      if (mode !== 'focus') return;
      const controller = new AbortController();
      check(controller.signal);
      return () => controller.abort();
    }, [mode, check]),
  );
  useEffect(() => {
    if (mode !== 'resume') return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    const sub = AppState.addEventListener('change', (state) => {
      clearTimeout(timer);
      controller?.abort();
      if (state === 'active')
        timer = setTimeout(() => {
          controller = new AbortController();
          check(controller.signal);
        }, 3500);
    });
    return () => {
      clearTimeout(timer);
      controller?.abort();
      sub.remove();
    };
  }, [mode, check]);
}
