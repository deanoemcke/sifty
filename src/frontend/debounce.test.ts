import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { debounce } from "./debounce";

describe("debounce", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("delays invocation until after the wait time has elapsed", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 500);

    debounced();
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(499);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("resets the timer on each call, only firing once for a burst", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 500);

    debounced();
    vi.advanceTimersByTime(300);
    debounced();
    vi.advanceTimersByTime(300);
    debounced();
    vi.advanceTimersByTime(499);
    expect(fn).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("passes through the arguments from the most recent call", () => {
    const fn = vi.fn();
    const debounced = debounce(fn, 500);

    debounced("first");
    debounced("second");
    vi.advanceTimersByTime(500);

    expect(fn).toHaveBeenCalledExactlyOnceWith("second");
  });
});
