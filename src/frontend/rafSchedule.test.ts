// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { rafSchedule } from './rafSchedule';

describe('rafSchedule', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('does not invoke the function before the next animation frame', () => {
    const fn = vi.fn();
    const scheduled = rafSchedule(fn);

    scheduled('a');
    expect(fn).not.toHaveBeenCalled();
  });

  it('invokes the function once the frame fires', () => {
    const fn = vi.fn();
    const scheduled = rafSchedule(fn);

    scheduled('a');
    vi.advanceTimersByTime(20);
    expect(fn).toHaveBeenCalledExactlyOnceWith('a');
  });

  it('coalesces a burst of calls within the same frame into a single invocation using the last arguments', () => {
    const fn = vi.fn();
    const scheduled = rafSchedule(fn);

    scheduled('first');
    scheduled('second');
    scheduled('third');
    vi.advanceTimersByTime(20);

    expect(fn).toHaveBeenCalledExactlyOnceWith('third');
  });

  it('only requests a single animation frame for a burst of calls', () => {
    const rafSpy = vi.spyOn(globalThis, 'requestAnimationFrame');
    const scheduled = rafSchedule(vi.fn());

    scheduled();
    scheduled();
    scheduled();

    expect(rafSpy).toHaveBeenCalledTimes(1);
  });

  it('schedules a new frame for calls made after the previous frame fired', () => {
    const fn = vi.fn();
    const scheduled = rafSchedule(fn);

    scheduled('first');
    vi.advanceTimersByTime(20);
    scheduled('second');
    vi.advanceTimersByTime(20);

    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(2, 'second');
  });

  describe('cancel', () => {
    it('drops a pending call so the frame that fires never invokes the function', () => {
      const fn = vi.fn();
      const scheduled = rafSchedule(fn);

      scheduled('a');
      scheduled.cancel();
      vi.advanceTimersByTime(20);

      expect(fn).not.toHaveBeenCalled();
    });

    it('lets a later call schedule a fresh frame after a cancel', () => {
      const fn = vi.fn();
      const scheduled = rafSchedule(fn);

      scheduled('a');
      scheduled.cancel();
      scheduled('b');
      vi.advanceTimersByTime(20);

      expect(fn).toHaveBeenCalledExactlyOnceWith('b');
    });

    it('is a no-op when nothing is pending', () => {
      const fn = vi.fn();
      const scheduled = rafSchedule(fn);

      expect(() => scheduled.cancel()).not.toThrow();
      scheduled('a');
      vi.advanceTimersByTime(20);
      expect(fn).toHaveBeenCalledExactlyOnceWith('a');
    });
  });
});
