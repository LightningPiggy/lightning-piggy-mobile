import { publishWrapsTrackingRelays, type RelayPublisher } from './nostrDmPublish';
import type { VerifiedEvent } from 'nostr-tools/pure';
import { summariseDelivery, type DeliveryStatus } from '../utils/dmDeliveryStatus';

// A fake wrap — only its identity matters to the pool stub.
const wrap = (id: string) => ({ id }) as unknown as VerifiedEvent;

// Deferred promise helper so a test can control exactly when a relay settles.
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('publishWrapsTrackingRelays — early-resolve + background settle (#857)', () => {
  it('resolves the send as soon as ONE relay accepts, not waiting for the slow one', async () => {
    const fast = deferred<string>();
    const slow = deferred<string>();
    const pool: RelayPublisher = {
      publish: () => [fast.promise, slow.promise],
    };
    const sendPromise = publishWrapsTrackingRelays(
      [wrap('w1')],
      ['wss://fast', 'wss://slow'],
      pool,
    );

    // Fast relay accepts; slow one is still in flight.
    fast.resolve('ok');
    const result = await sendPromise;

    // The send resolved without `slow` having settled — proves it didn't block.
    expect(result.wrapsPublished).toBe(1);
    expect(result.delivery.relayResults['wss://fast']).toBe('ok');
    // Clean up the dangling slow promise.
    slow.resolve('ok');
  });

  it('settles single → double: onFinalized fires with the complete breakdown', async () => {
    const fast = deferred<string>();
    const slow = deferred<string>();
    const pool: RelayPublisher = {
      publish: () => [fast.promise, slow.promise],
    };
    let finalized: DeliveryStatus | null = null;
    const sendPromise = publishWrapsTrackingRelays(
      [wrap('w1')],
      ['wss://fast', 'wss://slow'],
      pool,
      { eventId: 'rumor-1', kind: 14 },
      (d) => {
        finalized = d;
      },
    );

    fast.resolve('ok');
    const early = await sendPromise;
    // Early snapshot: only the fast relay landed, but `total` is the ATTEMPTED
    // relay count (2), so this reads "1 of 2" → single tick, NOT a premature
    // double (which "1 of 1" would have painted while the slow relay is still
    // in flight). This is the regression #866 guards against.
    expect(summariseDelivery(early.delivery)).toEqual({ ok: 1, total: 2 });

    // Now the slow relay acks; the background finalize fires with BOTH relays.
    slow.resolve('ok');
    await new Promise((r) => setTimeout(r, 0));
    expect(finalized).not.toBeNull();
    expect(summariseDelivery(finalized as unknown as DeliveryStatus)).toEqual({ ok: 2, total: 2 });
    expect((finalized as unknown as DeliveryStatus).eventId).toBe('rumor-1');
  });

  it('does not paint a premature double-tick when one of many relays acks first', async () => {
    // 1 fast ack, 3 relays still in flight. The early snapshot must report the
    // FULL target count as `total` (4), so the tick is single ("1 of 4"), not a
    // double — partial coverage must not masquerade as full delivery (#866).
    const fast = deferred<string>();
    const inFlight = () => new Promise<string>(() => {});
    const pool: RelayPublisher = {
      publish: () => [fast.promise, inFlight(), inFlight(), inFlight()],
    };
    const sendPromise = publishWrapsTrackingRelays(
      [wrap('w1')],
      ['wss://fast', 'wss://b', 'wss://c', 'wss://d'],
      pool,
    );
    fast.resolve('ok');
    const early = await sendPromise;
    expect(summariseDelivery(early.delivery)).toEqual({ ok: 1, total: 4 });
    // Only the fast relay has a known result; the other three are absent until
    // they settle — but `total` already reflects all four attempted relays.
    expect(early.delivery.relayResults).toEqual({ 'wss://fast': 'ok' });
    expect(early.delivery.targetRelayCount).toBe(4);
  });

  it('reports total as the attempted count even when a relay never settles', async () => {
    // fast acks, slow hangs forever and finalize never fires — the tick must
    // stay "1 of 2" (single), never strand at a wrong "all relays" state.
    const fast = deferred<string>();
    const neverSettles = new Promise<string>(() => {});
    const pool: RelayPublisher = { publish: () => [fast.promise, neverSettles] };
    let finalized: DeliveryStatus | null = null;
    const sendPromise = publishWrapsTrackingRelays(
      [wrap('w1')],
      ['wss://fast', 'wss://stuck'],
      pool,
      undefined,
      (d) => {
        finalized = d;
      },
    );
    fast.resolve('ok');
    const early = await sendPromise;
    await new Promise((r) => setTimeout(r, 0));
    expect(summariseDelivery(early.delivery)).toEqual({ ok: 1, total: 2 });
    // The stuck relay never settles, so the background finalize cannot fire —
    // the early snapshot is already the correct (and final) single-tick state.
    expect(finalized).toBeNull();
  });

  it('records an all-failed send (every relay rejects) with delivered=false', async () => {
    const r1 = deferred<string>();
    const r2 = deferred<string>();
    const pool: RelayPublisher = { publish: () => [r1.promise, r2.promise] };
    const sendPromise = publishWrapsTrackingRelays([wrap('w1')], ['wss://a', 'wss://b'], pool);
    r1.reject(new Error('relay a down'));
    r2.reject(new Error('relay b down'));
    const result = await sendPromise;
    expect(result.wrapsPublished).toBe(0);
    expect(result.delivery.delivered).toBe(false);
    expect(result.errors[0]).toContain('relay a down');
  });

  it('settles to all-failed when relays never respond (offline) within the timeout', async () => {
    // Offline: pool.publish promises never resolve OR reject. Without a timeout
    // the send hangs and the bubble is stuck pending; with one it settles to a
    // concrete all-failed result (red tick + Re-publish).
    const neverSettles = new Promise<string>(() => {});
    const pool: RelayPublisher = { publish: () => [neverSettles, neverSettles] };
    const result = await publishWrapsTrackingRelays(
      [wrap('w1')],
      ['wss://a', 'wss://b'],
      pool,
      undefined,
      undefined,
      0, // immediate timeout
    );
    expect(result.wrapsPublished).toBe(0);
    expect(result.delivery.delivered).toBe(false);
    // Both relays recorded as failed → the bubble can show the red glyph.
    expect(summariseDelivery(result.delivery)).toEqual({ ok: 0, total: 2 });
    expect(result.errors[0]).toContain('timed out');
  });

  it('carries the rumor eventId + kind onto the delivery status', async () => {
    const ok = deferred<string>();
    const pool: RelayPublisher = { publish: () => [ok.promise] };
    const sendPromise = publishWrapsTrackingRelays([wrap('w1')], ['wss://a'], pool, {
      eventId: 'abc',
      kind: 14,
    });
    ok.resolve('ok');
    const result = await sendPromise;
    expect(result.delivery.eventId).toBe('abc');
    expect(result.delivery.kind).toBe(14);
  });
});

