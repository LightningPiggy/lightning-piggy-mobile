import type { Event as NostrEvent } from 'nostr-tools';

import { createMemoryMarmotBackend } from './marmotStore';
import {
  INVITE_CHANGE_COALESCE_MS,
  MarmotWelcomeOutbox,
  WELCOME_OUTBOX_TTL_SECS,
  WELCOME_RETRY_BACKOFF_MS,
} from './marmotWelcomeOutbox';

afterEach(() => {
  jest.restoreAllMocks();
  jest.useRealTimers();
});
/** Move the clock `ms` past now (a wrap's retry backoff is in wall time). */
const later = (ms: number) => {
  const now = Date.now();
  jest.spyOn(Date, 'now').mockReturnValue(now + ms);
};

const wrap = (id: string, recipient = 'c'.repeat(64)) =>
  ({
    id,
    kind: 1059,
    tags: [['p', recipient]],
    content: '',
    pubkey: '',
    created_at: 0,
    sig: '',
  }) as NostrEvent;

function makeNetwork() {
  let online = false;
  const published: string[] = [];
  return {
    published,
    setOnline: (v: boolean) => (online = v),
    network: {
      publish: async (relays: string[], e: NostrEvent) => {
        if (online) published.push(e.id);
        return Object.fromEntries(relays.map((r) => [r, { from: r, ok: online }]));
      },
    },
  };
}

describe('MarmotWelcomeOutbox', () => {
  it('captures refused gift wraps during an invite, reports progress, and keeps them for later', async () => {
    const net = makeNetwork();
    const outbox = new MarmotWelcomeOutbox(createMemoryMarmotBackend());
    const network = outbox.wrapNetwork(net.network);
    const ticks: number[] = [];
    const { failed } = await outbox.capture(
      async () => {
        await network.publish(['wss://a'], wrap('1'.repeat(64)));
        await network.publish(['wss://a'], { ...wrap('2'.repeat(64)), kind: 445 });
      },
      () => ticks.push(1),
    );
    expect(failed.map((w) => w.event.id)).toEqual(['1'.repeat(64)]);
    expect(failed[0]).toMatchObject({ relays: ['wss://a'], recipient: 'c'.repeat(64) });
    expect(ticks).toHaveLength(1); // only gift wraps count
    // Outside a capture nothing is collected.
    await network.publish(['wss://a'], wrap('3'.repeat(64)));

    expect(await outbox.resend(failed)).toHaveLength(1); // still offline
    await outbox.enqueue('group-a', failed);
    expect(await outbox.pending()).toHaveLength(1);
    net.setOnline(true);
    // Just attempted: the first retry waits out the first backoff step.
    await outbox.flush();
    expect(net.published).toEqual([]);
    later(WELCOME_RETRY_BACKOFF_MS);
    await outbox.flush();
    expect(net.published).toEqual(['1'.repeat(64)]);
    expect(await outbox.pending()).toHaveLength(0);
  });

  it('publishes nothing once the session has stopped (sign-out mid-invite)', async () => {
    const net = makeNetwork();
    let stopped = false;
    const outbox = new MarmotWelcomeOutbox(createMemoryMarmotBackend(), () => stopped);
    const network = outbox.wrapNetwork(net.network);
    const { failed } = await outbox.capture(async () => {
      await network.publish(['wss://a'], wrap('1'.repeat(64)));
    });
    await outbox.enqueue('group-a', failed);
    net.setOnline(true);
    stopped = true;
    // The wraps are already signed, so only this check stops a late publish.
    expect(await outbox.resend(failed)).toEqual(failed);
    await outbox.flush();
    expect(net.published).toEqual([]);
    expect(await outbox.pending()).toHaveLength(1); // kept for the next session
  });

  it('drops a group’s queue, expires old entries and stays bounded', async () => {
    const net = makeNetwork();
    const backend = createMemoryMarmotBackend();
    const outbox = new MarmotWelcomeOutbox(backend);
    outbox.wrapNetwork(net.network);
    const item = (id: string) => ({
      event: wrap(id),
      relays: ['wss://a'],
      recipient: 'c'.repeat(64),
    });
    await outbox.enqueue('group-a', [item('a'.repeat(64))]);
    await outbox.enqueue('group-b', [item('b'.repeat(64))]);
    await outbox.drop('group-a');
    expect((await outbox.pending()).map((p) => p.groupIdHex)).toEqual(['group-b']);

    // Expired: removed without being sent.
    const [stale] = await outbox.pending();
    stale.queuedAt -= WELCOME_OUTBOX_TTL_SECS + 1;
    await backend.set('welcomeOutbox', stale.event.id, JSON.stringify(stale));
    net.setOnline(true);
    await outbox.flush();
    expect(net.published).toEqual([]);
    expect(await outbox.pending()).toHaveLength(0);

    for (let i = 0; i < 105; i++) {
      await outbox.enqueue('group-c', [item(i.toString(16).padStart(64, '0'))]);
    }
    expect(await outbox.pending()).toHaveLength(100);
  });
});

