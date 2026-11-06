import { getSwapBackendForId } from './swapBackendService';

// Unit coverage for the Boltz swap-status subscription layer.
//
// Two invariants matter most and are cheaply testable without a real relay:
//   1. `classifySubmarineSwapStatus` — the raw-status → coarse-phase mapping
//      the Receive sheet drives its label + Refund affordance off. A wrong
//      bucket here shows the wrong UI (or hides Refund on a failed swap).
//   2. Cancellation — `waitForSwapStatus` must reject with an AbortError and
//      tear the WebSocket down when the caller's signal fires (sheet closed /
//      unmounted), rather than leaking the socket until the 24h timeout.
//
// The WebSocket transport is replaced with a controllable fake so we can drive
// open/message/abort deterministically with no network and no timers.

import {
  classifySubmarineSwapStatus,
  fetchSwapStatus,
  waitForSwapStatus,
  watchSubmarineSwapStatus,
  type SubmarineSwapPhase,
} from './boltzSwapStatus';

jest.mock('./swapBackendService', () => ({
  ...jest.requireActual('./swapBackendService'),
  getSwapBackendForId: jest.fn(async () => 'https://api.boltz.exchange/v2'),
}));

// --- Controllable fake WebSocket -------------------------------------------

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static reset() {
    FakeWebSocket.instances = [];
  }

  url: string;
  closed = false;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.closed = true;
  }

  // Test helpers to simulate the transport.
  emitOpen() {
    this.onopen?.();
  }
  emitStatus(status: string, extra: Record<string, unknown> = {}) {
    this.onmessage?.({
      data: JSON.stringify({ channel: 'swap.update', args: [{ status, ...extra }] }),
    });
  }
}

const originalWebSocket = (global as { WebSocket?: unknown }).WebSocket;

beforeEach(() => {
  FakeWebSocket.reset();
  (global as { WebSocket?: unknown }).WebSocket = FakeWebSocket as unknown;
});

afterEach(() => {
  (global as { WebSocket?: unknown }).WebSocket = originalWebSocket;
});

// --- classifySubmarineSwapStatus -------------------------------------------

describe('classifySubmarineSwapStatus', () => {
  const cases: [string | undefined, SubmarineSwapPhase][] = [
    // terminal success
    ['invoice.settled', 'complete'],
    ['transaction.claimed', 'complete'],
    ['invoice.paid', 'complete'],
    // terminal failure
    ['swap.expired', 'failed'],
    ['transaction.refunded', 'failed'],
    ['invoice.failedToPay', 'failed'],
    ['transaction.lockupFailed', 'failed'],
    ['transaction.failed', 'failed'],
    // Boltz paying the LN invoice
    ['transaction.claim.pending', 'paying-invoice'],
    ['invoice.pending', 'paying-invoice'],
    // lockup detected on-chain
    ['transaction.mempool', 'detected'],
    ['transaction.confirmed', 'detected'],
    // still waiting for the sender's on-chain payment
    ['swap.created', 'awaiting-payment'],
    ['invoice.set', 'awaiting-payment'],
    ['some.brand.new.status', 'awaiting-payment'],
    // missing status
    [undefined, 'unknown'],
    ['', 'unknown'],
  ];

  it.each(cases)('maps %s -> %s', (status, expected) => {
    expect(classifySubmarineSwapStatus(status)).toBe(expected);
  });
});

// --- waitForSwapStatus: cancellation ---------------------------------------

