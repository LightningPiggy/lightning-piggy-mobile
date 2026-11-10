import { useSyncExternalStore } from 'react';

import {
  getMarmotUnsavedStateSnapshot,
  subscribeMarmotUnsavedState,
} from '../services/marmotUnsavedStateStore';

/** Whether `owner`'s Marmot chat `chatId` (MLS group id hex) couldn't save
 * its latest group state on this device (#1754) — always false for any
 * other account. */
export function useMarmotUnsavedState(owner: string | null, chatId: string | null): boolean {
  const snapshot = useSyncExternalStore(subscribeMarmotUnsavedState, getMarmotUnsavedStateSnapshot);
  return !!owner && !!chatId && snapshot.owner === owner && snapshot.chatIds.has(chatId);
}
