import { querySyncAbortable } from './relayQuery';
import type { SimplePool } from 'nostr-tools/pool';
import type { Event as NostrEvent } from 'nostr-tools/pure';

// These fake-pool tests exercise completion policy; the signed-event backlog
// and persistence barrier are covered in relayQuery.receiveQueue.test.ts.
jest.mock('./nostrVerifyCache', () => ({
  hydrateVerifiedEventCache: jest.fn(async () => {}),
  flushVerifiedEventCache: jest.fn(async () => {}),
}));

type SubParams = {
  maxWait?: number;
  abort?: AbortSignal;
  onevent: (e: NostrEvent) => void;
  oneose: () => void;
  onclose: (reasons: (string | { url: string; reason: string })[]) => void;
};

const makeEvent = (id: string): NostrEvent =>
  ({ id, kind: 1, pubkey: 'p', created_at: 0, tags: [], content: '', sig: 's' }) as NostrEvent;

/** Fake pool whose subscribeMany hands the caller the registered handlers so a
 *  test can drive onevent / oneose / abort deterministically. */
function fakePool(): { pool: SimplePool; params: () => SubParams; close: jest.Mock } {
  let captured: SubParams | undefined;
  const close = jest.fn();
  const pool = {
    subscribeMany: (_relays: string[], _filter: unknown, params: SubParams) => {
      captured = params;
      return { close };
    },
  } as unknown as SimplePool;
  return {
    pool,
    params: () => {
      if (!captured) throw new Error('subscribeMany was not called');
      return captured;
    },
    close,
  };
}

