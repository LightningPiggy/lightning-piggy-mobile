// React side of a person's devices in a Marmot chat (#1267). Three hooks, each
// as lazy as its surface allows (CLAUDE.md performance rules):
//   - useMarmotChatDevices: the chat's id + per-person device COUNTS for the
//     header by-line and the members sheet subtitles. Only while the screen
//     is focused, and only re-read when the chat's epoch moves (a commit) or
//     a chat appears — never per message.
//   - useMarmotDeviceDetails: the full device list (apps, times, epochs), read
//     only while a sheet that shows it is open; opening it also runs the
//     bounded relay lookup that names unknown apps.
//   - useMarmotDeviceNotices: the alpha-only "joined on N devices" lines,
//     behind the developer switch.
// All three follow the active session (account switch, sign-in) and ignore a
// slower, older read that finishes after a newer one.

import { useCallback, useEffect, useState } from 'react';
import { useFocusEffect } from '@react-navigation/native';

import {
  loadDeviceNoticesEnabled,
  subscribeDeviceNoticesEnabled,
} from '../services/deviceNoticesPreference';
import type { DeviceNoticeView, GroupDevices } from '../services/marmotDeviceTracker';
import {
  MARMOT_GROUP_ID_PREFIX,
  subscribeMarmotSession,
  type MarmotSession,
} from '../services/marmotSession';

/** A Marmot chat: an app group id (`marmot:…`), or the 1:1 with `peer`. */
export interface MarmotChatRef {
  groupId?: string | null;
  peer?: string | null;
}

export interface MarmotChatDevices {
  /** The chat's MLS group id (hex); null if it isn't a loaded Marmot chat. */
  chatId: string | null;
  /** Person (lower-case pubkey) → device count. */
  counts: ReadonlyMap<string, number> | null;
}

const NO_CHAT: MarmotChatDevices = { chatId: null, counts: null };
const NO_NOTICES: DeviceNoticeView[] = [];

function chatIdFor(session: MarmotSession, ref: MarmotChatRef): string | null {
  const appId = ref.groupId ?? (ref.peer ? session.findDm(ref.peer)?.id : undefined);
  return appId?.startsWith(MARMOT_GROUP_ID_PREFIX)
    ? appId.slice(MARMOT_GROUP_ID_PREFIX.length)
    : null;
}

/**
 * Run `bind(session)` for the active session while mounted, re-binding when
 * the session changes (its cleanup runs first). No session → nothing bound.
 */
function useActiveSession(
  bind: (session: MarmotSession) => (() => void) | void,
  onNoSession: () => void,
): void {
  useEffect(() => {
    let cleanup: (() => void) | void;
    const unsubscribe = subscribeMarmotSession((session) => {
      cleanup?.();
      cleanup = undefined;
      if (session) cleanup = bind(session);
      else onNoSession();
    });
    return () => {
      unsubscribe();
      cleanup?.();
    };
  }, [bind, onNoSession]);
}

/** The chat's id and device counts, kept current while the screen is focused. */
export function useMarmotChatDevices(
  ref: MarmotChatRef,
  owner: string | null | undefined,
): MarmotChatDevices {
  const [state, setState] = useState(NO_CHAT);
  const { groupId, peer } = ref;
  useFocusEffect(
    useCallback(() => {
      if (!owner || (!groupId && !peer)) {
        setState(NO_CHAT);
        return;
      }
      let unsubscribeGroups: (() => void) | null = null;
      const unsubscribeSession = subscribeMarmotSession((session) => {
        unsubscribeGroups?.();
        unsubscribeGroups = null;
        if (!session || session.pubkey !== owner) {
          setState(NO_CHAT);
          return;
        }
        // Re-read only when a chat appears (a 1:1's newest group can change)
        // or this chat's epoch moves. Every message also fires "groups
        // changed" (the secret tree moves); those cost two cheap reads.
        // Re-read only when it could have changed: this chat's epoch moved
        // (a commit) or a chat appeared — and, while there's no chat yet,
        // when any group's epoch moved (a new 1:1 becomes findable once its
        // invite commit lands). Every message also fires "groups changed"
        // (the secret tree moves); those cost a couple of cheap reads.
        let last: { chatId: string | null; key: string } | null = null;
        // A 1:1 can be replaced by a newer DM group, which becomes findable
        // only after its invite commit — so a peer chat watches every group's
        // epoch; an app group just its own.
        const keyFor = (chatId: string | null) =>
          chatId && !peer
            ? `${session.devices.groupCount()}|${session.devices.epochOf(chatId)}`
            : session.devices.epochsKey();
        const update = () => {
          if (last && keyFor(last.chatId) === last.key) return;
          const chatId = chatIdFor(session, { groupId, peer });
          last = { chatId, key: keyFor(chatId) };
          // Same epoch → the tracker hands back the same Map: no re-render.
          const counts = chatId ? session.devices.counts(chatId) : null;
          setState((prev) =>
            prev.chatId === chatId && prev.counts === counts ? prev : { chatId, counts },
          );
        };
        update();
        unsubscribeGroups = session.subscribe({ onGroupsChanged: update });
      });
      return () => {
        unsubscribeSession();
        unsubscribeGroups?.();
      };
    }, [owner, groupId, peer]),
  );
  return state;
}

