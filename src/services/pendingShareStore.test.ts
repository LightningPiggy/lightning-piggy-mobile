import {
  clearPendingShare,
  PENDING_SHARE_TTL_MS,
  stagePendingShare,
  subscribePendingShare,
  takePendingShare,
} from './pendingShareStore';
import { deleteShareCopies } from './sharedFiles';
import type { IncomingShare } from '../utils/incomingShare';

jest.mock('./sharedFiles', () => ({ deleteShareCopies: jest.fn() }));
const mockDelete = deleteShareCopies as jest.Mock;

const share = (n: number): IncomingShare => ({
  text: `text ${n}`,
  images: [{ uri: `file:///cache/lp-share/${n}.jpg`, mimeType: 'image/jpeg' }],
  discard: [`file:///cache/lp-share/${n}-extra.jpg`],
});

beforeEach(() => {
  clearPendingShare();
  mockDelete.mockClear();
});

describe('pendingShareStore', () => {
  it('hands the share to its chat once, for the account that chose it', () => {
    stagePendingShare('dm:nip17:bob', 'ALICE', share(1), 1000);
    expect(takePendingShare('dm:marmot:bob', 'alice', 1000)).toBeNull();
    expect(takePendingShare('dm:nip17:bob', 'alice', 2000)).toEqual(share(1));
    expect(takePendingShare('dm:nip17:bob', 'alice', 2000)).toBeNull();
    expect(mockDelete).not.toHaveBeenCalled();
  });

  it('drops (and deletes) a share taken under another account', () => {
    stagePendingShare('group:g1', 'alice', share(1), 0);
    expect(takePendingShare('group:g1', 'mallory', 0)).toBeNull();
    expect(mockDelete).toHaveBeenCalledWith([
      'file:///cache/lp-share/1.jpg',
      'file:///cache/lp-share/1-extra.jpg',
    ]);
    // …and it's gone for the right account too.
    expect(takePendingShare('group:g1', 'alice', 0)).toBeNull();
  });

  it('drops (and deletes) a share nobody opened in time', () => {
    stagePendingShare('group:g1', 'alice', share(1), 0);
    expect(takePendingShare('group:g1', 'alice', PENDING_SHARE_TTL_MS + 1)).toBeNull();
    expect(mockDelete).toHaveBeenCalledTimes(1);
  });

  it('expires a share on its own when its chat never opens', () => {
    jest.useFakeTimers();
    try {
      stagePendingShare('group:g1', 'alice', share(1));
      jest.advanceTimersByTime(PENDING_SHARE_TTL_MS - 1);
      expect(mockDelete).not.toHaveBeenCalled();
      jest.advanceTimersByTime(1);
      expect(mockDelete).toHaveBeenCalledTimes(1);
      expect(takePendingShare('group:g1', 'alice')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('cancels the expiry once the share is taken or replaced', () => {
    jest.useFakeTimers();
    try {
      stagePendingShare('group:g1', 'alice', share(1));
      expect(takePendingShare('group:g1', 'alice')).toEqual(share(1));
      stagePendingShare('group:g2', 'alice', share(2));
      jest.advanceTimersByTime(PENDING_SHARE_TTL_MS / 2);
      stagePendingShare('group:g3', 'alice', share(3));
      mockDelete.mockClear();
      // g2's timer would have fired here; only g3's is armed.
      jest.advanceTimersByTime(PENDING_SHARE_TTL_MS / 2);
      expect(mockDelete).not.toHaveBeenCalled();
      expect(jest.getTimerCount()).toBe(1);
      expect(takePendingShare('group:g3', 'alice')).toEqual(share(3));
      expect(jest.getTimerCount()).toBe(0);
    } finally {
      jest.useRealTimers();
    }
  });

  it('a newer share replaces (and deletes) the older one, and notifies listeners', () => {
    const listener = jest.fn();
    const unsubscribe = subscribePendingShare(listener);
    stagePendingShare('group:g1', 'alice', share(1));
    stagePendingShare('group:g2', 'alice', share(2));
    expect(listener).toHaveBeenCalledTimes(2);
    expect(mockDelete).toHaveBeenCalledWith([
      'file:///cache/lp-share/1.jpg',
      'file:///cache/lp-share/1-extra.jpg',
    ]);
    expect(takePendingShare('group:g1', 'alice')).toBeNull();
    expect(takePendingShare('group:g2', 'alice')).toEqual(share(2));
    unsubscribe();
    stagePendingShare('group:g3', 'alice', share(3));
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('clearPendingShare deletes whatever is staged', () => {
    stagePendingShare('group:g1', 'alice', share(1));
    clearPendingShare();
    expect(mockDelete).toHaveBeenCalledTimes(1);
    expect(takePendingShare('group:g1', 'alice')).toBeNull();
  });
});
