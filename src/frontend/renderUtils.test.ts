import { describe, expect, it } from "vitest";
import { shouldDisableUpdateBtn } from "./renderUtils";

describe("shouldDisableUpdateBtn", () => {
  it("is disabled when isFilterCurrent is true and isAiFilterRunning is false", () => {
    expect(shouldDisableUpdateBtn({ isFilterCurrent: true, isAiFilterRunning: false })).toBe(true);
  });

  it("is disabled when isAiFilterRunning is true and isFilterCurrent is false", () => {
    expect(shouldDisableUpdateBtn({ isFilterCurrent: false, isAiFilterRunning: true })).toBe(true);
  });

  it("is disabled when both isFilterCurrent and isAiFilterRunning are true", () => {
    expect(shouldDisableUpdateBtn({ isFilterCurrent: true, isAiFilterRunning: true })).toBe(true);
  });

  it("is enabled when isAiFilterRunning transitions to false and isFilterCurrent is false", () => {
    // This is the bug scenario: button was hidden while isAiFilterRunning was true,
    // then isAiFilterRunning becomes false and isFilterCurrent is still false.
    // The disabled attribute must be false so the button is interactive when it reappears.
    expect(shouldDisableUpdateBtn({ isFilterCurrent: false, isAiFilterRunning: false })).toBe(
      false,
    );
  });
});
