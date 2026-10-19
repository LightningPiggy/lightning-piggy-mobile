import { reuseUnchangedRows, sameRowData } from './reuseUnchangedRows';

type Row = { id: string; text: string; content?: { kind: string; parts?: string[] } };
const key = (row: Row) => row.id;

describe('sameRowData', () => {
  it('compares primitives, arrays and plain objects by value', () => {
    expect(sameRowData(1, 1)).toBe(true);
    expect(sameRowData(NaN, NaN)).toBe(true);
    expect(sameRowData('a', 'b')).toBe(false);
    expect(sameRowData({ a: [1, { b: 2 }] }, { a: [1, { b: 2 }] })).toBe(true);
    expect(sameRowData({ a: [1, { b: 2 }] }, { a: [1, { b: 3 }] })).toBe(false);
    expect(sameRowData({ a: 1 }, { a: 1, b: undefined })).toBe(false);
    expect(sameRowData([1, 2], [1, 2, 3])).toBe(false);
    expect(sameRowData([1], { 0: 1 })).toBe(false);
    expect(sameRowData(null, {})).toBe(false);
  });

  it('only treats non-plain objects as equal when they are the same object', () => {
    const map = new Map([['a', 1]]);
    expect(sameRowData({ m: map }, { m: map })).toBe(true);
    expect(sameRowData({ m: map }, { m: new Map([['a', 1]]) })).toBe(false);
    expect(sameRowData(new Date(0), new Date(0))).toBe(false);
    const fn = () => 1;
    expect(sameRowData({ fn }, { fn: () => 1 })).toBe(false);
  });

  it('gives up (not equal) on very deep nesting', () => {
    const deep = (n: number): unknown => (n === 0 ? 1 : { d: deep(n - 1) });
    expect(sameRowData(deep(4), deep(4))).toBe(true);
    expect(sameRowData(deep(20), deep(20))).toBe(false);
  });
});

describe('reuseUnchangedRows', () => {
  const a = { id: 'a', text: 'hi', content: { kind: 'text', parts: ['hi'] } };
  const b = { id: 'b', text: 'yo' };

  it('returns the new rows on the first build', () => {
    const next = [a, b];
    expect(reuseUnchangedRows([], next, key)).toBe(next);
  });

  it('returns the previous array when a rebuild changed nothing', () => {
    const prev = [a, b];
    const rebuilt = [{ ...a, content: { kind: 'text', parts: ['hi'] } }, { ...b }];
    expect(reuseUnchangedRows(prev, rebuilt, key)).toBe(prev);
  });

  it('keeps unchanged row objects and takes the changed and new ones', () => {
    const prev = [a, b];
    const editedB = { id: 'b', text: 'yo!' };
    const c = { id: 'c', text: 'new' };
    const out = reuseUnchangedRows(prev, [{ ...a }, editedB, c], key);
    expect(out).not.toBe(prev);
    expect(out[0]).toBe(a);
    expect(out[1]).toBe(editedB);
    expect(out[2]).toBe(c);
  });

  it('follows the new order (a reorder or a removal is a change)', () => {
    const prev = [a, b];
    const reordered = reuseUnchangedRows(prev, [{ ...b }, { ...a }], key);
    expect(reordered).not.toBe(prev);
    expect(reordered[0]).toBe(b);
    expect(reordered[1]).toBe(a);
    const removed = reuseUnchangedRows(prev, [{ ...a }], key);
    expect(removed).toEqual([a]);
    expect(removed[0]).toBe(a);
    expect(removed).not.toBe(prev);
  });
});
