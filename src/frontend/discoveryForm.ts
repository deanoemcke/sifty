// Discovery form helpers — pure DOM/value mapping, no side effects at module scope.
// The "Allow shipping" checkbox is the UI for the Fulfillment search intent:
// ticked means pickup or shipping ("any"), unticked means pickup only.

import type { Fulfillment } from "../lib/recipes/base";
import type { DiscoverInputs } from "./state";

export type RegionOption = { value: string; display: string };

export interface DiscoveryFormElements {
  promptInput: HTMLTextAreaElement;
  maxPriceInput: HTMLInputElement;
  allowShippingCheckbox: HTMLInputElement;
  regionSelect: HTMLSelectElement;
  discoveryButton: HTMLButtonElement;
}

export function fulfillmentFromAllowShipping(allowShipping: boolean): Fulfillment {
  return allowShipping ? "any" : "pickup";
}

export function allowShippingFromFulfillment(fulfillment: Fulfillment | undefined): boolean {
  return (fulfillment ?? "any") !== "pickup";
}

// Loading a saved search means its sift has already run, so the button starts
// disabled regardless of input validity; editing any discovery input re-enables it.
export function applyLoadedDiscoverInputs(
  elements: DiscoveryFormElements,
  inputs: DiscoverInputs | undefined,
): void {
  elements.discoveryButton.disabled = true;
  if (!inputs) return;
  elements.promptInput.value = inputs.prompt ?? "";
  elements.maxPriceInput.value = inputs.maxPrice != null ? String(inputs.maxPrice) : "";
  elements.allowShippingCheckbox.checked = allowShippingFromFulfillment(inputs.fulfillment);
  // No region in the saved inputs keeps the current selection (Wellington default).
  if (inputs.region) elements.regionSelect.value = inputs.region;
}

export function populateRegionSelect(
  select: HTMLSelectElement,
  regions: RegionOption[],
  defaultDisplay: string,
): void {
  for (const region of regions) {
    const option = select.ownerDocument.createElement("option");
    option.value = region.value;
    option.textContent = region.display;
    option.selected = region.display === defaultDisplay;
    select.appendChild(option);
  }
}