describe('publishWrapsTrackingRelays — connection failures + stale-socket retry', () => {
  it('treats a resolved "connection failure: …" as a FAILURE, not an accept', async () => {
    // nostr-tools' pool.publish RESOLVES with this string when it cannot open
    // a socket (verified on 2.23.3). Pre-fix this counted as a published wrap
    // and painted a delivered tick for a message that never left the device.
    const pool: RelayPublisher = {
      publish: () => [Promise.resolve('connection failure: Error: connection timed out')],
    };
    const result = await publishWrapsTrackingRelays([wrap('w1')], ['wss://dead'], pool);
    expect(result.wrapsPublished).toBe(0);
    expect(result.delivery.delivered).toBe(false);
    expect(result.delivery.relayResults['wss://dead']).toBe('failed');
    expect(result.errors[0]).toContain('connection failure');
  });

  it('force-closes stale relays and retries once when nothing was published', async () => {
    // Attempt 1: both relays reject with the stale-socket signature. The
    // publisher must close them (dropping the dead sockets) and re-publish;
    // attempt 2 succeeds → the send reports delivered.
    let call = 0;
    const closed: string[][] = [];
    const pool: RelayPublisher = {
      publish: () => {
        call++;
        return call === 1
          ? [
              Promise.reject(new Error('publish timed out')),
              Promise.reject(new Error('publish timed out')),
            ]
          : [Promise.resolve('ok'), Promise.resolve('ok')];
      },
      close: (relays) => closed.push(relays),
    };
    const result = await publishWrapsTrackingRelays([wrap('w1')], ['wss://a', 'wss://b'], pool);
    expect(closed).toEqual([['wss://a', 'wss://b']]);
    expect(call).toBe(2);
    expect(result.wrapsPublished).toBe(1);
    expect(result.delivery.delivered).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('does NOT retry when at least one wrap was published', async () => {
    let call = 0;
    const pool: RelayPublisher = {
      publish: () => {
        call++;
        return [Promise.resolve('ok'), Promise.reject(new Error('publish timed out'))];
      },
      close: () => {
        throw new Error('close must not be called');
      },
    };
    const result = await publishWrapsTrackingRelays([wrap('w1')], ['wss://a', 'wss://b'], pool);
    expect(call).toBe(1);
    expect(result.wrapsPublished).toBe(1);
  });

  it('does NOT retry when relays actively rejected (non-transport failure)', async () => {
    // A live relay saying "blocked:" answered on a healthy socket — retrying
    // with a fresh connection cannot help and must not double the latency.
    let call = 0;
    const pool: RelayPublisher = {
      publish: () => {
        call++;
        return [Promise.reject(new Error('blocked: pubkey not admitted'))];
      },
      close: () => {
        throw new Error('close must not be called');
      },
    };
    const result = await publishWrapsTrackingRelays([wrap('w1')], ['wss://a'], pool);
    expect(call).toBe(1);
    expect(result.wrapsPublished).toBe(0);
    expect(result.errors[0]).toContain('blocked');
  });

  it('retries when relays never settle (synthesized timeout marks them stale)', async () => {
    let call = 0;
    const neverSettles = new Promise<string>(() => {});
    const closed: string[][] = [];
    const pool: RelayPublisher = {
      publish: () => {
        call++;
        return call === 1 ? [neverSettles] : [Promise.resolve('ok')];
      },
      close: (relays) => closed.push(relays),
    };
    const result = await publishWrapsTrackingRelays(
      [wrap('w1')],
      ['wss://stuck'],
      pool,
      undefined,
      undefined,
      0, // immediate timeout on both attempts
    );
    expect(closed).toEqual([['wss://stuck']]);
    expect(result.wrapsPublished).toBe(1);
    expect(result.delivery.delivered).toBe(true);
  });

  it('onFinalized reflects the RETRY attempt, not the failed first attempt', async () => {
    let call = 0;
    const pool: RelayPublisher = {
      publish: () => {
        call++;
        return call === 1
          ? [Promise.reject(new Error('publish timed out'))]
          : [Promise.resolve('ok')];
      },
      close: () => {},
    };
    const finalized: DeliveryStatus[] = [];
    const result = await publishWrapsTrackingRelays(
      [wrap('w1')],
      ['wss://a'],
      pool,
      { eventId: 'rumor-1', kind: 14 },
      (d) => finalized.push(d),
    );
    expect(result.delivery.delivered).toBe(true);
    // Let background finalizes flush.
    await new Promise((r) => setTimeout(r, 0));
    expect(finalized).toHaveLength(1);
    expect(finalized[0].delivered).toBe(true);
    expect(summariseDelivery(finalized[0])).toEqual({ ok: 1, total: 1 });
  });

  it('skips the retry when the pool exposes no close()', async () => {
    let call = 0;
    const pool: RelayPublisher = {
      publish: () => {
        call++;
        return [Promise.reject(new Error('publish timed out'))];
      },
    };
    const result = await publishWrapsTrackingRelays([wrap('w1')], ['wss://a'], pool);
    expect(call).toBe(1);
    expect(result.wrapsPublished).toBe(0);
  });
});

describe('publishWrapsTrackingRelays — per-wrap stale tracking (multi-wrap sends)', () => {
  it('marks a relay stale when it black-holes a later wrap despite settling an earlier one', async () => {
    // Wrap A gets an active rejection (relay alive at that instant); wrap B on
    // the SAME relay never settles (socket died between wraps). The timeout
    // branch must judge "settled" per wrap — with a shared set, wrap A's
    // settle suppressed wrap B's staleness and the auto-retry never fired.
    let call = 0;
    const closed: string[][] = [];
    const pool: RelayPublisher = {
      publish: () => {
        call++;
        if (call === 1) return [Promise.reject(new Error('blocked: not admitted'))]; // wrap A, attempt 1
        if (call === 2) return [new Promise<string>(() => {})]; // wrap B, attempt 1 — black hole
        return [Promise.resolve('ok')]; // both wraps, attempt 2
      },
      close: (relays) => closed.push(relays),
    };
    const result = await publishWrapsTrackingRelays(
      [wrap('wA'), wrap('wB')],
      ['wss://dying'],
      pool,
      undefined,
      undefined,
      0, // immediate timeout so the black-holed wrap settles the attempt fast
    );
    expect(closed).toEqual([['wss://dying']]);
    expect(call).toBe(4); // 2 wraps × 2 attempts
    expect(result.wrapsPublished).toBe(2);
    expect(result.delivery.delivered).toBe(true);
  });
});

it.each([true, false])(
  'distinguishes recipient delivery from self-copy delivery (%s)',
  async (recipientPublished) => {
    const events = [
      { ...wrap('self'), tags: [['p', 'sender']] },
      { ...wrap('recipient'), tags: [['p', 'seller']] },
    ] as VerifiedEvent[];
    const pool: RelayPublisher = {
      publish: (_relays, event) => [
        (event.id === 'recipient') === recipientPublished
          ? Promise.resolve('ok')
          : Promise.reject(new Error('blocked')),
      ],
    };
    const result = await publishWrapsTrackingRelays(events, ['wss://relay'], pool);
    expect(result.wrapsPublished).toBe(1);
    expect(result.errors).toEqual(['blocked']);
    expect(result.wrapOutcomes).toEqual([
      {
        recipientPubkey: 'sender',
        published: !recipientPublished,
        ...(!recipientPublished ? {} : { error: 'blocked' }),
      },
      {
        recipientPubkey: 'seller',
        published: recipientPublished,
        ...(recipientPublished ? {} : { error: 'blocked' }),
      },
    ]);
  },
);
