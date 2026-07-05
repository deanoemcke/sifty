import { describe, expect, it } from "vitest";
import { shouldDisableApplyFilterBtn } from "./renderUtils";

describe("shouldDisableApplyFilterBtn", () => {
  it("is disabled when isFilterCurrent is true and isAiFilterRunning is false", () => {
    expect(shouldDisableApplyFilterBtn({ isFilterCurrent: true, isAiFilterRunning: false })).toBe(true);
  });

  it("is disabled when isAiFilterRunning is true and isFilterCurrent is false", () => {
    expect(shouldDisableApplyFilterBtn({ isFilterCurrent: false, isAiFilterRunning: true })).toBe(true);
  });

  it("is disabled when both isFilterCurrent and isAiFilterRunning are true", () => {
    expect(shouldDisableApplyFilterBtn({ isFilterCurrent: true, isAiFilterRunning: true })).toBe(true);
  });

  it("is enabled when isAiFilterRunning transitions to false and isFilterCurrent is false", () => {
    // This is the bug scenario: button was hidden while isAiFilterRunning was true,
    // then isAiFilterRunning becomes false and isFilterCurrent is still false.
    // The disabled attribute must be false so the button is interactive when it reappears.
    expect(shouldDisableApplyFilterBtn({ isFilterCurrent: false, isAiFilterRunning: false })).toBe(
      false,
    );
  });
});
