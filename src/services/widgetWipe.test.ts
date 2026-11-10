const mockWipeAppGroup = jest.fn();

jest.mock('./widgetAppGroup', () => ({
  wipeWidgetAppGroup: () => mockWipeAppGroup(),
  mirrorWidgetSnapshot: jest.fn(),
}));

import { handleWidgetAccountChange, wipeAllWidgetSnapshots } from './widgetWipe';
import { createWidgetSnapshotWriter } from './widgetSnapshotWriter';
import type { WidgetSnapshot } from './widgetSnapshot';

const storageError = new Error('AsyncStorage removeItem failed');

const stored: WidgetSnapshot = { version: 1, locale: 'en', wallets: [] };

function writerWith(wipe: () => Promise<void>, previous: WidgetSnapshot | null = null) {
  const refresh = jest.fn<Promise<void>, [WidgetSnapshot | null]>(() => Promise.resolve());
  const writer = createWidgetSnapshotWriter({
    read: () => Promise.resolve(previous),
    write: () => Promise.resolve(),
    wipe,
    refresh,
    fetchedAt: () => null,
    debounceMs: 0,
  });
  return { writer, refresh };
}

beforeEach(() => jest.clearAllMocks());

describe('wipeAllWidgetSnapshots', () => {
  it('clears the App Group before the stored snapshot', async () => {
    const wipeStored = jest.fn(() => Promise.resolve());
    await wipeAllWidgetSnapshots(wipeStored);
    expect(mockWipeAppGroup).toHaveBeenCalledTimes(1);
    expect(mockWipeAppGroup.mock.invocationCallOrder[0]).toBeLessThan(
      wipeStored.mock.invocationCallOrder[0],
    );
  });

  it('still clears the App Group when removing the stored snapshot fails', async () => {
    await expect(wipeAllWidgetSnapshots(() => Promise.reject(storageError))).rejects.toBe(
      storageError,
    );
    expect(mockWipeAppGroup).toHaveBeenCalledTimes(1);
  });

  it('still removes the stored snapshot when the App Group wipe throws', async () => {
    mockWipeAppGroup.mockImplementationOnce(() => {
      throw new Error('native module missing');
    });
    const wipeStored = jest.fn(() => Promise.resolve());
    await wipeAllWidgetSnapshots(wipeStored);
    expect(wipeStored).toHaveBeenCalledTimes(1);
  });

  it('runs on the writer’s “no wallets left” path even when storage fails', async () => {
    const { writer, refresh } = writerWith(
      () => wipeAllWidgetSnapshots(() => Promise.reject(storageError)),
      stored,
    );
    writer.update({ wallets: [], hydrated: true, locale: 'en', btcPrice: null, currency: 'USD' });
    writer.dispose();
    await expect(writer.flush()).rejects.toBe(storageError);
    expect(mockWipeAppGroup).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('handleWidgetAccountChange', () => {
  it('clears the App Group at once, before the stored wipe settles', () => {
    const { writer } = writerWith(() => Promise.resolve());
    let settle!: () => void;
    const wiped = new Promise<void>((resolve) => {
      settle = resolve;
    });
    void handleWidgetAccountChange(writer, wiped);
    expect(mockWipeAppGroup).toHaveBeenCalledTimes(1);
    settle();
  });

  it('leaves no wallets in the App Group when the stored wipe rejects', async () => {
    const { writer, refresh } = writerWith(() => Promise.resolve());
    await expect(handleWidgetAccountChange(writer, Promise.reject(storageError))).rejects.toBe(
      storageError,
    );
    // The writer skips its refresh(null) after a failed wipe…
    expect(refresh).not.toHaveBeenCalled();
    // …but the App Group was already cleared.
    expect(mockWipeAppGroup).toHaveBeenCalledTimes(1);
  });
});
