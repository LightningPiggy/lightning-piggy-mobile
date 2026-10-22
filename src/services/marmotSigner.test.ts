import { AmberSignerError } from './amberErrors';
import {
  AMBER_REQUEST_TIMEOUT_MS,
  amberRequestOpenSince,
  createMarmotSigner,
} from './marmotSigner';

const mockAmberSign = jest.fn();
const mockBunkerSign = jest.fn();

jest.mock('expo-secure-store', () => ({ getItemAsync: jest.fn() }));
jest.mock('./amberService', () => ({
  requestEventSignature: (...args: unknown[]) => mockAmberSign(...args),
  requestNip44Encrypt: jest.fn(),
  requestNip44Decrypt: jest.fn(),
}));
jest.mock('./nostrConnectService', () => ({
  requestEventSignature: (...args: unknown[]) => mockBunkerSign(...args),
}));
jest.mock('./nostrService', () => ({}));
jest.mock('./nostrCrypto', () => ({}));

const PK = 'a'.repeat(64);
const draft = { kind: 13, created_at: 1, tags: [], content: 'x' };

beforeEach(() => {
  mockAmberSign.mockReset();
  mockBunkerSign.mockReset();
});

describe('createMarmotSigner', () => {
  it('serialises requests across signer instances (one Amber intent at a time)', async () => {
    let open = 0;
    let maxOpen = 0;
    mockAmberSign.mockImplementation(async () => {
      maxOpen = Math.max(maxOpen, ++open);
      await new Promise((r) => setTimeout(r, 5));
      open--;
      return { event: JSON.stringify({ ...draft, id: 'i', sig: 's', pubkey: PK }) };
    });
    const a = createMarmotSigner(PK, 'amber');
    const b = createMarmotSigner(PK, 'amber');
    await Promise.all([a.signEvent(draft), b.signEvent(draft), a.signEvent(draft)]);
    expect(maxOpen).toBe(1);
  });

  it('never reaches the backend for a request abandoned while it was queued', async () => {
    let cancelled = false;
    mockAmberSign.mockImplementation(async () => {
      cancelled = true; // the caller gives up while this one is open
      return { event: JSON.stringify({ ...draft, id: 'i', sig: 's', pubkey: PK }) };
    });
    const signer = createMarmotSigner(PK, 'amber', { cancelled: () => cancelled });
    const first = signer.signEvent(draft);
    const second = signer.signEvent(draft);
    await expect(first).resolves.toBeDefined();
    await expect(second).rejects.toThrow('abandoned');
    expect(mockAmberSign).toHaveBeenCalledTimes(1);
  });

  it('an abandoned NIP-46 request frees the shared queue even if the bunker never answers', async () => {
    let gaveUp = false;
    mockBunkerSign.mockImplementationOnce(() => new Promise(() => undefined)); // offline bunker
    mockBunkerSign.mockImplementationOnce(async () => ({
      event: JSON.stringify({ ...draft, id: 'i', sig: 's', pubkey: PK }),
    }));
    const stuck = createMarmotSigner(PK, 'nip46', { cancelled: () => gaveUp }).signEvent(draft);
    const next = createMarmotSigner(PK, 'nip46').signEvent(draft);
    setTimeout(() => (gaveUp = true), 20);
    await expect(stuck).rejects.toThrow('abandoned');
    await expect(next).resolves.toBeDefined();
  });

  it('an abandoned Amber request rejects at once but holds the queue until the intent settles', async () => {
    let gaveUp = false;
    let answerFirst: () => void = () => undefined;
    const signed = { event: JSON.stringify({ ...draft, id: 'i', sig: 's', pubkey: PK }) };
    mockAmberSign.mockImplementationOnce(
      () => new Promise((r) => (answerFirst = () => r(signed))), // the user hasn't answered yet
    );
    mockAmberSign.mockImplementationOnce(async () => signed);
    const stuck = createMarmotSigner(PK, 'amber', { cancelled: () => gaveUp }).signEvent(draft);
    const next = createMarmotSigner(PK, 'amber').signEvent(draft);
    setTimeout(() => (gaveUp = true), 20);
    await expect(stuck).rejects.toThrow('abandoned');
    expect(mockAmberSign).toHaveBeenCalledTimes(1); // no second intent while one is open
    answerFirst();
    await expect(next).resolves.toBeDefined();
    expect(mockAmberSign).toHaveBeenCalledTimes(2);
  });

  it('an Amber request nobody answers times out and frees the queue for the next one (#1658)', async () => {
    jest.useFakeTimers();
    try {
      const signed = { event: JSON.stringify({ ...draft, id: 'i', sig: 's', pubkey: PK }) };
      mockAmberSign.mockImplementationOnce(() => new Promise(() => undefined)); // result never delivered
      mockAmberSign.mockImplementationOnce(async () => signed);
      const stuck = createMarmotSigner(PK, 'amber').signEvent(draft);
      const stuckOutcome = Promise.resolve(stuck).catch((e: unknown) => e);
      const next = createMarmotSigner(PK, 'amber').signEvent(draft);
      await jest.advanceTimersByTimeAsync(0);
      expect(amberRequestOpenSince()).not.toBeNull(); // the composer can name Amber
      expect(mockAmberSign).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(AMBER_REQUEST_TIMEOUT_MS);
      const error = await stuckOutcome;
      expect(error).toBeInstanceOf(AmberSignerError);
      expect(error).toMatchObject({ code: 'NO_RESULT', kind: 'no-response' });
      await expect(next).resolves.toBeDefined();
      expect(mockAmberSign).toHaveBeenCalledTimes(2);
      expect(amberRequestOpenSince()).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('a session-scoped (cancellable) Amber request also gives the queue back at the deadline', async () => {
    jest.useFakeTimers();
    try {
      const signed = { event: JSON.stringify({ ...draft, id: 'i', sig: 's', pubkey: PK }) };
      mockAmberSign.mockImplementationOnce(() => new Promise(() => undefined));
      mockAmberSign.mockImplementationOnce(async () => signed);
      const stuck = createMarmotSigner(PK, 'amber', { cancelled: () => false }).signEvent(draft);
      const stuckOutcome = Promise.resolve(stuck).catch((e: unknown) => e);
      const next = createMarmotSigner(PK, 'amber').signEvent(draft);
      await jest.advanceTimersByTimeAsync(AMBER_REQUEST_TIMEOUT_MS);
      expect(await stuckOutcome).toMatchObject({ kind: 'no-response' });
      await jest.advanceTimersByTimeAsync(1_000); // abandonable's poll interval
      await expect(next).resolves.toBeDefined();
    } finally {
      jest.useRealTimers();
    }
  });
});
