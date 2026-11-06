import { probeReachability } from './relayReachabilityProbe';
import { PROBE_TIMEOUT_MS } from '../utils/relayReachability';

/** RN-like socket: close() while CONNECTING is ignored natively; a late open is still delivered. */
class FakeSocket {
  static instances: FakeSocket[] = [];
  readyState = 0;
  closedNatively = false;
  onopen: (() => void) | null = null;
  onmessage: (() => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;
  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  close() {
    if (this.readyState >= 2) return;
    const wasOpen = this.readyState === 1;
    this.readyState = 2;
    if (wasOpen) {
      this.closedNatively = true;
      this.readyState = 3;
    }
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  send() {}
}

const realWebSocket = global.WebSocket;
beforeEach(() => {
  jest.useFakeTimers();
  FakeSocket.instances = [];
  global.WebSocket = FakeSocket as unknown as typeof WebSocket;
});
afterEach(() => {
  global.WebSocket = realWebSocket;
  jest.useRealTimers();
});

it('closes a probe socket that opens after the probe timed out', async () => {
  const probe = probeReachability('wss://slow.example.com', new AbortController().signal);
  const ws = FakeSocket.instances[0];
  jest.advanceTimersByTime(PROBE_TIMEOUT_MS);
  await probe;
  ws.open();
  expect(ws.closedNatively).toBe(true);
});

it('closes a probe socket that opens after the screen cancelled the probe', async () => {
  const abort = new AbortController();
  const probe = probeReachability('wss://slow.example.com', abort.signal);
  const ws = FakeSocket.instances[0];
  abort.abort();
  await probe;
  ws.open();
  expect(ws.closedNatively).toBe(true);
});
