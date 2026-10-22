import {
  deliverySheetTitle,
  aggregateRelayResults,
  summariseDelivery,
  shortRelayLabel,
  pendingDelivery,
  failedDelivery,
  type RelaySettle,
} from './dmDeliveryStatus';

describe('aggregateRelayResults', () => {
  it('marks all relays ok when every wrap landed everywhere', () => {
    const settles: RelaySettle[] = [
      { relay: 'wss://a', ok: true },
      { relay: 'wss://b', ok: true },
      // self-copy wrap to the same relays
      { relay: 'wss://a', ok: true },
      { relay: 'wss://b', ok: true },
    ];
    const status = aggregateRelayResults(settles);
    expect(status.delivered).toBe(true);
    expect(status.relayResults).toEqual({ 'wss://a': 'ok', 'wss://b': 'ok' });
  });

  it('marks a relay ok if it accepted at least one wrap (partial across wraps)', () => {
    const settles: RelaySettle[] = [
      // recipient wrap landed on a, failed on b
      { relay: 'wss://a', ok: true },
      { relay: 'wss://b', ok: false },
      // self-copy failed on a, landed on b
      { relay: 'wss://a', ok: false },
      { relay: 'wss://b', ok: true },
    ];
    const status = aggregateRelayResults(settles);
    expect(status.delivered).toBe(true);
    expect(status.relayResults).toEqual({ 'wss://a': 'ok', 'wss://b': 'ok' });
  });

  it('reports a partial delivery when some relays never accepted', () => {
    const settles: RelaySettle[] = [
      { relay: 'wss://good', ok: true },
      { relay: 'wss://bad', ok: false },
      { relay: 'wss://good', ok: true },
      { relay: 'wss://bad', ok: false },
    ];
    const status = aggregateRelayResults(settles);
    expect(status.delivered).toBe(true);
    expect(status.relayResults).toEqual({ 'wss://good': 'ok', 'wss://bad': 'failed' });
    expect(summariseDelivery(status)).toEqual({ ok: 1, total: 2 });
  });

  it('reports not delivered when every relay rejected every wrap', () => {
    const settles: RelaySettle[] = [
      { relay: 'wss://a', ok: false },
      { relay: 'wss://b', ok: false },
      { relay: 'wss://a', ok: false },
      { relay: 'wss://b', ok: false },
    ];
    const status = aggregateRelayResults(settles);
    expect(status.delivered).toBe(false);
    expect(status.relayResults).toEqual({ 'wss://a': 'failed', 'wss://b': 'failed' });
    expect(summariseDelivery(status)).toEqual({ ok: 0, total: 2 });
  });

  it('handles an empty settle list as undelivered with no relays', () => {
    const status = aggregateRelayResults([]);
    expect(status.delivered).toBe(false);
    expect(status.relayResults).toEqual({});
    expect(summariseDelivery(status)).toEqual({ ok: 0, total: 0 });
  });

  it('does not let a later failure downgrade a proven ok regardless of order', () => {
    const settles: RelaySettle[] = [
      { relay: 'wss://a', ok: true },
      { relay: 'wss://a', ok: false },
    ];
    expect(aggregateRelayResults(settles).relayResults).toEqual({ 'wss://a': 'ok' });
  });

  it('carries the optional event metadata (eventId + kind) onto the status', () => {
    const status = aggregateRelayResults([{ relay: 'wss://a', ok: true }], {
      eventId: 'abc123',
      kind: 14,
    });
    expect(status.eventId).toBe('abc123');
    expect(status.kind).toBe(14);
  });

  it('leaves event metadata undefined when no meta is supplied', () => {
    const status = aggregateRelayResults([{ relay: 'wss://a', ok: true }]);
    expect(status.eventId).toBeUndefined();
    expect(status.kind).toBeUndefined();
  });
});

describe('summariseDelivery', () => {
  it('counts ok relays out of the total tracked', () => {
    const status = aggregateRelayResults([
      { relay: 'wss://a', ok: true },
      { relay: 'wss://b', ok: true },
      { relay: 'wss://c', ok: false },
    ]);
    expect(summariseDelivery(status)).toEqual({ ok: 2, total: 3 });
  });

  it('uses the attempted relay count as total when only the fast relay settled', () => {
    // Early snapshot: 1 ack recorded, but the send targeted 5 relays. `total`
    // must be 5 so the tick reads "1 of 5" (single), not "1 of 1" (premature
    // double). This is the #866 fix at the pure-function level.
    const status = aggregateRelayResults([{ relay: 'wss://fast', ok: true }], undefined, 5);
    expect(summariseDelivery(status)).toEqual({ ok: 1, total: 5 });
  });

  it('reads ok === total (double tick) only once every target relay acked', () => {
    const status = aggregateRelayResults(
      [
        { relay: 'wss://a', ok: true },
        { relay: 'wss://b', ok: true },
      ],
      undefined,
      2,
    );
    expect(summariseDelivery(status)).toEqual({ ok: 2, total: 2 });
  });

  it('never reports fewer relays than have settled if the target undercounts', () => {
    // Defensive: a stale/wrong target smaller than the settled set must not hide
    // relays — total floors at the number actually settled.
    const status = aggregateRelayResults(
      [
        { relay: 'wss://a', ok: true },
        { relay: 'wss://b', ok: true },
        { relay: 'wss://c', ok: false },
      ],
      undefined,
      1,
    );
    expect(summariseDelivery(status)).toEqual({ ok: 2, total: 3 });
  });

  it('falls back to the settled-relay count when no target is supplied (legacy rows)', () => {
    const status = aggregateRelayResults([
      { relay: 'wss://a', ok: true },
      { relay: 'wss://b', ok: false },
    ]);
    expect(summariseDelivery(status)).toEqual({ ok: 1, total: 2 });
  });
});

