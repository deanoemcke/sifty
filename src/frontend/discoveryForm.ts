// Discovery form helpers — pure DOM/value mapping, no side effects at module scope.
// The "Allow shipping" checkbox is the UI for the Fulfillment search intent:
// ticked means pickup or shipping ("any"), unticked means pickup only.

import type { Fulfillment } from "../lib/recipes/base";

export type RegionOption = { value: string; display: string };

export function fulfillmentFromAllowShipping(allowShipping: boolean): Fulfillment {
  return allowShipping ? "any" : "pickup";
}

export function allowShippingFromFulfillment(fulfillment: Fulfillment | undefined): boolean {
  return (fulfillment ?? "any") !== "pickup";
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
