import * as nip19 from 'nostr-tools/nip19';
import { act, renderHook } from '@testing-library/react-native';
import type { TextInputSelectionChangeEvent } from 'react-native';
import { useMentionComposer } from './useMentionComposer';

const ME = 'a'.repeat(64);
const BOB = 'b'.repeat(64);
const members = [
  { pubkey: ME, name: 'Me', picture: null },
  { pubkey: BOB, name: 'Bob', picture: null },
];
const sel = (at: number) =>
  ({
    nativeEvent: { selection: { start: at, end: at } },
  }) as TextInputSelectionChangeEvent;

function setup() {
  let draft = '';
  const setDraft = jest.fn((next: string) => {
    draft = next;
  });
  const hook = renderHook(
    ({ text }: { text: string }) =>
      useMentionComposer({ draft: text, setDraft, members, selfPubkey: ME }),
    { initialProps: { text: draft } },
  );
  const type = (text: string) => {
    hook.rerender({ text });
    act(() => hook.result.current.onSelectionChange(sel(text.length)));
  };
  return { ...hook, type, setDraft, current: () => draft };
}

it('offers members (not me) after @ and inserts the pick', () => {
  const { result, type, setDraft, rerender } = setup();
  type('hi @b');
  expect(result.current.candidates.map((m) => m.name)).toEqual(['Bob']);
  act(() => result.current.pick(members[1]));
  expect(setDraft).toHaveBeenLastCalledWith('hi @Bob ');
  expect(result.current.selection).toEqual({ start: 8, end: 8 });
  rerender({ text: 'hi @Bob ' });
  expect(result.current.candidates).toEqual([]);
});

it('encodes picked names to nostr:npub on send, and forgets picks once cleared', () => {
  const { result, type, rerender } = setup();
  type('@');
  act(() => result.current.pick(members[1]));
  rerender({ text: '@Bob how are you' });
  expect(result.current.encode('@Bob how are you')).toBe(
    `nostr:${nip19.npubEncode(BOB)} how are you`,
  );
  // A failed send restores the text: its mention must still encode.
  rerender({ text: '' });
  expect(result.current.encode('@Bob again')).toBe(`nostr:${nip19.npubEncode(BOB)} again`);
});

it('keeps two members with the same name apart', () => {
  const twins = [
    { pubkey: BOB, name: 'Alex', picture: null },
    { pubkey: 'c'.repeat(64), name: 'Alex', picture: null },
  ];
  let draft = '';
  const setDraft = jest.fn((next: string) => {
    draft = next;
  });
  const { result, rerender } = renderHook(
    ({ text }: { text: string }) =>
      useMentionComposer({ draft: text, setDraft, members: twins, selfPubkey: ME }),
    { initialProps: { text: '@' } },
  );
  act(() => result.current.onSelectionChange(sel(1)));
  act(() => result.current.pick(twins[0]));
  rerender({ text: `${draft}@` });
  act(() => result.current.onSelectionChange(sel(draft.length + 1)));
  act(() => result.current.pick(twins[1]));
  expect(draft).toBe('@Alex @Alex (cccc) ');
  expect(result.current.encode(draft)).toBe(
    `nostr:${nip19.npubEncode(BOB)} nostr:${nip19.npubEncode('c'.repeat(64))} `,
  );
});

it('hides the picker when nothing matches', () => {
  const { result, type } = setup();
  type('@zed');
  expect(result.current.candidates).toEqual([]);
});