/**
 * Every device in the chat with its app, key time and epoch — loaded only
 * while `enabled` (the sheet showing it is open). Opening also starts the
 * bounded relay lookup for apps we don't know yet; the list refreshes when
 * it finds any, and when a commit changes the chat.
 */
export function useMarmotDeviceDetails(
  chatId: string | null,
  enabled: boolean,
): GroupDevices | null {
  const [devices, setDevices] = useState<{ chatId: string; view: GroupDevices } | null>(null);
  const bind = useCallback(
    (session: MarmotSession) => {
      // A new session / chat / opening never shows the previous one's list.
      setDevices(null);
      if (!enabled || !chatId) return;
      let live = true;
      let latest = 0;
      let loadedEpoch: number | null = null;
      const load = () => {
        const request = ++latest;
        loadedEpoch = session.devices.epochOf(chatId);
        session.devices
          .devices(chatId)
          .then((view) => {
            // Only the newest read counts: an older, slower one is stale.
            // Null = the chat is gone (left, unloaded): stop showing it.
            if (live && request === latest) setDevices(view ? { chatId, view } : null);
          })
          .catch(() => undefined);
      };
      load();
      void session.devices.resolveClients(chatId).catch(() => false);
      const unsubscribeTracker = session.devices.subscribe((id) => {
        if (id === chatId) load();
      });
      const unsubscribeGroups = session.subscribe({
        onGroupsChanged: () => {
          if (session.devices.epochOf(chatId) !== loadedEpoch) load();
        },
      });
      return () => {
        live = false;
        unsubscribeTracker();
        unsubscribeGroups();
      };
    },
    [chatId, enabled],
  );
  const clear = useCallback(() => setDevices(null), []);
  useActiveSession(bind, clear);
  return devices && devices.chatId === chatId ? devices.view : null;
}

/** Whether the "Show device changes in chats" developer switch is on. */
export function useDeviceNoticesEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    void loadDeviceNoticesEnabled().then((v) => {
      if (live) setEnabled(v);
    });
    const unsubscribe = subscribeDeviceNoticesEnabled(setEnabled);
    return () => {
      live = false;
      unsubscribe();
    };
  }, []);
  return enabled;
}

/** The chat's alpha-only device notices (empty when the switch is off). */
export function useMarmotDeviceNotices(chatId: string | null): DeviceNoticeView[] {
  const enabled = useDeviceNoticesEnabled();
  const [notices, setNotices] = useState<{ chatId: string; list: DeviceNoticeView[] } | null>(null);
  useFocusEffect(
    useCallback(() => {
      if (!enabled || !chatId) return;
      let cleanup: (() => void) | undefined;
      const unsubscribeSession = subscribeMarmotSession((session) => {
        cleanup?.();
        cleanup = undefined;
        if (!session) {
          setNotices(null);
          return;
        }
        let live = true;
        let latest = 0;
        let resolvedEpoch: number | null | undefined;
        const load = () => {
          const request = ++latest;
          session.devices
            .notices(chatId)
            .then((list) => {
              if (live && request === latest) setNotices({ chatId, list });
            })
            .catch(() => undefined);
          // An incoming Add carries leaves, not the key packages whose client
          // tags name the apps. This includes our account's OTHER installs.
          // Resolve on open / a new epoch, just as the device sheet does. A
          // learned-name notification must only re-read, never query again.
          const epoch = session.devices.epochOf(chatId);
          if (epoch !== resolvedEpoch) {
            resolvedEpoch = epoch;
            void session.devices.resolveClients(chatId).catch(() => false);
          }
        };
        // Subscribe before resolving: even an immediate result must re-render
        // existing notices, whose labels are read from the key cache each time.
        const unsubscribe = session.devices.subscribe((id) => {
          if (id === chatId) load();
        });
        load();
        cleanup = () => {
          live = false;
          unsubscribe();
        };
      });
      return () => {
        unsubscribeSession();
        cleanup?.();
      };
    }, [chatId, enabled]),
  );
  return enabled && notices && notices.chatId === chatId && notices.list.length > 0
    ? notices.list
    : NO_NOTICES;
}
