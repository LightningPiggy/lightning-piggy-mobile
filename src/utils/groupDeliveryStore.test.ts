import { act, renderHook } from '@testing-library/react-native';
import {
  __resetGroupDeliveryStore,
  getGroupDeliveryStatus,
  groupRowDelivery,
  MAX_GROUP_DELIVERY_STATUSES,
  setGroupDeliveryStatus,
  settledGroupDelivery,
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

  it('marks a failed or partial send all-failed over the relays it tried', () => {
    expect(
      settledGroupDelivery({ success: false, delivery: sent({ a: 'ok', b: 'ok' }) }, {}),
    ).toMatchObject({ delivered: false, relayResults: { a: 'failed', b: 'failed' } });
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
