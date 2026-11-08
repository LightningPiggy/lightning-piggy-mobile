import { renderHook } from '@testing-library/react-native';
import type { RelayConfig } from '../types/nostr';
import { useStableRelayList } from './useStableRelayList';
import { useReadRelays } from './useReadRelays';
import { useAppNetworkRelays } from './useAppNetworkRelays';

jest.mock('../services/nostrService', () => ({ DEFAULT_RELAYS: ['wss://default.example'] }));

const rw = (url: string, read = true, write = true): RelayConfig => ({ url, read, write });
type GetterProps = { get: () => string[] };
type ReadProps = { relays: RelayConfig[]; inbox: string[] };
type Nip65Props = { nip65: RelayConfig[] };

describe('useStableRelayList', () => {
  it('keeps the same array for a new getter that returns the same relay set', () => {
    const { result, rerender } = renderHook(({ get }: GetterProps) => useStableRelayList(get), {
      initialProps: { get: () => ['wss://a.example', 'wss://b.example'] },
    });
    const first = result.current;
    rerender({ get: () => ['wss://b.example/', 'wss://A.example'] });
    expect(result.current).toBe(first);
  });

  it('returns a new array when the relay set changes', () => {
    const { result, rerender } = renderHook(({ get }: GetterProps) => useStableRelayList(get), {
      initialProps: { get: () => ['wss://a.example'] },
    });
    const first = result.current;
    rerender({ get: () => ['wss://a.example', 'wss://c.example'] });
    expect(result.current).not.toBe(first);
    expect(result.current).toEqual(['wss://a.example', 'wss://c.example']);
  });
});

describe('useReadRelays', () => {
  it('keeps the getter identity when the relay lists are re-parsed with the same entries', () => {
    const { result, rerender } = renderHook(
      ({ relays, inbox }: ReadProps) => useReadRelays(relays, inbox),
      {
        initialProps: {
          relays: [rw('wss://a.example'), rw('wss://w.example', false)],
          inbox: ['wss://dm.example'],
        },
      },
    );
    const getter = result.current;
    expect(getter()).toEqual(['wss://a.example', 'wss://dm.example']);
    rerender({
      relays: [rw('wss://a.example'), rw('wss://w.example', false)],
      inbox: ['wss://dm.example'],
    });
    expect(result.current).toBe(getter);
  });

  it('changes the getter when a read relay or DM inbox relay changes', () => {
    const { result, rerender } = renderHook(
      ({ relays, inbox }: ReadProps) => useReadRelays(relays, inbox),
      {
        initialProps: { relays: [rw('wss://a.example')], inbox: [] as string[] },
      },
    );
    const first = result.current;
    rerender({ relays: [rw('wss://a.example')], inbox: ['wss://dm.example'] });
    const second = result.current;
    expect(second).not.toBe(first);
    expect(second()).toEqual(['wss://a.example', 'wss://dm.example']);
    // A relay switched to write-only drops out of the read set.
    rerender({ relays: [rw('wss://a.example', false)], inbox: ['wss://dm.example'] });
    expect(result.current).not.toBe(second);
  });

  it('hands every caller its own copy', () => {
    const { result } = renderHook(() => useReadRelays([rw('wss://a.example')], []));
    const list = result.current();
    list.push('wss://mutated.example');
    expect(result.current()).toEqual(['wss://a.example']);
  });
});

describe('useAppNetworkRelays', () => {
  it('keeps the merged list identity for a re-parsed, identical NIP-65 list', () => {
    const { result, rerender } = renderHook(
      ({ nip65 }: Nip65Props) => useAppNetworkRelays(null, nip65, []),
      {
        initialProps: { nip65: [rw('wss://a.example')] },
      },
    );
    const first = result.current;
    rerender({ nip65: [rw('wss://a.example')] });
    expect(result.current).toBe(first);
  });

  it('returns a new list when the NIP-65 list really changes', () => {
    const { result, rerender } = renderHook(
      ({ nip65 }: Nip65Props) => useAppNetworkRelays(null, nip65, []),
      {
        initialProps: { nip65: [rw('wss://a.example')] },
      },
    );
    const first = result.current;
    rerender({ nip65: [rw('wss://a.example', true, false)] });
    expect(result.current).not.toBe(first);
  });
});
