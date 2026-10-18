import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useMarmotDeviceNotices } from './useMarmotDevices';
import { subscribeMarmotSession, type MarmotSession } from '../services/marmotSession';
import { loadDeviceNoticesEnabled } from '../services/deviceNoticesPreference';

jest.mock('@react-navigation/native', () => {
  const { useEffect } = jest.requireActual<typeof import('react')>('react');
  return { useFocusEffect: (effect: () => (() => void) | void) => useEffect(effect, [effect]) };
});
jest.mock('../services/marmotSession', () => ({ subscribeMarmotSession: jest.fn() }));
jest.mock('../services/deviceNoticesPreference', () => ({
  loadDeviceNoticesEnabled: jest.fn().mockResolvedValue(true),
  subscribeDeviceNoticesEnabled: () => () => undefined,
}));

beforeEach(() => jest.clearAllMocks());

function setup() {
  let clients: (string | null)[] = [null, null];
  let epoch = 2;
  let notify: (id: string) => void = () => undefined;
  const unsubscribe = jest.fn();
  const notices = jest.fn(async () => [{ id: 'notice', clients }]);
  const resolveClients = jest.fn(async () => {
    clients = ['Lightning Piggy', 'Lightning Piggy'];
    notify('chat');
    return true;
  });
  jest.mocked(subscribeMarmotSession).mockImplementation((fn) => {
    fn({
      devices: {
        notices,
        resolveClients,
        epochOf: () => epoch,
        subscribe: (listener: typeof notify) => {
          notify = listener;
          return unsubscribe;
        },
      },
    } as unknown as MarmotSession);
    return jest.fn();
  });
  return {
    notices,
    resolveClients,
    unsubscribe,
    notify: (id: string) => notify(id),
    advance: () => {
      epoch++;
      clients = [null, null];
      notify('chat');
    },
  };
}

it('resolves existing and newly received notice labels without opening the devices sheet', async () => {
  const t = setup();
  const { result, unmount } = renderHook(() => useMarmotDeviceNotices('chat'));
  await waitFor(() =>
    expect(result.current[0]?.clients).toEqual(['Lightning Piggy', 'Lightning Piggy']),
  );
  expect(t.resolveClients).toHaveBeenCalledWith('chat');
  expect(t.resolveClients).toHaveBeenCalledTimes(1);
  await act(async () => t.notify('other-chat'));
  expect(t.resolveClients).toHaveBeenCalledTimes(1);
  await act(async () => t.advance());
  await waitFor(() =>
    expect(result.current[0]?.clients).toEqual(['Lightning Piggy', 'Lightning Piggy']),
  );
  expect(t.resolveClients).toHaveBeenCalledTimes(2);
  unmount();
  expect(t.unsubscribe).toHaveBeenCalled();
});

it('does not look up labels when notices are disabled or there is no chat', async () => {
  const t = setup();
  jest.mocked(loadDeviceNoticesEnabled).mockResolvedValueOnce(false);
  const disabled = renderHook(() => useMarmotDeviceNotices('chat'));
  await act(async () => undefined);
  expect(t.notices).not.toHaveBeenCalled();
  disabled.unmount();
  renderHook(() => useMarmotDeviceNotices(null));
  await act(async () => undefined);
  expect(t.resolveClients).not.toHaveBeenCalled();
});
