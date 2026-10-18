import { useAppRelayPrefs } from '../hooks/useAppRelayPrefs';
import { enabledAppRelays } from '../services/appRelayPrefs';
import { useEffect, useRef } from 'react';
import { AppState } from 'react-native';

import { Toast } from '../components/BrandedToast';
import { t } from '../i18n';
import { startMarmotPushRegistration } from '../services/marmotPushRegistration';
import { getMarmotSession, MarmotSession, setMarmotSession } from '../services/marmotSession';
import { DEFAULT_RELAYS } from '../services/nostrService';
import { RELAY_LIST_INDEXERS } from '../utils/relayListEvents';
import { useNostr } from './NostrContext';

// Defer the MLS bring-up past cold start: loading group state + opening one
// relay sub per group is real JS-thread work, and nothing on first paint
// needs it (#perf: stagger non-latency-sensitive startup work).
const START_DELAY_MS = 3_000;

/**
 * Owns the Marmot (MLS) session lifecycle: one session per signed-in
 * account, started after cold start, torn down on sign-out / account
 * switch / signer change. Renders nothing. Relays are read through refs so
 * a relay-list edit doesn't tear down live MLS state.
 */
export function MarmotBridge(): null {
  const { isLoggedIn, pubkey, signerType, relays } = useNostr();
  const relayScope = useAppRelayPrefs();
  const relaysRef = useRef(relays);
  relaysRef.current = relays;

  // Opt-in Marmot push (MIP-05): one device token, opted into per account —
  // each session only carries it if its own account turned push on.
  // Staggered like the session itself — nothing on first paint needs it.
  useEffect(() => {
    let stop: (() => void) | null = null;
    const timer = setTimeout(() => (stop = startMarmotPushRegistration()), START_DELAY_MS);
    return () => {
      clearTimeout(timer);
      stop?.();
    };
  }, []);

  // Android can keep the process alive for weeks: re-check the weekly key
  // package refresh on resume (#1210) — staggered, it's not latency-sensitive.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const sub = AppState.addEventListener('change', (state) => {
      if (timer) clearTimeout(timer);
      timer =
        state === 'active'
          ? setTimeout(
              () =>
                void getMarmotSession()
                  ?.keepKeyPackageFresh()
                  .catch(() => undefined),
              START_DELAY_MS,
            )
          : null;
    });
    return () => {
      if (timer) clearTimeout(timer);
      sub.remove();
    };
  }, []);

  useEffect(() => {
    if (!isLoggedIn || !pubkey || !signerType) return;
    const unique = (urls: string[]) => [...new Set(urls)];
    const writeRelays = () => {
      const own = relaysRef.current.filter((r) => r.write).map((r) => r.url);
      return own.length > 0 ? own : enabledAppRelays('default', DEFAULT_RELAYS, pubkey);
    };
    const lookupRelays = () =>
      unique([
        ...relaysRef.current.filter((r) => r.read).map((r) => r.url),
        ...enabledAppRelays('indexers', RELAY_LIST_INDEXERS, pubkey),
        ...enabledAppRelays('default', DEFAULT_RELAYS, pubkey),
      ]);

    let session: MarmotSession | null = null;
    const timer = setTimeout(() => {
      session = new MarmotSession({
        pubkey,
        signerType,
        getWriteRelays: writeRelays,
        getLookupRelays: lookupRelays,
      });
      setMarmotSession(session);
      // Amber / NIP-46 ask once per invited device: say how far along we are.
      if (signerType !== 'nsec') {
        session.subscribe({
          onInviteProgress: ({ done, total }) => {
            if (total < 2) return;
            Toast.show({
              type: 'info',
              text1: t('marmotInvite.progressTitle', { done, total }),
              text2: t('marmotInvite.progressBody'),
            });
          },
        });
      }
      session.start().catch((e) => {
        if (__DEV__) console.warn('[Marmot] session start failed:', e);
      });
    }, START_DELAY_MS);

    return () => {
      clearTimeout(timer);
      if (session) setMarmotSession(null);
    };
  }, [isLoggedIn, pubkey, signerType]);

  useEffect(() => {
    const session = getMarmotSession();
    if (session?.pubkey === pubkey) session.refreshRelaySubscriptions();
  }, [pubkey, relays, relayScope]);

  return null;
}
