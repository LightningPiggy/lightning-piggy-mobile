import { act, renderHook } from '@testing-library/react-native';
import {
  __resetGroupDeliveryStore,
  getGroupDeliveryStatus,
  groupRowDelivery,
  MAX_GROUP_DELIVERY_STATUSES,
  setGroupDeliveryStatus,
  settledGroupDelivery,
  trackGroupDelivery,
  useGroupDeliveryStatuses,
} from './groupDeliveryStore';
import { pendingDelivery, type DeliveryStatus } from './dmDeliveryStatus';

beforeEach(() => __resetGroupDeliveryStore());

const sent = (relayResults: DeliveryStatus['relayResults']): DeliveryStatus => ({
  delivered: Object.values(relayResults).includes('ok'),
  relayResults,
  targetRelayCount: Object.keys(relayResults).length,
});

describe('settledGroupDelivery', () => {
  it('keeps the per-relay result of a successful send and clears pending', () => {
    const status = settledGroupDelivery(
      { success: true, delivery: { ...sent({ a: 'ok', b: 'failed' }), pending: true } },
      { eventId: 'e1', kind: 14 },
    );
    expect(status).toMatchObject({
      delivered: true,
      relayResults: { a: 'ok', b: 'failed' },
      eventId: 'e1',
      kind: 14,
    });
    expect(status.pending).toBeUndefined();
  });

  it('preserves accepted relay outcomes while marking a partial send failed', () => {
    expect(
      settledGroupDelivery({ success: false, delivery: sent({ a: 'ok', b: 'ok' }) }, {}),
    ).toMatchObject({ sendFailed: true, relayResults: { a: 'ok', b: 'ok' } });
    expect(
      settledGroupDelivery({ success: false }, { eventId: 'e2', relays: ['x'] }),
    ).toMatchObject({ delivered: false, relayResults: { x: 'failed' }, eventId: 'e2' });
  });
});

describe('group delivery store', () => {
  it('never moves a settled send back to pending, and notifies subscribers', () => {
    const { result } = renderHook(() => useGroupDeliveryStatuses());
    act(() => setGroupDeliveryStatus('local_1', pendingDelivery({ eventId: 'e' })));
    expect(result.current.get('local_1')?.pending).toBe(true);
    const settled = sent({ a: 'ok' });
    act(() => setGroupDeliveryStatus('local_1', settled));
    expect(result.current.get('local_1')).toBe(settled);
    act(() => setGroupDeliveryStatus('local_1', pendingDelivery()));
    expect(getGroupDeliveryStatus('local_1')).toBe(settled);
  });

  it('drops the oldest entries past the cap', () => {
    for (let i = 0; i <= MAX_GROUP_DELIVERY_STATUSES; i++) {
      setGroupDeliveryStatus(`local_${i}`, sent({ a: 'ok' }));
    }
    expect(getGroupDeliveryStatus('local_0')).toBeUndefined();
    expect(getGroupDeliveryStatus(`local_${MAX_GROUP_DELIVERY_STATUSES}`)).toBeDefined();
  });
});

describe('groupRowDelivery', () => {
  it('finds the status by the optimistic id a re-keyed / echo-replaced row keeps', () => {
    const status = sent({ a: 'ok' });
    const statuses = new Map([['local_1', status]]);
    expect(groupRowDelivery({ id: 'real', localId: 'local_1' }, statuses)).toBe(status);
    expect(groupRowDelivery({ id: 'local_1' }, statuses)).toBe(status);
  });

  it('falls back to the persisted failed mark, else untracked', () => {
    const failed = groupRowDelivery({ id: 'local_9', sendFailed: true }, new Map());
    expect(failed).toMatchObject({ delivered: false });
    expect(failed?.pending).toBeFalsy();
    expect(groupRowDelivery({ id: 'old' }, new Map())).toBeUndefined();
  });
});

it.each([true, false])('retains final relay results when final arrives first: %s', (finalFirst) => {
  for (const success of [true, false]) {
    const id = `local_${success}`;
    const tracker = trackGroupDelivery(id, { eventId: 'rumor', relays: ['a', 'b'] });
    const final = sent({ a: 'ok', b: 'ok' });
    if (finalFirst) tracker.finalize(final);
    tracker.settle({ success, delivery: sent({ a: 'ok' }) });
    if (!finalFirst) tracker.finalize(final);
    expect(getGroupDeliveryStatus(id)).toMatchObject({
      relayResults: { a: 'ok', b: 'ok' },
      sendFailed: !success,
      eventId: 'rumor',
    });
  }
});

it('keeps an in-flight send pending beyond the old watchdog deadline', () => {
  jest.useFakeTimers();
  try {
    trackGroupDelivery('local_slow', {});
    jest.advanceTimersByTime(60_000);
    expect(getGroupDeliveryStatus('local_slow')?.pending).toBe(true);
  } finally {
    jest.useRealTimers();
  }
});