describe('MarmotWelcomeOutbox concurrency', () => {
  it('runs invites one at a time so each keeps only its own refused wraps', async () => {
    const net = makeNetwork();
    const outbox = new MarmotWelcomeOutbox(createMemoryMarmotBackend());
    const network = outbox.wrapNetwork(net.network);
    let releaseA!: () => void;
    const gateA = new Promise<void>((r) => (releaseA = r));
    const order: string[] = [];
    const a = outbox.capture(async () => {
      order.push('a:start');
      await gateA;
      await network.publish(['wss://a'], wrap('a'.repeat(64)));
      order.push('a:end');
    });
    const b = outbox.capture(async () => {
      order.push('b:start');
      await network.publish(['wss://a'], wrap('b'.repeat(64)));
    });
    await new Promise((r) => setTimeout(r, 10));
    expect(order).toEqual(['a:start']); // b waits for a
    releaseA();
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.failed.map((w) => w.event.id)).toEqual(['a'.repeat(64)]);
    expect(rb.failed.map((w) => w.event.id)).toEqual(['b'.repeat(64)]);
    // A failed invite doesn't block the next one.
    await expect(outbox.capture(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect((await outbox.capture(async () => 'ok')).result).toBe('ok');
  });
});

describe('MarmotWelcomeOutbox retries (#1402)', () => {
  const item = (id: string) => ({
    event: wrap(id),
    relays: ['wss://a'],
    recipient: 'c'.repeat(64),
  });

  it('backs each wrap off after a failed retry, doubling', async () => {
    const net = makeNetwork();
    const outbox = new MarmotWelcomeOutbox(createMemoryMarmotBackend());
    const publish = jest.spyOn(net.network, 'publish');
    outbox.wrapNetwork(net.network);
    await outbox.enqueue('group-a', [item('a'.repeat(64))]);
    const start = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(start + WELCOME_RETRY_BACKOFF_MS);
    await outbox.flush(); // fails: next wait is 2 min
    expect(publish).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(start + 2 * WELCOME_RETRY_BACKOFF_MS);
    await outbox.flush();
    expect(publish).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(start + 3 * WELCOME_RETRY_BACKOFF_MS);
    net.setOnline(true);
    await outbox.flush();
    expect(publish).toHaveBeenCalledTimes(2);
    expect(await outbox.pending()).toHaveLength(0);
  });

  it('never republishes a wrap twice at once', async () => {
    const outbox = new MarmotWelcomeOutbox(createMemoryMarmotBackend());
    let release!: () => void;
    const publish = jest.fn(
      (relays: string[]) =>
        new Promise<Record<string, { from: string; ok: boolean }>>((resolve) => {
          release = () =>
            resolve(Object.fromEntries(relays.map((r) => [r, { from: r, ok: true }])));
        }),
    );
    outbox.wrapNetwork({ publish });
    await outbox.enqueue('group-a', [item('a'.repeat(64))]);
    later(WELCOME_RETRY_BACKOFF_MS);
    const first = outbox.flush();
    const second = outbox.flush('group-a');
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await Promise.all([first, second]);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await outbox.pending()).toHaveLength(0);
  });

  it("a send in one chat only retries that chat's wraps", async () => {
    const net = makeNetwork();
    const outbox = new MarmotWelcomeOutbox(createMemoryMarmotBackend());
    outbox.wrapNetwork(net.network);
    await outbox.enqueue('group-a', [item('a'.repeat(64))]);
    await outbox.enqueue('group-b', [item('b'.repeat(64))]);
    later(WELCOME_RETRY_BACKOFF_MS);
    net.setOnline(true);
    await outbox.flush('group-b');
    expect(net.published).toEqual(['b'.repeat(64)]);
    expect((await outbox.pending()).map((p) => p.groupIdHex)).toEqual(['group-a']);
  });

  it('reports queue changes once per chat per burst (queued, delivered, dropped)', async () => {
    jest.useFakeTimers({ doNotFake: ['Date'] });
    const net = makeNetwork();
    const outbox = new MarmotWelcomeOutbox(createMemoryMarmotBackend());
    outbox.wrapNetwork(net.network);
    const seen: string[] = [];
    const stop = outbox.changes.subscribe((id) => seen.push(id));
    await outbox.enqueue('group-a', [item('a'.repeat(64))]);
    await outbox.enqueue('group-a', [item('d'.repeat(64))]);
    await outbox.enqueue('group-b', [item('b'.repeat(64))]);
    expect(seen).toEqual([]);
    await jest.advanceTimersByTimeAsync(INVITE_CHANGE_COALESCE_MS);
    expect(seen).toEqual(['group-a', 'group-b']);

    later(WELCOME_RETRY_BACKOFF_MS);
    net.setOnline(true);
    await outbox.flush('group-a'); // delivered
    await outbox.drop('group-b'); // dropped
    await jest.advanceTimersByTimeAsync(INVITE_CHANGE_COALESCE_MS);
    expect(seen).toEqual(['group-a', 'group-b', 'group-a', 'group-b']);
    stop();
  });
});

