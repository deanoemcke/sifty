import { describe, expect, it, vi } from "vitest";
import { scheduleAiFilterRun } from "./aiFilter";

describe("scheduleAiFilterRun", () => {
  it("calls runAiFilterAsync when the filter is not already running", () => {
    const runAiFilterAsync = vi.fn();
    const setAiFilterPendingRun = vi.fn();

    scheduleAiFilterRun({
      isAiFilterRunning: false,
      runAiFilterAsync,
      setAiFilterPendingRun,
    });

    expect(runAiFilterAsync).toHaveBeenCalledOnce();
    expect(setAiFilterPendingRun).not.toHaveBeenCalled();
  });

  it("sets aiFilterPendingRun to true and does not call runAiFilterAsync when the filter is already running", () => {
    const runAiFilterAsync = vi.fn();
    const setAiFilterPendingRun = vi.fn();

    scheduleAiFilterRun({
      isAiFilterRunning: true,
      runAiFilterAsync,
      setAiFilterPendingRun,
    });

    expect(setAiFilterPendingRun).toHaveBeenCalledOnce();
    expect(setAiFilterPendingRun).toHaveBeenCalledWith(true);
    expect(runAiFilterAsync).not.toHaveBeenCalled();
  });
});
