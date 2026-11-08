// The members sheet's invite status (#1402), against a real MarmotSession:
// a queued Welcome for the chat shows up, whichever id form the sheet has,
// and a change in the chat's queues reloads it.
import { renderHook, waitFor } from '@testing-library/react-native';

import { setMarmotSession, toAppGroupId } from '../services/marmotSession';
import { makeRelay, makeSession } from '../services/marmotSessionTestKit';
import type { MarmotKvBackend } from '../services/marmotStore';
import { useMarmotPendingInvites } from './useMarmotDevices';

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (effect: () => void) => jest.requireActual('react').useEffect(effect, [effect]),
}));

const MLS = 'ab'.repeat(32);
const LITTLE = 'cd'.repeat(32);
const MIDDLE = 'ef'.repeat(32);

/** A Welcome waiting in the session's unsigned queue for `invitee`. */
const queue = (backend: MarmotKvBackend, invitee: string, reason?: string) =>
  backend.set(
    'welcomePayloads',
    `${MLS}:${invitee}`,
    JSON.stringify({
      groupId: MLS,
      keyPackage: { id: invitee, pubkey: invitee },
      rumor: {},
      relays: [],
      queuedAt: Math.floor(Date.now() / 1000),
      ...(reason ? { reason } : {}),
    }),
  );

let alice: ReturnType<typeof makeSession>;
beforeEach(() => {
  alice = makeSession(makeRelay());
  setMarmotSession(alice.session);
});
afterEach(() => setMarmotSession(null));

it.each([
  ['raw MLS id (as the members sheet has it)', MLS],
  ['app id', toAppGroupId(MLS)],
])('shows a queued invitation for the chat by its %s', async (_label, chatId) => {
  await queue(alice.backend, LITTLE, 'noRelays');
  const { result } = renderHook(() => useMarmotPendingInvites(chatId, true));
  await waitFor(() => expect(result.current).toEqual(new Map([[LITTLE, 'waitingForRelays']])));
});

it("reloads when the chat's invitation queues change", async () => {
  await queue(alice.backend, LITTLE, 'noRelays');
  const { result } = renderHook(() => useMarmotPendingInvites(MLS, true));
  await waitFor(() => expect(result.current?.get(LITTLE)).toBe('waitingForRelays'));
  await queue(alice.backend, MIDDLE);
  const outbox = (alice.session as unknown as { outbox: { changes: { notify(id: string): void } } })
    .outbox;
  outbox.changes.notify(MLS);
  await waitFor(() =>
    expect(result.current).toEqual(
      new Map([
        [LITTLE, 'waitingForRelays'],
        [MIDDLE, 'pending'],
      ]),
    ),
  );
});

it('reads nothing while the sheet is closed', () => {
  const { result } = renderHook(() => useMarmotPendingInvites(MLS, false));
  expect(result.current).toBeNull();
});
