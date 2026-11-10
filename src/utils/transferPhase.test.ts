/**
 * Unit tests for the transfer phase state machine (issue #62).
 *
 * The Transfer sheet drives this state machine as the underlying
 * transfer flow progresses; the renderer reads the result. These
 * tests pin down transitions + error handling so the UI cannot drift
 * out of sync with the actual transfer steps.
 */

import {
  STEPS_BY_TYPE,
  advanceTransfer,
  completeTransfer,
  failTransfer,
  idleProgress,
  isTransferStopped,
  startTransfer,
  transferChecklistSteps,
  unknownTransfer,
} from './transferPhase';

describe('transferPhase state machine', () => {
  describe('idleProgress', () => {
    it('returns an empty idle progress', () => {
      const p = idleProgress();
      expect(p.phase).toBe('idle');
      expect(p.steps).toEqual([]);
      expect(p.activeIndex).toBe(0);
      expect(p.errorMessage).toBeUndefined();
    });
  });

  describe('startTransfer', () => {
    it('flips phase to in-progress and seeds steps for ln-to-ln', () => {
      const p = startTransfer('ln-to-ln');
      expect(p.phase).toBe('in-progress');
      expect(p.steps).toEqual(STEPS_BY_TYPE['ln-to-ln']);
      expect(p.activeIndex).toBe(0);
    });

    it('seeds three rows for onchain-to-ln (swap, broadcast, handoff)', () => {
      const p = startTransfer('onchain-to-ln');
      expect(p.steps.map((s) => s.id)).toEqual(['swap', 'broadcast', 'handoff']);
    });

    it('seeds two rows for ln-to-onchain (swap, handoff)', () => {
      const p = startTransfer('ln-to-onchain');
      expect(p.steps.map((s) => s.id)).toEqual(['swap', 'handoff']);
    });

    it('seeds two rows for onchain-to-onchain (broadcast, refresh)', () => {
      const p = startTransfer('onchain-to-onchain');
      expect(p.steps.map((s) => s.id)).toEqual(['broadcast', 'refresh']);
    });
  });

  describe('advanceTransfer', () => {
    it('walks the active index forward through ln-to-ln', () => {
      const p0 = startTransfer('ln-to-ln');
      const p1 = advanceTransfer(p0);
      expect(p1.activeIndex).toBe(1);
      expect(p1.phase).toBe('in-progress');

      const p2 = advanceTransfer(p1);
      expect(p2.activeIndex).toBe(2);
      expect(p2.phase).toBe('in-progress');
    });

    it('lands on done when advancing past the final step', () => {
      let p = startTransfer('ln-to-ln'); // 3 steps
      p = advanceTransfer(p); // 1
      p = advanceTransfer(p); // 2
      p = advanceTransfer(p); // would be 3 → done
      expect(p.phase).toBe('done');
      expect(p.activeIndex).toBe(p.steps.length);
    });

    it('is a no-op once phase is done', () => {
      const done = completeTransfer(startTransfer('ln-to-ln'));
      const after = advanceTransfer(done);
      expect(after).toEqual(done);
    });

    it('is a no-op when idle', () => {
      const idle = idleProgress();
      const after = advanceTransfer(idle);
      expect(after).toEqual(idle);
    });

    it('is a no-op once phase is failed', () => {
      const failed = failTransfer(startTransfer('ln-to-ln'), 'oops');
      const after = advanceTransfer(failed);
      expect(after).toEqual(failed);
    });
  });

  describe('completeTransfer', () => {
    it('marks every step complete and flips phase to done', () => {
      const p = completeTransfer(startTransfer('onchain-to-onchain'));
      expect(p.phase).toBe('done');
      expect(p.activeIndex).toBe(p.steps.length);
    });

    it('clears a stale errorMessage when completing (e.g. after a retry)', () => {
      // Simulate a progress value that still carries an error from an
      // earlier failed attempt, then complete it: the terminal success
      // state must not leak the old error.
      const failed = failTransfer(startTransfer('ln-to-ln'), 'first attempt failed');
      expect(failed.errorMessage).toBe('first attempt failed');
      const completed = completeTransfer({ ...failed, phase: 'in-progress' });
      expect(completed.phase).toBe('done');
      expect(completed.errorMessage).toBeUndefined();
    });
  });

  describe('failTransfer', () => {
    it('captures the failing step + error message without advancing', () => {
      const inflight = advanceTransfer(startTransfer('onchain-to-ln')); // index 1
      const failed = failTransfer(inflight, 'broadcast rejected');
      expect(failed.phase).toBe('failed');
      expect(failed.activeIndex).toBe(1);
      expect(failed.errorMessage).toBe('broadcast rejected');
    });

    it('is a no-op once phase is done (a late error cannot un-complete)', () => {
      const done = completeTransfer(startTransfer('ln-to-ln'));
      const after = failTransfer(done, 'too late');
      expect(after).toEqual(done);
      expect(after.phase).toBe('done');
      expect(after.errorMessage).toBeUndefined();
    });

    it('is a no-op when idle', () => {
      const idle = idleProgress();
      const after = failTransfer(idle, 'nothing running');
      expect(after).toEqual(idle);
    });

    it('is a no-op once already failed (keeps the first error)', () => {
      const failed = failTransfer(startTransfer('ln-to-ln'), 'first error');
      const again = failTransfer(failed, 'second error');
      expect(again).toEqual(failed);
      expect(again.errorMessage).toBe('first error');
    });
  });
});

describe('transferChecklistSteps', () => {
  const statuses = (p: ReturnType<typeof startTransfer>, suppress = false) =>
    transferChecklistSteps(p, suppress).map((s) => s.status);

  it('marks rows complete / active / pending as the move advances', () => {
    const p = advanceTransfer(startTransfer('onchain-to-ln'));
    expect(statuses(p)).toEqual(['complete', 'active', 'pending']);
    expect(statuses(completeTransfer(p))).toEqual(['complete', 'complete', 'complete']);
  });

  it('marks the failing row failed', () => {
    const p = failTransfer(advanceTransfer(startTransfer('onchain-to-ln')), 'boom');
    expect(statuses(p)).toEqual(['complete', 'failed', 'pending']);
  });

  it('suppresses the spinner once the background task errored', () => {
    expect(statuses(startTransfer('ln-to-onchain'), true)).toEqual(['pending', 'pending']);
  });

  // #1778: a lost reply after paying is not a failure — no ✗ on the pay row.
  it('renders an unknown outcome without a failed row and keeps the view up', () => {
    const paying = advanceTransfer(startTransfer('ln-to-ln')); // invoice ✓, pay in flight
    const unknown = unknownTransfer(paying, 'may still have moved');
    expect(unknown).toMatchObject({ phase: 'unknown', errorMessage: 'may still have moved' });
    expect(statuses(unknown, false)).toEqual(['complete', 'pending', 'pending']);
    expect(isTransferStopped(unknown)).toBe(true);
    expect(isTransferStopped(failTransfer(paying, 'x'))).toBe(true);
    expect(isTransferStopped(paying)).toBe(false);
    // Like failTransfer, a late call can't rewrite a finished transfer.
    const done = completeTransfer(paying);
    expect(unknownTransfer(done, 'late')).toBe(done);
  });
});
