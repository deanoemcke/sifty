// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  allowShippingFromFulfillment,
  applyLoadedDiscoverInputs,
  fulfillmentFromAllowShipping,
  populateRegionSelect,
  type DiscoveryFormElements,
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

function buildDiscoveryForm(): DiscoveryFormElements {
  const regionSelect = document.createElement("select");
  populateRegionSelect(regionSelect, REGIONS, "Wellington");
  const discoveryButton = document.createElement("button");
  const allowShippingCheckbox = document.createElement("input");
  allowShippingCheckbox.type = "checkbox";
  return {
    promptInput: document.createElement("textarea"),
    maxPriceInput: document.createElement("input"),
    allowShippingCheckbox,
    regionSelect,
    discoveryButton,
  };
}

describe("applyLoadedDiscoverInputs", () => {
  it("populates the form fields from the saved inputs", () => {
    const elements = buildDiscoveryForm();
    applyLoadedDiscoverInputs(elements, {
      prompt: "mid-century sideboard",
      maxPrice: 250,
      fulfillment: "pickup",
      region: "1",
    });
    expect(elements.promptInput.value).toBe("mid-century sideboard");
    expect(elements.maxPriceInput.value).toBe("250");
    expect(elements.allowShippingCheckbox.checked).toBe(false);
    expect(elements.regionSelect.value).toBe("1");
  });

  it("disables the discovery button even when the loaded inputs are valid", () => {
    const elements = buildDiscoveryForm();
    applyLoadedDiscoverInputs(elements, {
      prompt: "mid-century sideboard",
      maxPrice: 250,
      fulfillment: "any",
    });
    expect(elements.discoveryButton.disabled).toBe(true);
  });

  it("disables the discovery button when the saved search has no discover inputs", () => {
    const elements = buildDiscoveryForm();
    elements.promptInput.value = "leftover prompt";
    applyLoadedDiscoverInputs(elements, undefined);
    expect(elements.discoveryButton.disabled).toBe(true);
    expect(elements.promptInput.value).toBe("leftover prompt");
  });

  it("keeps the current region selection when the saved inputs have no region", () => {
    const elements = buildDiscoveryForm();
    applyLoadedDiscoverInputs(elements, {
      prompt: "mid-century sideboard",
      fulfillment: "any",
    });
    expect(elements.regionSelect.value).toBe("12");
  });

  it("clears the max price when the saved inputs have none", () => {
    const elements = buildDiscoveryForm();
    elements.maxPriceInput.value = "999";
    applyLoadedDiscoverInputs(elements, {
      prompt: "mid-century sideboard",
      fulfillment: "any",
    });
    expect(elements.maxPriceInput.value).toBe("");
  });
});
