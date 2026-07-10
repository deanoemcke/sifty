// Discovery form helpers — pure DOM/value mapping, no side effects at module scope.
// The "Allow shipping" checkbox is the UI for the Fulfillment search intent:
// ticked means pickup or shipping ("any"), unticked means pickup only.

import type { Fulfillment } from '../lib/recipes/base';
import { getElement } from './domUtils';
import { parseMaxPrice } from './parseUtils';
import type { DiscoverInputs } from './state';

export type RegionOption = { value: string; display: string };

// Region search intent defaults to the user's home region; matched against the
// display names served by /api/regions so region ids stay a server-side detail.
export const DEFAULT_REGION_DISPLAY = 'Wellington';

// Labels that JS rewrites at runtime are owned here exclusively — the HTML
// carries no copy, so the wording can never drift between sources.
export const DISCOVERY_BUTTON_LABEL = 'Go sifting';
export const DISCOVERY_BUTTON_BUSY_LABEL = 'Working…';

export interface DiscoveryFormElements {
  promptInput: HTMLTextAreaElement;
  maxPriceInput: HTMLInputElement;
  allowShippingCheckbox: HTMLInputElement;
  includeSoldItemsCheckbox: HTMLInputElement;
  regionSelect: HTMLSelectElement;
  discoveryButton: HTMLButtonElement;
}

export function fulfillmentFromAllowShipping(allowShipping: boolean): Fulfillment {
  return allowShipping ? 'any' : 'pickup';
}

export function readDiscoverInputs(): DiscoverInputs {
  return {
    prompt: getElement<HTMLTextAreaElement>('discoveryPrompt').value.trim(),
    maxPrice: parseMaxPrice(getElement<HTMLInputElement>('discoveryMaxPrice').value),
    fulfillment: fulfillmentFromAllowShipping(
      getElement<HTMLInputElement>('discoveryAllowShipping').checked
    ),
    includeSoldItems: getElement<HTMLInputElement>('discoveryIncludeSoldItems').checked,
    region: getElement<HTMLSelectElement>('discoveryRegion').value || undefined,
  };
}

export function discoveryFormElements(): DiscoveryFormElements {
  return {
    promptInput: getElement<HTMLTextAreaElement>('discoveryPrompt'),
    maxPriceInput: getElement<HTMLInputElement>('discoveryMaxPrice'),
    allowShippingCheckbox: getElement<HTMLInputElement>('discoveryAllowShipping'),
    includeSoldItemsCheckbox: getElement<HTMLInputElement>('discoveryIncludeSoldItems'),
    regionSelect: getElement<HTMLSelectElement>('discoveryRegion'),
    discoveryButton: getElement<HTMLButtonElement>('discoveryBtn'),
  };
}

export function updateDiscoveryBtn(): void {
  const hasPrompt = !!getElement<HTMLTextAreaElement>('discoveryPrompt').value.trim();
  const hasValidPrice =
    parseMaxPrice(getElement<HTMLInputElement>('discoveryMaxPrice').value) !== undefined;
  const isPickupOnly = !getElement<HTMLInputElement>('discoveryAllowShipping').checked;
  const hasRegion = !isPickupOnly || !!getElement<HTMLSelectElement>('discoveryRegion').value;
  getElement<HTMLButtonElement>('discoveryBtn').disabled =
    !hasPrompt || !hasValidPrice || !hasRegion;
}

// Shift+Enter still inserts a newline in the multi-line prompt textarea;
// plain Enter in either input runs the search instead.
export function handleDiscoveryKeydown(keyboardEvent: KeyboardEvent, submit: () => void): void {
  if (keyboardEvent.key !== 'Enter' || keyboardEvent.shiftKey) return;
  keyboardEvent.preventDefault();
  submit();
}

export function allowShippingFromFulfillment(fulfillment: Fulfillment | undefined): boolean {
  return (fulfillment ?? 'any') !== 'pickup';
}

// Loading a saved search means its sift has already run, so the button starts
// disabled regardless of input validity; editing any discovery input re-enables it.
export function applyLoadedDiscoverInputs(
  elements: DiscoveryFormElements,
  inputs: DiscoverInputs | undefined
): void {
  elements.discoveryButton.disabled = true;
  if (!inputs) return;
  elements.promptInput.value = inputs.prompt ?? '';
  elements.maxPriceInput.value = inputs.maxPrice != null ? String(inputs.maxPrice) : '';
  elements.allowShippingCheckbox.checked = allowShippingFromFulfillment(inputs.fulfillment);
  elements.includeSoldItemsCheckbox.checked = inputs.includeSoldItems ?? false;
  // No region in the saved inputs keeps the current selection (Wellington default).
  if (inputs.region) elements.regionSelect.value = inputs.region;
}

export function populateRegionSelect(
  select: HTMLSelectElement,
  regions: RegionOption[],
  defaultDisplay: string
): void {
  for (const region of regions) {
    const option = select.ownerDocument.createElement('option');
    option.value = region.value;
    option.textContent = region.display;
    option.selected = region.display === defaultDisplay;
    select.appendChild(option);
  }
}