describe('MarmotWelcomeOutbox drop generation (#1402)', () => {
  const item = (id: string) => ({
    event: wrap(id),
    relays: ['wss://a'],
    recipient: 'c'.repeat(64),
  });

  it('a resend or enqueue started before the chat was dropped publishes and keeps nothing', async () => {
    const net = makeNetwork();
    const outbox = new MarmotWelcomeOutbox(createMemoryMarmotBackend());
    outbox.wrapNetwork(net.network);
    net.setOnline(true);
    const guard = { groupIdHex: 'group-a', generation: outbox.generation('group-a') };
    await outbox.drop('group-a');
    const failed = [item('a'.repeat(64))];
    expect(await outbox.resend(failed, guard)).toEqual(failed); // unpublished
    await outbox.enqueue('group-a', failed, guard.generation);
    expect(net.published).toEqual([]);
    expect(await outbox.pending()).toEqual([]);
    // Another chat is unaffected, and a fresh guard works again.
    const fresh = { groupIdHex: 'group-a', generation: outbox.generation('group-a') };
    expect(await outbox.resend(failed, fresh)).toEqual([]);
  });

  it('a scheduled retry for a chat dropped mid-flush does not publish its wrap', async () => {
    const outbox = new MarmotWelcomeOutbox(createMemoryMarmotBackend());
    const publish = jest.fn(async (relays: string[]) =>
      Object.fromEntries(relays.map((r) => [r, { from: r, ok: true }])),
    );
    outbox.wrapNetwork({ publish });
    await outbox.enqueue('group-a', [item('a'.repeat(64))]);
    later(WELCOME_RETRY_BACKOFF_MS);
    // The chat is dropped once the flush has read the queue but before it publishes.
    const pending = outbox.pending.bind(outbox);
    jest.spyOn(outbox, 'pending').mockImplementationOnce(async () => {
      const items = await pending();
      outbox.markDropped('group-a');
      return items;
    });
    await outbox.flush();
    expect(publish).not.toHaveBeenCalled();
  });
});

describe('MarmotWelcomeOutbox queue edges (#1402)', () => {
  const item = (id: string) => ({
    event: wrap(id),
    relays: ['wss://a'],
    recipient: 'c'.repeat(64),
  });

  it('an enqueue racing a drop of its chat leaves nothing behind', async () => {
    const backend = createMemoryMarmotBackend();
    let release!: () => void;
    const set = backend.set.bind(backend);
    let first = true;
    backend.set = async (ns, key, value) => {
      await set(ns, key, value);
      if (first) {
        first = false;
        await new Promise<void>((resolve) => (release = resolve));
      }
    };
    const outbox = new MarmotWelcomeOutbox(backend);
    const queued = outbox.enqueue('group-a', [item('a'.repeat(64)), item('b'.repeat(64))]);
    while (!release) await new Promise((resolve) => setTimeout(resolve, 0));
    await outbox.drop('group-a'); // runs between the two writes
    release();
    await queued;
    expect(await outbox.pending()).toEqual([]);
  });

  it("evicting the oldest wraps tells the evicted chat's members sheet", async () => {
    jest.useFakeTimers({ doNotFake: ['Date'] });
    const outbox = new MarmotWelcomeOutbox(createMemoryMarmotBackend());
    await outbox.enqueue('group-old', [item('0'.repeat(64))]);
    for (let i = 1; i <= 100; i++) {
      await outbox.enqueue('group-new', [item(i.toString(16).padStart(64, '0'))]);
    }
    const seen: string[] = [];
    outbox.changes.subscribe((id) => seen.push(id));
    await outbox.enqueue('group-new', [item('f'.repeat(64))]);
    await jest.advanceTimersByTimeAsync(INVITE_CHANGE_COALESCE_MS);
    expect(seen).toContain('group-old');
    expect((await outbox.pending()).map((p) => p.groupIdHex)).not.toContain('group-old');
  });
});
