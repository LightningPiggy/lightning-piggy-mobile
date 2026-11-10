import { renderHook } from '@testing-library/react-native';
import { useTrustedAuthors } from './useTrustedAuthors';

type Props = { trustSet: ReadonlySet<string>; pubkey: string | null };

const render = (initial: Props) =>
  renderHook(({ trustSet, pubkey }: Props) => useTrustedAuthors(trustSet, pubkey), {
    initialProps: initial,
  });

describe('useTrustedAuthors (#1789)', () => {
  it('drops the signed-in user, case-insensitively', () => {
    const { result } = render({ trustSet: new Set(['me', 'bob', 'alice']), pubkey: 'ME' });
    expect(result.current).toEqual(['alice', 'bob']);
  });

  it('returns an empty list when signed out', () => {
    const { result } = render({ trustSet: new Set(['bob']), pubkey: null });
    expect(result.current).toEqual([]);
  });

  it('keeps the same array when the trust set is rebuilt with the same members', () => {
    // My Piglets keys the friends'-finds REQ on this array; a new identity
    // would re-send a REQ carrying up to 2,000 authors.
    const { result, rerender } = render({ trustSet: new Set(['a', 'b', 'me']), pubkey: 'me' });
    const first = result.current;
    rerender({ trustSet: new Set(['me', 'b', 'a']), pubkey: 'me' });
    expect(result.current).toBe(first);
  });

  it('returns a new array when the members change', () => {
    const { result, rerender } = render({ trustSet: new Set(['a', 'me']), pubkey: 'me' });
    const first = result.current;
    rerender({ trustSet: new Set(['a', 'c', 'me']), pubkey: 'me' });
    expect(result.current).not.toBe(first);
    expect(result.current).toEqual(['a', 'c']);
  });
});
