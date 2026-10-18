const mockSelectKnown = jest.fn();
const mockUpsert = jest.fn();
const mockUpsertIf = jest.fn();
jest.mock('./dmDb', () => ({
  selectKnownEventIds: (...args: unknown[]) => mockSelectKnown(...args),
  upsertDmMessages: (...args: unknown[]) => mockUpsert(...args),
  upsertDmMessagesIf: (...args: unknown[]) => mockUpsertIf(...args),
}));

import { ingestWraps, type IngestableWrap } from './dmIngest';
import type { DmMessageRow } from './dmDb';

const wrap = (id: string): IngestableWrap => ({ id });
const OWNER = 'owner1';
const rowFor = (id: string): DmMessageRow => ({
  owner: OWNER,
  eventId: id,
  conversation: 'conv',
  createdAt: 1,
  sender: 's',
  content: 'c',
  fromMe: false,
  wireKind: 14,
});

beforeEach(() => {
  jest.clearAllMocks();
  mockSelectKnown.mockResolvedValue(new Set<string>());
  mockUpsert.mockResolvedValue(undefined);
});

describe('dmIngest.ingestWraps', () => {
  it('no-ops on empty input (no DB calls)', async () => {
    const decrypt = jest.fn();
    const res = await ingestWraps(OWNER, [], decrypt);
    expect(res).toEqual({ ingested: 0, alreadyKnown: 0, undecryptable: 0 });
    expect(mockSelectKnown).not.toHaveBeenCalled();
    expect(decrypt).not.toHaveBeenCalled();
  });

  it('decrypts only wraps not already stored (the decrypt-once gate)', async () => {
    mockSelectKnown.mockResolvedValue(new Set(['a', 'c'])); // a + c already stored
    const decrypt = jest.fn(async (w: IngestableWrap) => rowFor(w.id));
    const res = await ingestWraps(OWNER, [wrap('a'), wrap('b'), wrap('c'), wrap('d')], decrypt);
    // only b + d get decrypted
    expect(decrypt.mock.calls.map((c) => c[0].id)).toEqual(['b', 'd']);
    expect(mockSelectKnown).toHaveBeenCalledWith(OWNER, ['a', 'b', 'c', 'd']);
    expect(res).toEqual({ ingested: 2, alreadyKnown: 2, undecryptable: 0 });
  });

  it('upserts exactly the freshly decrypted rows', async () => {
    const decrypt = jest.fn(async (w: IngestableWrap) => rowFor(w.id));
    await ingestWraps(OWNER, [wrap('x'), wrap('y')], decrypt);
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert.mock.calls[0][0].map((r: DmMessageRow) => r.eventId)).toEqual(['x', 'y']);
  });

  it('saves through the guarded write when persistIf is given', async () => {
    const decrypt = jest.fn(async (w: IngestableWrap) => rowFor(w.id));
    // Fails before the write: nothing attempted.
    await ingestWraps(OWNER, [wrap('x')], decrypt, { persistIf: () => false });
    expect(mockUpsertIf).not.toHaveBeenCalled();
    // A wipe landing inside the write transaction: nothing counted.
    mockUpsertIf.mockResolvedValueOnce(false);
    const lost = await ingestWraps(OWNER, [wrap('z')], decrypt, { persistIf: () => true });
    expect(lost.ingested).toBe(0);
    mockUpsertIf.mockResolvedValueOnce(true);
    const saved = await ingestWraps(OWNER, [wrap('y')], decrypt, { persistIf: () => true });
    expect(saved.ingested).toBe(1);
    expect(mockUpsert).not.toHaveBeenCalled();
  });

  it('counts undecryptable wraps (decryptor returns null) and does not store them', async () => {
    const decrypt = jest.fn(async (w: IngestableWrap) => (w.id === 'bad' ? null : rowFor(w.id)));
    const res = await ingestWraps(OWNER, [wrap('ok'), wrap('bad')], decrypt);
    expect(res).toEqual({ ingested: 1, alreadyKnown: 0, undecryptable: 1 });
    expect(mockUpsert.mock.calls[0][0].map((r: DmMessageRow) => r.eventId)).toEqual(['ok']);
  });

  it('treats a throwing decryptor as undecryptable and keeps going (no whole-sync abort)', async () => {
    const decrypt = jest.fn(async (w: IngestableWrap) => {
      if (w.id === 'boom') throw new Error('unwrap failed');
      return rowFor(w.id);
    });
    const res = await ingestWraps(OWNER, [wrap('ok1'), wrap('boom'), wrap('ok2')], decrypt);
    expect(decrypt).toHaveBeenCalledTimes(3); // didn't abort after the throw
    expect(res).toEqual({ ingested: 2, alreadyKnown: 0, undecryptable: 1 });
    expect(mockUpsert.mock.calls[0][0].map((r: DmMessageRow) => r.eventId)).toEqual(['ok1', 'ok2']);
  });

  it('does not call upsert when nothing is fresh (all already known)', async () => {
    mockSelectKnown.mockResolvedValue(new Set(['a', 'b']));
    const decrypt = jest.fn();
    const res = await ingestWraps(OWNER, [wrap('a'), wrap('b')], decrypt);
    expect(decrypt).not.toHaveBeenCalled();
    expect(mockUpsert).not.toHaveBeenCalled();
    expect(res.alreadyKnown).toBe(2);
  });

  it('yields to the event loop every N fresh decrypts and reports progress', async () => {
    const ids = Array.from({ length: 5 }, (_, i) => wrap(`w${i}`));
    const decrypt = jest.fn(async (w: IngestableWrap) => rowFor(w.id));
    const onProgress = jest.fn();
    await ingestWraps(OWNER, ids, decrypt, { yieldEvery: 2, onProgress });
    // 5 fresh decrypts, yield after #2 and #4 → 2 progress callbacks
    expect(onProgress).toHaveBeenCalledTimes(2);
    expect(onProgress).toHaveBeenLastCalledWith(4, 5);
  });

  it('stops decrypting when aborted but PERSISTS what it already decrypted (F1, #849)', async () => {
    // Contract change: a decrypted row is idempotent + (owner, event_id)-keyed,
    // so an aborted run must not throw away the decrypts it already paid for —
    // otherwise a 68 s post-login rebuild sweep cut short by a tab blur stored
    // nothing and the inbox stayed empty until a manual refocus. We still stop
    // the (expensive) decrypt loop at the abort; we just flush the batch first.
    const decrypt = jest.fn(async (w: IngestableWrap) => rowFor(w.id));
    const signal = { aborted: false };
    // abort after the first decrypt
    decrypt.mockImplementationOnce(async (w: IngestableWrap) => {
      signal.aborted = true;
      return rowFor(w.id);
    });
    const res = await ingestWraps(OWNER, [wrap('a'), wrap('b'), wrap('c')], decrypt, { signal });
    expect(decrypt).toHaveBeenCalledTimes(1); // loop still stopped at the abort
    // ...but the one row it decrypted before aborting IS persisted.
    expect(mockUpsert).toHaveBeenCalledTimes(1);
    expect(mockUpsert.mock.calls[0][0].map((r: DmMessageRow) => r.eventId)).toEqual(['a']);
    expect(res.ingested).toBe(1);
  });
});
