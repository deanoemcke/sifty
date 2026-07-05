import { describe, expect, it } from "vitest";
import { decideModalDeepSearchAction } from "./deepSearchTrigger";

describe("decideModalDeepSearchAction", () => {
  it("does nothing once the listing has already been deep searched", () => {
    expect(
      decideModalDeepSearchAction({
        hasBeenDeepSearched: true,
        isCoveredByBulkSearch: false,
        isAlreadyFetchingSingle: false,
      }),
    ).toBe("none");
  });

  it("does nothing even if other flags are set, once already deep searched", () => {
    expect(
      decideModalDeepSearchAction({
        hasBeenDeepSearched: true,
        isCoveredByBulkSearch: true,
        isAlreadyFetchingSingle: true,
      }),
    ).toBe("none");
  });

  it("waits when the listing is already covered by an in-flight bulk search", () => {
    expect(
      decideModalDeepSearchAction({
        hasBeenDeepSearched: false,
        isCoveredByBulkSearch: true,
        isAlreadyFetchingSingle: false,
      }),
    ).toBe("wait");
  });

  it("waits when a single-listing fetch is already in flight for this listing", () => {
    expect(
      decideModalDeepSearchAction({
        hasBeenDeepSearched: false,
        isCoveredByBulkSearch: false,
        isAlreadyFetchingSingle: true,
      }),
    ).toBe("wait");
  });

  it("starts a new fetch when nothing else is covering this listing", () => {
    expect(
      decideModalDeepSearchAction({
        hasBeenDeepSearched: false,
        isCoveredByBulkSearch: false,
        isAlreadyFetchingSingle: false,
      }),
    ).toBe("start");
  });
});
