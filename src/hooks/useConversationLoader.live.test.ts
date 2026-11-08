import { act, renderHook } from '@testing-library/react-native';
import { useConversationLoader, type UseConversationLoaderParams } from './useConversationLoader';
import { notifyDmMessage } from '../contexts/nostrEventBus';
import { notifyDmStorage } from '../services/dmStorageEvents';
import type { ConversationMessage } from '../contexts/nostrContextTypes';
import type { DmMessageRow } from '../services/dmDb';
import { LIVE_REFRESH_COALESCE_MS, LIVE_REFRESH_GAP_MS } from '../utils/conversationLiveRefresh';

jest.mock('@react-navigation/native', () => ({
  useFocusEffect: (callback: () => void) => {
    const React = jest.requireActual('react');
    React.useEffect(callback, [callback]);
  },
}));

const ME = 'a'.repeat(64);
const PEER = 'b'.repeat(64);

const message = (id: string, createdAt: number): ConversationMessage => ({
  id,
  fromMe: false,
  text: id,
  createdAt,
  wireKind: 14,
});

const committedRow = (eventId: string): DmMessageRow => ({
  owner: ME,
  eventId,
  conversation: PEER,
  createdAt: 2,
  sender: PEER,
  content: eventId,
  fromMe: false,
  wireKind: 14,
});

function setup(overrides: Partial<UseConversationLoaderParams> = {}) {
  let stored: ConversationMessage[] = [message('m1', 1)];
  const loadInitialConversation = jest.fn(async () => stored);
  const fetchConversation = jest.fn(async () => stored);
  const persistDeliveryStatuses = jest.fn(async () => undefined);
  const params: UseConversationLoaderParams = {
    notification: { owner: ME },
    pubkey: PEER,
    protocol: 'nip17',
    isLoggedIn: true,
    fetchConversation,
    loadInitialConversation,
    persistDeliveryStatuses,
    ...overrides,
  };
  const hook = renderHook(() => useConversationLoader(params));
  const setStored = (next: ConversationMessage[]) => {
    stored = next;
  };
  return { hook, fetchConversation, loadInitialConversation, setStored };
}

const flush = async (ms = 0) => {
  await act(async () => {
    jest.advanceTimersByTime(ms);
  });
};

describe('useConversationLoader', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('fetches from the relays when the thread opens', async () => {
    const { hook, fetchConversation } = setup();
    await flush();
    expect(fetchConversation).toHaveBeenCalledTimes(1);
    expect(fetchConversation).toHaveBeenCalledWith(
      PEER,
      expect.objectContaining({ protocol: 'nip17' }),
    );
    expect(hook.result.current.messages.map((m) => m.id)).toEqual(['m1']);
    expect(hook.result.current.loading).toBe(false);
  });

  it('answers a live message with a store read, not a relay fetch', async () => {
    const { hook, fetchConversation, loadInitialConversation, setStored } = setup();
    await flush();
    const storeReadsAfterOpen = loadInitialConversation.mock.calls.length;

    setStored([message('m1', 1), message('m2', 2)]);
    await act(async () => {
      notifyDmMessage(PEER);
      notifyDmStorage([committedRow('m2')]);
    });
    await flush(LIVE_REFRESH_COALESCE_MS);
    // Well past the gap window: the commit covered it, so no relay fallback.
    await flush(LIVE_REFRESH_GAP_MS * 2);

    expect(fetchConversation).toHaveBeenCalledTimes(1);
    expect(loadInitialConversation).toHaveBeenCalledTimes(storeReadsAfterOpen + 1);
    expect(hook.result.current.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
  });

  it('ignores live traffic for other threads', async () => {
    const { fetchConversation, loadInitialConversation } = setup();
    await flush();
    const storeReadsAfterOpen = loadInitialConversation.mock.calls.length;
    await act(async () => {
      notifyDmMessage('c'.repeat(64));
      notifyDmStorage([{ ...committedRow('x'), conversation: 'c'.repeat(64) }]);
    });
    await flush(LIVE_REFRESH_GAP_MS * 2);
    expect(loadInitialConversation).toHaveBeenCalledTimes(storeReadsAfterOpen);
    expect(fetchConversation).toHaveBeenCalledTimes(1);
  });

  it('falls back to one relay fetch when a live message never reaches the store', async () => {
    const { fetchConversation } = setup();
    await flush();
    await act(async () => {
      notifyDmMessage(PEER);
    });
    await flush(LIVE_REFRESH_GAP_MS);
    expect(fetchConversation).toHaveBeenCalledTimes(2);
  });

  it('never fetches Marmot threads from the relays, live or not', async () => {
    const { fetchConversation, loadInitialConversation } = setup({ protocol: 'marmot' });
    await flush();
    await act(async () => {
      notifyDmMessage(PEER);
    });
    await flush(LIVE_REFRESH_GAP_MS * 2);
    expect(fetchConversation).not.toHaveBeenCalled();
    expect(loadInitialConversation.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('fetches from the relays on pull-to-refresh', async () => {
    const { hook, fetchConversation } = setup();
    await flush();
    await act(async () => {
      await hook.result.current.handleRefresh();
    });
    expect(fetchConversation).toHaveBeenCalledTimes(2);
    expect(hook.result.current.refreshing).toBe(false);
  });

  it('re-reads the store when a message lands while the open fetch is in flight', async () => {
    let resolveFetch: (rows: ConversationMessage[]) => void = () => undefined;
    const fetchConversation = jest.fn(
      () =>
        new Promise<ConversationMessage[]>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    const { hook, loadInitialConversation, setStored } = setup({ fetchConversation });
    await flush();
    // The live row commits (and its own store read lands) mid-fetch...
    setStored([message('m1', 1), message('m2', 2)]);
    await act(async () => {
      notifyDmStorage([committedRow('m2')]);
    });
    await flush(LIVE_REFRESH_COALESCE_MS);
    const readsBeforeFetchLands = loadInitialConversation.mock.calls.length;
    // ...then the fetch resolves with its older slice and replaces the list.
    await act(async () => {
      resolveFetch([message('m1', 1)]);
    });
    await flush(LIVE_REFRESH_COALESCE_MS);
    expect(loadInitialConversation).toHaveBeenCalledTimes(readsBeforeFetchLands + 1);
    expect(hook.result.current.messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(fetchConversation).toHaveBeenCalledTimes(1);
  });
});