describe('pendingDelivery / failedDelivery relay seeding (missing-relays fix)', () => {
  it('seeds the pending status with the target relays so the info sheet lists them', () => {
    const status = pendingDelivery({ eventId: 'e', kind: 14, relays: ['wss://a', 'wss://b'] });
    expect(status.pending).toBe(true);
    expect(status.relayResults).toEqual({ 'wss://a': 'failed', 'wss://b': 'failed' });
    expect(status.targetRelayCount).toBe(2);
  });

  it('seeds the failed status with the attempted relays (not an empty breakdown)', () => {
    const status = failedDelivery({ eventId: 'e', kind: 14, relays: ['wss://a', 'wss://b'] });
    expect(status.pending).toBeUndefined();
    expect(status.delivered).toBe(false);
    expect(status.relayResults).toEqual({ 'wss://a': 'failed', 'wss://b': 'failed' });
    expect(summariseDelivery(status)).toEqual({ ok: 0, total: 2 });
  });

  it('leaves the breakdown empty when no relays are supplied (legacy / pre-publish error)', () => {
    expect(pendingDelivery({ eventId: 'e' }).relayResults).toEqual({});
    expect(failedDelivery({ eventId: 'e' }).relayResults).toEqual({});
    expect(pendingDelivery().targetRelayCount).toBeUndefined();
  });
});

describe('shortRelayLabel', () => {
  it('strips the scheme and trailing slash', () => {
    expect(shortRelayLabel('wss://relay.damus.io/')).toBe('relay.damus.io');
    expect(shortRelayLabel('ws://localhost:7777')).toBe('localhost:7777');
    expect(shortRelayLabel('relay.example.com')).toBe('relay.example.com');
  });
});

describe('deliverySheetTitle', () => {
  it('titles a received message "message received" regardless of status', () => {
    expect(deliverySheetTitle('received', undefined)).toEqual({ key: 'messageReceived' });
    // A received row never carries a real status today, but the contract is
    // that direction wins — even a populated status must not flip the title.
    expect(deliverySheetTitle('received', failedDelivery({ eventId: 'e' }))).toEqual({
      key: 'messageReceived',
    });
  });

  it('titles an UNTRACKED sent message "message sent", never "send failed"', () => {
    // Group sends (and 1:1 rows predating tracking) carry no DeliveryStatus at
    // all. The bubble only exists because the publish succeeded, so the sheet
    // must not claim failure — the regression behind the "Send failed /
    // Not tracked" dialog on every sent group message.
    expect(deliverySheetTitle('sent', undefined)).toEqual({ key: 'messageSent' });
  });

  it('titles an in-flight send with seeded relays "sending to N relays"', () => {
    const status = pendingDelivery({ relays: ['wss://a', 'wss://b'] });
    expect(deliverySheetTitle('sent', status)).toEqual({ key: 'sendingToRelays', total: 2 });
  });

  it('titles an in-flight send with no relay list plain "sending"', () => {
    expect(deliverySheetTitle('sent', pendingDelivery({ eventId: 'e' }))).toEqual({
      key: 'sending',
    });
  });

  it('reserves "send failed" for a TRACKED settled send with an empty breakdown', () => {
    expect(deliverySheetTitle('sent', failedDelivery({ eventId: 'e' }))).toEqual({
      key: 'sendFailed',
    });
  });

  it('titles a settled tracked send with the ok/total relay breakdown', () => {
    const status = aggregateRelayResults(
      [
        { relay: 'wss://a', ok: true },
        { relay: 'wss://b', ok: false },
      ],
      undefined,
      2,
    );
    expect(deliverySheetTitle('sent', status)).toEqual({ key: 'sentToRelays', ok: 1, total: 2 });
  });
});

it('labels failed group fan-out separately from accepted relay outcomes', () => {
  const status = {
    ...aggregateRelayResults([{ relay: 'wss://accepted', ok: true }]),
    sendFailed: true,
  };
  expect(deliverySheetTitle('sent', status)).toEqual({ key: 'sendFailed' });
  expect(summariseDelivery(status)).toEqual({ ok: 1, total: 1 });
});