describe('waitForSwapStatus abort behaviour', () => {
  const isTerminal = (status: string) => status === 'invoice.settled';

  it('rejects immediately with AbortError when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      waitForSwapStatus('swap1', isTerminal, 10_000, controller.signal),
    ).rejects.toMatchObject({ name: 'AbortError' });

    // Pre-aborted: we bail before ever opening a socket.
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('rejects with AbortError and closes the socket when aborted mid-flight', async () => {
    const controller = new AbortController();
    const promise = waitForSwapStatus('swap2', isTerminal, 10_000, controller.signal);

    await Promise.resolve();
    // A socket was opened but never connected/terminal.
    expect(FakeWebSocket.instances).toHaveLength(1);
    await Promise.resolve();
    const ws = FakeWebSocket.instances[0];
    ws.emitOpen();

    controller.abort();

    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(ws.closed).toBe(true);
  });

  it('closes a socket that opens only after the watch was cancelled, without subscribing', async () => {
    // React Native ignores close() while a WebSocket is still CONNECTING and
    // then delivers `open` anyway; that socket must not stay open (it would
    // hold one of OkHttp's per-host slots that the Boltz host's fetches share).
    class ConnectingSocket extends FakeWebSocket {
      readyState = 0;
      close() {
        if (this.readyState === 0) {
          this.readyState = 2; // JS-side CLOSING only; the native socket keeps connecting
          return;
        }
        this.closed = true;
        this.readyState = 3;
      }
      emitOpen() {
        this.readyState = 1;
        super.emitOpen();
      }
    }
    (global as { WebSocket?: unknown }).WebSocket = ConnectingSocket as unknown;
    const controller = new AbortController();
    const promise = waitForSwapStatus('swap-slow', isTerminal, 10_000, controller.signal);
    await Promise.resolve();
    await Promise.resolve();
    const ws = FakeWebSocket.instances[0] as ConnectingSocket;
    controller.abort();
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
    expect(ws.closed).toBe(false); // still connecting natively
    ws.emitOpen();
    expect(ws.closed).toBe(true);
    expect(ws.sent).toEqual([]);
  });

  it('resolves with the raw data and tears the socket down on a terminal status', async () => {
    const promise = waitForSwapStatus('swap3', isTerminal, 10_000);

    await Promise.resolve();
    const ws = FakeWebSocket.instances[0];
    ws.emitOpen();
    // subscribe frame sent on open
    expect(ws.sent).toHaveLength(1);
    expect(JSON.parse(ws.sent[0])).toMatchObject({ op: 'subscribe', args: ['swap3'] });

    // non-terminal status is ignored; terminal one resolves.
    ws.emitStatus('transaction.mempool');
    ws.emitStatus('invoice.settled', { foo: 'bar' });

    await expect(promise).resolves.toMatchObject({ status: 'invoice.settled', foo: 'bar' });
    expect(ws.closed).toBe(true);
  });
});

// --- watchSubmarineSwapStatus: phase emission ------------------------------

describe('watchSubmarineSwapStatus', () => {
  it('emits a phase only when it changes and resolves on a terminal phase', async () => {
    const phases: SubmarineSwapPhase[] = [];
    const promise = watchSubmarineSwapStatus('swap4', (phase) => phases.push(phase), 10_000);

    await Promise.resolve();
    const ws = FakeWebSocket.instances[0];
    ws.emitOpen();
    ws.emitStatus('transaction.mempool'); // detected
    ws.emitStatus('transaction.confirmed'); // still detected -> deduped
    ws.emitStatus('transaction.claim.pending'); // paying-invoice
    ws.emitStatus('invoice.settled'); // complete (terminal)

    const result = await promise;

    expect(phases).toEqual(['detected', 'paying-invoice', 'complete']);
    expect(result.phase).toBe('complete');
    expect(result.rawStatus).toBe('invoice.settled');
  });
});

it('uses the same pinned provider for WebSocket and polling fallback', async () => {
  jest.mocked(getSwapBackendForId).mockResolvedValueOnce('https://family.example/boltz/v2');
  const originalFetch = global.fetch;
  const fetchMock = jest
    .fn()
    .mockResolvedValue({ ok: true, json: async () => ({ status: 'invoice.settled' }) });
  global.fetch = fetchMock;
  try {
    const promise = waitForSwapStatus(
      'private-swap',
      (status) => status === 'invoice.settled',
      10000,
    );
    await Promise.resolve();
    const ws = FakeWebSocket.instances[0];
    expect(ws.url).toBe('wss://family.example/boltz/v2/ws');
    ws.onerror?.();
    await promise;
    expect(fetchMock).toHaveBeenCalledWith(
      'https://family.example/boltz/v2/swap/private-swap',
      expect.anything(),
    );
  } finally {
    global.fetch = originalFetch;
  }
});

describe('fetchSwapStatus', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });
  const respond = (ok: boolean, body: unknown, status = ok ? 200 : 500) =>
    (global.fetch = jest.fn(async () => ({ ok, status, json: async () => body })) as never);

  it("reads the swap's status from its pinned backend", async () => {
    respond(true, { status: 'swap.created' });
    await expect(fetchSwapStatus('sw1')).resolves.toBe('swap.created');
    expect(global.fetch).toHaveBeenCalledWith(
      'https://api.boltz.exchange/v2/swap/sw1',
      expect.objectContaining({ signal: expect.anything() }),
    );
  });

  it('throws rather than guessing on a non-OK response or a missing status', async () => {
    respond(false, {}, 503);
    await expect(fetchSwapStatus('sw1')).rejects.toThrow('Boltz status check failed: 503');
    respond(true, { error: 'no status' });
    await expect(fetchSwapStatus('sw1')).rejects.toThrow('Boltz status missing');
  });
});