describe('querySyncAbortable', () => {
  it('collects events and resolves on EOSE, closing the sub', async () => {
    const { pool, params, close } = fakePool();
    const promise = querySyncAbortable(pool, ['wss://r'], { kinds: [1] }, { maxWait: 1000 });
    params().onevent(makeEvent('a'));
    params().onevent(makeEvent('b'));
    params().oneose();
    const events = await promise;
    expect(events.map((e) => e.id)).toEqual(['a', 'b']);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it('resolves with partial results and closes the sub when the signal aborts', async () => {
    const { pool, params, close } = fakePool();
    const ctrl = new AbortController();
    const promise = querySyncAbortable(pool, ['wss://r'], { kinds: [1] }, { signal: ctrl.signal });
    params().onevent(makeEvent('a'));
    ctrl.abort();
    const events = await promise;
    expect(events.map((e) => e.id)).toEqual(['a']);
    expect(close).toHaveBeenCalled();
  });

  it('resolves empty immediately without subscribing if the signal is already aborted', async () => {
    const subscribeMany = jest.fn();
    const pool = { subscribeMany } as unknown as SimplePool;
    const ctrl = new AbortController();
    ctrl.abort();
    const events = await querySyncAbortable(
      pool,
      ['wss://r'],
      { kinds: [1] },
      { signal: ctrl.signal },
    );
    expect(events).toEqual([]);
    expect(subscribeMany).not.toHaveBeenCalled();
  });

  it('settles only once even if EOSE fires after an abort', async () => {
    const { pool, params, close } = fakePool();
    const ctrl = new AbortController();
    const promise = querySyncAbortable(pool, ['wss://r'], { kinds: [1] }, { signal: ctrl.signal });
    ctrl.abort();
    // A late EOSE from the relay must not throw or re-resolve.
    params().oneose();
    await promise;
    expect(close).toHaveBeenCalledTimes(1);
  });
});

describe('querySyncAbortable de-duplication', () => {
  it('keeps one copy of an event id even if it arrives from several relays', async () => {
    const { pool, params } = fakePool();
    const promise = querySyncAbortable(pool, ['wss://a', 'wss://b'], { kinds: [1] }, {});
    params().onevent(makeEvent('a'));
    params().onevent(makeEvent('a'));
    params().onevent(makeEvent('b'));
    params().oneose();
    expect((await promise).map((e) => e.id)).toEqual(['a', 'b']);
  });
});

describe('querySyncAbortable deadline', () => {
  afterEach(() => jest.useRealTimers());

  it('does not confuse an aggregate quiet deadline with proven all-relay failure', async () => {
    jest.useFakeTimers();
    const { pool, params, close } = fakePool();
    const promise = querySyncAbortable(
      pool,
      ['wss://a'],
      { kinds: [1] },
      { maxWait: 1000, rejectOnAllRelaysFailure: true },
    );
    expect(params().maxWait).toBe(2000); // pool's own timeout trails ours
    await jest.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toEqual([]);
    expect(close).toHaveBeenCalled();
  });

  it('resolves partial results at the deadline, and [] without the flag', async () => {
    jest.useFakeTimers();
    const a = fakePool();
    const withEvents = querySyncAbortable(a.pool, ['wss://a'], { kinds: [1] }, { maxWait: 1000, rejectOnAllRelaysFailure: true }); // prettier-ignore
    a.params().onevent(makeEvent('x'));
    const b = fakePool();
    const noFlag = querySyncAbortable(b.pool, ['wss://a'], { kinds: [1] }, { maxWait: 1000 });
    await jest.advanceTimersByTimeAsync(1000);
    expect((await withEvents).map((e) => e.id)).toEqual(['x']);
    expect(await noFlag).toEqual([]);
  });
});

describe('scoped aggregate connection failures', () => {
  it('rejects when every relay dropped the socket after connecting ("relay connection closed")', async () => {
    const { pool, params } = fakePool();
    const promise = querySyncAbortable(
      pool,
      ['wss://a', 'wss://b'],
      { kinds: [1] },
      { rejectOnAllRelaysFailure: true },
    );
    params().oneose();
    params().onclose(['relay connection closed', 'websocket closed']);
    await expect(promise).rejects.toThrow('All relays failed');
  });

  it('treats relay refusals (NIP-42 auth failure, auth-required / restricted CLOSED) as failures', async () => {
    const { pool, params } = fakePool();
    const promise = querySyncAbortable(
      pool,
      ['wss://a', 'wss://b', 'wss://c'],
      { kinds: [1] },
      { rejectOnAllRelaysFailure: true },
    );
    params().oneose();
    params().onclose([
      'auth was required and attempted, but failed with: bad sig',
      'auth-required: we only serve subscriptions to registered users',
      'restricted: not allowed',
    ]);
    await expect(promise).rejects.toThrow('All relays failed');
  });

  it.each([
    'ERROR: auth-required: this event may only be read by its recipients',
    'ERROR: restricted: not allowed',
    'ERROR: AUTH-REQUIRED: this event may only be read by its recipients',
    'ERROR: policy:restricted: not allowed',
  ])('treats prefixed relay refusal %s as a failure', async (reason) => {
    const { pool, params } = fakePool();
    const promise = querySyncAbortable(
      pool,
      ['wss://a'],
      { kinds: [1] },
      { rejectOnAllRelaysFailure: true },
    );
    params().oneose();
    params().onclose([{ url: 'wss://a', reason }]);
    await expect(promise).rejects.toThrow('All relays failed');
  });

  it('accepts every nostr-tools timeout reason, prefixed or not', async () => {
    const { pool, params } = fakePool();
    const promise = querySyncAbortable(
      pool,
      ['wss://a', 'wss://b', 'wss://c'],
      { kinds: [1] },
      { rejectOnAllRelaysFailure: true },
    );
    params().oneose();
    params().onclose(['connection timed out', 'relay connection timed out', 'auth timed out']);
    await expect(promise).rejects.toThrow('All relays failed');
  });

  it('does not treat a deliberate close as a failure', async () => {
    const { pool, params } = fakePool();
    const promise = querySyncAbortable(
      pool,
      ['wss://a'],
      { kinds: [1] },
      {
        rejectOnAllRelaysFailure: true,
      },
    );
    params().oneose();
    params().onclose(['closed by caller']);
    await expect(promise).resolves.toEqual([]);
  });

  it('rejects all-relay connection failure even when EOSE fires first', async () => {
    const { pool, params } = fakePool();
    const result = querySyncAbortable(
      pool,
      ['wss://a', 'wss://b'],
      {},
      { rejectOnAllRelaysFailure: true },
    );
    params().oneose();
    params().onclose(['connection failed', 'connection timed out']);
    await expect(result).rejects.toThrow('All relays failed');
  });
  it('preserves default resolution on connection failure', async () => {
    const { pool, params } = fakePool();
    const result = querySyncAbortable(pool, ['wss://a'], {}, {});
    params().oneose();
    params().onclose(['connection failed']);
    await expect(result).resolves.toEqual([]);
  });
  it('preserves partial results despite a failure close', async () => {
    const { pool, params } = fakePool();
    const result = querySyncAbortable(pool, ['wss://a'], {}, { rejectOnAllRelaysFailure: true });
    params().onevent(makeEvent('a'));
    params().oneose();
    params().onclose(['connection failed']);
    await expect(result).resolves.toHaveLength(1);
  });
  it('resolves on EOSE or subscription timeout without a connection failure', async () => {
    const { pool, params } = fakePool();
    const result = querySyncAbortable(
      pool,
      ['wss://a'],
      {},
      { rejectOnAllRelaysFailure: true, maxWait: 1 },
    );
    params().oneose(); // The pool uses this callback for eoseTimeout too.
    await expect(result).resolves.toEqual([]);
  });
  it('abort remains successful even if connection failures subsequently arrive', async () => {
    const { pool, params } = fakePool();
    const controller = new AbortController();
    const result = querySyncAbortable(
      pool,
      ['wss://a'],
      {},
      { rejectOnAllRelaysFailure: true, signal: controller.signal },
    );
    controller.abort();
    params().onclose(['connection failed']);
    await expect(result).resolves.toEqual([]);
  });
});

it('tolerates a synchronous EOSE without a subscription handle', async () => {
  const pool = {
    subscribeMany: (_r: unknown, _f: unknown, params: SubParams) => {
      params.oneose();
    },
  } as unknown as SimplePool;
  await expect(querySyncAbortable(pool, ['wss://a'], {}, {})).resolves.toEqual([]);
});

it('recognizes structured relay close reasons as total failure', async () => {
  const { pool, params } = fakePool();
  const promise = querySyncAbortable(pool, ['wss://a'], {}, { rejectOnAllRelaysFailure: true });
  params().onclose([{ url: 'wss://a', reason: 'connection failed' }] as never);
  await expect(promise).rejects.toThrow('All relays failed');
});

describe('strict shipping query completion', () => {
  afterEach(() => jest.useRealTimers());
  it('rejects a silent relay deadline instead of treating it as empty shipping', async () => {
    jest.useFakeTimers();
    const relay = fakePool();
    const result = querySyncAbortable(
      relay.pool,
      ['wss://shipping'],
      { kinds: [30406] },
      { maxWait: 6000, rejectOnTimeout: true },
    );
    const assertion = expect(result).rejects.toThrow('before EOSE');
    await jest.advanceTimersByTimeAsync(6000);
    await assertion;
    expect(relay.close).toHaveBeenCalledTimes(1);
  });
  it('accepts completed empty EOSE without a later timeout error', async () => {
    jest.useFakeTimers();
    const relay = fakePool();
    const result = querySyncAbortable(
      relay.pool,
      ['wss://shipping'],
      { kinds: [30406] },
      { maxWait: 6000, rejectOnTimeout: true },
    );
    relay.params().oneose();
    await jest.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toEqual([]);
    await jest.advanceTimersByTimeAsync(6000);
    expect(relay.close).toHaveBeenCalledTimes(1);
  });
});

it.each(['query deadline', { url: 'wss://a', reason: 'query deadline' }])(
  'preserves strict timeout rejection when budget close follows synthetic EOSE (%j)',
  async (reason) => {
    const { pool, params, close } = fakePool();
    const result = querySyncAbortable(pool, ['wss://a'], {}, { rejectOnTimeout: true });
    params().oneose();
    params().onclose([reason] as never);
    await expect(result).rejects.toThrow('Relay query timed out before EOSE');
    expect(close).toHaveBeenCalledTimes(1);
  },
);

describe('completed relay snapshots', () => {
  afterEach(() => jest.useRealTimers());

  it('keeps completed events and empty EOSE relays, discarding stalled or failed partial snapshots', async () => {
    jest.useFakeTimers();
    const peers = new Map<string, ReturnType<typeof fakePool>>();
    const pool = {
      subscribeMany: (relays: string[], filter: unknown, params: SubParams) => {
        const peer = fakePool();
        peers.set(relays[0], peer);
        return peer.pool.subscribeMany(relays, filter as never, params);
      },
    } as unknown as SimplePool;
    const completedRelays = new Set<string>();
    const result = querySyncAbortable(
      pool,
      ['wss://good', 'wss://empty', 'wss://stalled', 'wss://failed'],
      {},
      { maxWait: 1000, completedRelays },
    );
    peers.get('wss://good')!.params().onevent(makeEvent('good'));
    peers.get('wss://good')!.params().oneose();
    peers.get('wss://empty')!.params().oneose();
    peers.get('wss://stalled')!.params().onevent(makeEvent('unfinished'));
    peers.get('wss://failed')!.params().onevent(makeEvent('failed'));
    peers.get('wss://failed')!.params().oneose();
    peers.get('wss://failed')!.params().onclose(['relay connection closed']);
    await jest.advanceTimersByTimeAsync(1000);
    expect((await result).map((e) => e.id)).toEqual(['good']);
    expect([...completedRelays]).toEqual(['wss://good', 'wss://empty']);
    for (const peer of peers.values()) expect(peer.close).toHaveBeenCalledTimes(1);
  });

  it('rejects when no relay completes so the checkpoint can be retried', async () => {
    jest.useFakeTimers();
    const peer = fakePool();
    const result = querySyncAbortable(
      peer.pool,
      ['wss://stalled'],
      {},
      {
        maxWait: 1000,
        completedRelays: new Set(),
      },
    );
    const assertion = expect(result).rejects.toThrow('No relay completed');
    peer.params().onevent(makeEvent('partial'));
    await jest.advanceTimersByTimeAsync(1000);
    await assertion;
  });
});
