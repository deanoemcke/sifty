// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  allowShippingFromFulfillment,
  applyLoadedDiscoverInputs,
  type DiscoveryFormElements,
  discoveryFormElements,
  fulfillmentFromAllowShipping,
  handleDiscoveryKeydown,
  populateRegionSelect,
  readDiscoverInputs,
  updateDiscoveryBtn,
} from './discoveryForm';

const REGIONS = [
  { value: '1', display: 'Auckland' },
  { value: '12', display: 'Wellington' },
  { value: '14', display: 'Canterbury' },
];

describe('fulfillmentFromAllowShipping', () => {
  it('maps an allow-shipping tick to the any fulfillment', () => {
    expect(fulfillmentFromAllowShipping(true)).toBe('any');
  });

  it('maps an unticked box to pickup-only fulfillment', () => {
    expect(fulfillmentFromAllowShipping(false)).toBe('pickup');
  });
});

describe('allowShippingFromFulfillment', () => {
  it('unticks the box only for pickup-only searches', () => {
    expect(allowShippingFromFulfillment('pickup')).toBe(false);
    expect(allowShippingFromFulfillment('any')).toBe(true);
    expect(allowShippingFromFulfillment('shipping')).toBe(true);
  });

  it('defaults to allowing shipping when a saved search has no fulfillment', () => {
    expect(allowShippingFromFulfillment(undefined)).toBe(true);
  });
});

describe('populateRegionSelect', () => {
  it('adds an option per region', () => {
    const select = document.createElement('select');
    populateRegionSelect(select, REGIONS, 'Wellington');
    expect([...select.options].map((option) => option.textContent)).toEqual([
      'Auckland',
      'Wellington',
      'Canterbury',
    ]);
  });

  it('selects the default region by display name', () => {
    const select = document.createElement('select');
    populateRegionSelect(select, REGIONS, 'Wellington');
    expect(select.value).toBe('12');
  });

  it('keeps the browser default selection when the default display name is unknown', () => {
    const select = document.createElement('select');
    populateRegionSelect(select, REGIONS, 'Atlantis');
    expect(select.value).toBe('1');
  });
});

function buildDiscoveryForm(): DiscoveryFormElements {
  const regionSelect = document.createElement('select');
  populateRegionSelect(regionSelect, REGIONS, 'Wellington');
  const discoveryButton = document.createElement('button');
  const allowShippingCheckbox = document.createElement('input');
  allowShippingCheckbox.type = 'checkbox';
  return {
    promptInput: document.createElement('textarea'),
    maxPriceInput: document.createElement('input'),
    allowShippingCheckbox,
    regionSelect,
    discoveryButton,
  };
}

describe('applyLoadedDiscoverInputs', () => {
  it('populates the form fields from the saved inputs', () => {
    const elements = buildDiscoveryForm();
    applyLoadedDiscoverInputs(elements, {
      prompt: 'mid-century sideboard',
      maxPrice: 250,
      fulfillment: 'pickup',
      region: '1',
    });
    expect(elements.promptInput.value).toBe('mid-century sideboard');
    expect(elements.maxPriceInput.value).toBe('250');
    expect(elements.allowShippingCheckbox.checked).toBe(false);
    expect(elements.regionSelect.value).toBe('1');
  });

  it('disables the discovery button even when the loaded inputs are valid', () => {
    const elements = buildDiscoveryForm();
    applyLoadedDiscoverInputs(elements, {
      prompt: 'mid-century sideboard',
      maxPrice: 250,
      fulfillment: 'any',
    });
    expect(elements.discoveryButton.disabled).toBe(true);
  });

  it('disables the discovery button when the saved search has no discover inputs', () => {
    const elements = buildDiscoveryForm();
    elements.promptInput.value = 'leftover prompt';
    applyLoadedDiscoverInputs(elements, undefined);
    expect(elements.discoveryButton.disabled).toBe(true);
    expect(elements.promptInput.value).toBe('leftover prompt');
  });

  it('keeps the current region selection when the saved inputs have no region', () => {
    const elements = buildDiscoveryForm();
    applyLoadedDiscoverInputs(elements, {
      prompt: 'mid-century sideboard',
      fulfillment: 'any',
    });
    expect(elements.regionSelect.value).toBe('12');
  });

  it('clears the max price when the saved inputs have none', () => {
    const elements = buildDiscoveryForm();
    elements.maxPriceInput.value = '999';
    applyLoadedDiscoverInputs(elements, {
      prompt: 'mid-century sideboard',
      fulfillment: 'any',
    });
    expect(elements.maxPriceInput.value).toBe('');
  });
});

