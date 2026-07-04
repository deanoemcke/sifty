// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  allowShippingFromFulfillment,
  fulfillmentFromAllowShipping,
  populateRegionSelect,
} from "./discoveryForm";

const REGIONS = [
  { value: "1", display: "Auckland" },
  { value: "12", display: "Wellington" },
  { value: "14", display: "Canterbury" },
];

describe("fulfillmentFromAllowShipping", () => {
  it("maps an allow-shipping tick to the any fulfillment", () => {
    expect(fulfillmentFromAllowShipping(true)).toBe("any");
  });

  it("maps an unticked box to pickup-only fulfillment", () => {
    expect(fulfillmentFromAllowShipping(false)).toBe("pickup");
  });
});

describe("allowShippingFromFulfillment", () => {
  it("unticks the box only for pickup-only searches", () => {
    expect(allowShippingFromFulfillment("pickup")).toBe(false);
    expect(allowShippingFromFulfillment("any")).toBe(true);
    expect(allowShippingFromFulfillment("shipping")).toBe(true);
  });

  it("defaults to allowing shipping when a saved search has no fulfillment", () => {
    expect(allowShippingFromFulfillment(undefined)).toBe(true);
  });
});

describe("populateRegionSelect", () => {
  it("adds an option per region", () => {
    const select = document.createElement("select");
    populateRegionSelect(select, REGIONS, "Wellington");
    expect([...select.options].map((option) => option.textContent)).toEqual([
      "Auckland",
      "Wellington",
      "Canterbury",
    ]);
  });

  it("selects the default region by display name", () => {
    const select = document.createElement("select");
    populateRegionSelect(select, REGIONS, "Wellington");
    expect(select.value).toBe("12");
  });

  it("keeps the browser default selection when the default display name is unknown", () => {
    const select = document.createElement("select");
    populateRegionSelect(select, REGIONS, "Atlantis");
    expect(select.value).toBe("1");
  });
});
