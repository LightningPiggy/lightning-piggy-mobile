import { useSyncExternalStore } from 'react';
import { appRelayPrefsRevision, subscribeAppRelayPrefs } from '../services/appRelayPrefs';
import { getCurrentUserPubkey, onCurrentUserPubkeyChange } from '../services/nostrActiveAccount';

const subscribe = (listener: () => void) => {
  const offPrefs = subscribeAppRelayPrefs(listener);
  const offAccount = onCurrentUserPubkeyChange(listener);
  return () => {
    offPrefs();
    offAccount();
  };
};
const snapshot = () => `${getCurrentUserPubkey() ?? ''}:${appRelayPrefsRevision()}`;

/** Invalidates captured app-relay plans on account switches, hydration and edits. */
export function useAppRelayPrefs() {
  return useSyncExternalStore(subscribe, snapshot);
}