function mountDiscoveryFormFixture(): void {
  document.body.innerHTML = `
    <textarea id="discoveryPrompt"></textarea>
    <input id="discoveryMaxPrice" />
    <input id="discoveryAllowShipping" type="checkbox" checked />
    <select id="discoveryRegion"><option value="">Any</option><option value="12">Wellington</option></select>
    <button id="discoveryBtn"></button>
  `;
}

describe('readDiscoverInputs', () => {
  it('maps the form fields into DiscoverInputs', () => {
    mountDiscoveryFormFixture();
    (document.getElementById('discoveryPrompt') as HTMLTextAreaElement).value = '  lamp  ';
    (document.getElementById('discoveryMaxPrice') as HTMLInputElement).value = '50';
    (document.getElementById('discoveryRegion') as HTMLSelectElement).value = '12';
    expect(readDiscoverInputs()).toEqual({
      prompt: 'lamp',
      maxPrice: 50,
      fulfillment: 'any',
      region: '12',
    });
  });

  it('omits the region when none is selected and maps pickup-only', () => {
    mountDiscoveryFormFixture();
    (document.getElementById('discoveryAllowShipping') as HTMLInputElement).checked = false;
    const inputs = readDiscoverInputs();
    expect(inputs.region).toBeUndefined();
    expect(inputs.fulfillment).toBe('pickup');
  });
});

describe('discoveryFormElements', () => {
  it('gathers the five discovery form elements', () => {
    mountDiscoveryFormFixture();
    const elements = discoveryFormElements();
    expect(elements.promptInput.id).toBe('discoveryPrompt');
    expect(elements.discoveryButton.id).toBe('discoveryBtn');
  });
});

describe('handleDiscoveryKeydown', () => {
  function enterEvent(shiftKey = false): KeyboardEvent {
    return new KeyboardEvent('keydown', { key: 'Enter', shiftKey, cancelable: true });
  }

  it('submits on Enter and prevents the default newline', () => {
    const submit = vi.fn();
    const event = enterEvent();
    handleDiscoveryKeydown(event, submit);
    expect(submit).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
  });

  it('does not submit on Shift+Enter, allowing a newline in the prompt', () => {
    const submit = vi.fn();
    const event = enterEvent(true);
    handleDiscoveryKeydown(event, submit);
    expect(submit).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores non-Enter keys', () => {
    const submit = vi.fn();
    handleDiscoveryKeydown(new KeyboardEvent('keydown', { key: 'a' }), submit);
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('updateDiscoveryBtn', () => {
  it('disables the button without a prompt', () => {
    mountDiscoveryFormFixture();
    updateDiscoveryBtn();
    expect((document.getElementById('discoveryBtn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('enables the button with a prompt and valid price', () => {
    mountDiscoveryFormFixture();
    (document.getElementById('discoveryPrompt') as HTMLTextAreaElement).value = 'lamp';
    (document.getElementById('discoveryMaxPrice') as HTMLInputElement).value = '50';
    updateDiscoveryBtn();
    expect((document.getElementById('discoveryBtn') as HTMLButtonElement).disabled).toBe(false);
  });

  it('disables the button on an unparseable price', () => {
    mountDiscoveryFormFixture();
    (document.getElementById('discoveryPrompt') as HTMLTextAreaElement).value = 'lamp';
    (document.getElementById('discoveryMaxPrice') as HTMLInputElement).value = 'abc';
    updateDiscoveryBtn();
    expect((document.getElementById('discoveryBtn') as HTMLButtonElement).disabled).toBe(true);
  });

  it('requires a region when pickup-only', () => {
    mountDiscoveryFormFixture();
    (document.getElementById('discoveryPrompt') as HTMLTextAreaElement).value = 'lamp';
    (document.getElementById('discoveryMaxPrice') as HTMLInputElement).value = '50';
    (document.getElementById('discoveryAllowShipping') as HTMLInputElement).checked = false;
    (document.getElementById('discoveryRegion') as HTMLSelectElement).value = '';
    updateDiscoveryBtn();
    expect((document.getElementById('discoveryBtn') as HTMLButtonElement).disabled).toBe(true);

    (document.getElementById('discoveryRegion') as HTMLSelectElement).value = '12';
    updateDiscoveryBtn();
    expect((document.getElementById('discoveryBtn') as HTMLButtonElement).disabled).toBe(false);
  });
});
