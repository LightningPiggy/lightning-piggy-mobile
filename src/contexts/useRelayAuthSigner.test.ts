import { renderHook } from '@testing-library/react-native';
import { useRelayAuthSigner } from './useRelayAuthSigner';
import { setRelayAuthAccount } from '../services/relayAuth';
import { signAccountEvent } from '../services/signAccountEvent';

jest.mock('../services/relayAuth', () => ({ setRelayAuthAccount: jest.fn() }));
jest.mock('../services/signAccountEvent', () => ({ signAccountEvent: jest.fn() }));

afterEach(() => jest.clearAllMocks());

test('registers only own inbox and NIP-65 read relays and uses the active signer', async () => {
  const { result, unmount } = renderHook(() =>
    useRelayAuthSigner(
      'active',
      true,
      'amber',
      [
        { url: 'wss://read.example', read: true, write: false },
        { url: 'wss://write.example', read: false, write: true },
      ],
      ['wss://inbox.example'],
    ),
  );
  expect(setRelayAuthAccount).toHaveBeenLastCalledWith({
    pubkey: 'active',
    signerType: 'amber',
    ownRelays: ['wss://inbox.example', 'wss://read.example'],
    sign: result.current,
  });
  const event = { kind: 22242, created_at: 1, tags: [], content: '' };
  await result.current(event);
  expect(signAccountEvent).toHaveBeenCalledWith(event, {
    pubkey: 'active',
    isLoggedIn: true,
    signerType: 'amber',
  });
  unmount();
  expect(setRelayAuthAccount).toHaveBeenLastCalledWith(null);
});

test('account changes replace the signer and logout removes it', () => {
  const { rerender } = renderHook(
    ({ pubkey, loggedIn }: { pubkey: string; loggedIn: boolean }) =>
      useRelayAuthSigner(pubkey, loggedIn, 'nip46', [], []),
    { initialProps: { pubkey: 'first', loggedIn: true } },
  );
  rerender({ pubkey: 'second', loggedIn: true });
  expect(setRelayAuthAccount).toHaveBeenLastCalledWith(
    expect.objectContaining({ pubkey: 'second' }),
  );
  rerender({ pubkey: 'second', loggedIn: false });
  expect(setRelayAuthAccount).toHaveBeenLastCalledWith(null);
});
