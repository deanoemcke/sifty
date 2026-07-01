import { describe, expect, it, vi } from "vitest";
import { fireAllCardSearches } from "./cardSearch";

describe("fireAllCardSearches", () => {
  it("calls the search function exactly once per card", () => {
    const cards = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const searchFn = vi.fn();
    fireAllCardSearches(cards, searchFn);
    expect(searchFn).toHaveBeenCalledTimes(3);
  });

  it("passes each card to the search function", () => {
    const cards = [{ id: "x" }, { id: "y" }];
    const searchFn = vi.fn();
    fireAllCardSearches(cards, searchFn);
    expect(searchFn).toHaveBeenNthCalledWith(1, cards[0]);
    expect(searchFn).toHaveBeenNthCalledWith(2, cards[1]);
  });

  it("does nothing when the card list is empty", () => {
    const searchFn = vi.fn();
    fireAllCardSearches([], searchFn);
    expect(searchFn).not.toHaveBeenCalled();
  });
});
