import type { RecipeId } from '../lib/recipes/metadata';
import {
  AI_FILTER_DEBOUNCE_MS,
  requestAiFilterRun,
  requestAiFilterRunIfPromptLongEnough,
} from './aiFilter';
import { debounce } from './debounce';
import {
  DEFAULT_REGION_DISPLAY,
  DISCOVERY_BUTTON_LABEL,
  handleDiscoveryKeydown,
  populateRegionSelect,
  type RegionOption,
  updateDiscoveryBtn,
} from './discoveryForm';
import { getElement } from './domUtils';
import { handleEscapeKey, handleOutsideClick } from './dropdownPanel';
import { handleListingCardKeydown, resolveListingCardOpenArea } from './listingCardActivation';
import { closeListingModal, openListingCardModal, runDeepSearchAsync } from './listingDetail';
import { applyBrandTitle } from './pageTitle';
import { searchUrlCardAsync } from './quickSearch';
import { applyClientFilters, renderAiFilterButton, renderDerived } from './resultsView';
import {
  closeSaveSearchModal,
  fetchSavedSearchesAsync,
  handleDiscoverySubmitAsync,
  handleSavedSearchListClickAsync,
  handleSaveSearchConfirmAsync,
  markDirty,
  openSaveSearchModal,
} from './searchSession';
import {
  closeShowDropdownPanel,
  populateShowControls,
  renderShowControls,
  SHOW_CHECKBOX_ID_BY_CATEGORY,
  SHOW_OPTIONS,
  setListingCategoryVisible,
  toggleShowDropdownPanel,
  updateShowSoldOptionVisibility,
} from './showDropdown';
import { activateSidebarTab } from './sidebarTabs';
import {
  closeSortDropdownPanel,
  populateSortControls,
  renderSortControls,
  SORT_RADIO_ID_BY_OPTION,
  toggleSortDropdownPanel,
} from './sortDropdown';
import { DEFAULT_SORT_OPTION, SORT_OPTIONS } from './sortListings';
import { setSortBy } from './state';
import { cancelGroupSearches, createUrlCard } from './urlCardRow';
import { toggleUrlGroup } from './urlGroupsView';

// ── Event wiring ──────────────────────────────────────────────────────────────

function initApp(): void {
  applyBrandTitle(__WORKTREE_LABEL__);
  getElement('discoveryBtn').textContent = DISCOVERY_BUTTON_LABEL;
  populateShowControls();
  updateShowSoldOptionVisibility();
  populateSortControls(DEFAULT_SORT_OPTION);
  createUrlCard(searchUrlCardAsync);
  getElement<HTMLTextAreaElement>('discoveryPrompt').focus();

  getElement('addUrlBtn').addEventListener('click', () => {
    const newCard = createUrlCard(searchUrlCardAsync);
    newCard.dom.input.focus();
    newCard.dom.containerElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  getElement<HTMLButtonElement>('deepBtn').addEventListener('click', () => runDeepSearchAsync());

  getElement('showDropdownBtn').addEventListener('click', () => toggleShowDropdownPanel());
  getElement('showDropdownFooterBtn').addEventListener('click', () => closeShowDropdownPanel());
  for (const { value } of SHOW_OPTIONS) {
    getElement<HTMLInputElement>(SHOW_CHECKBOX_ID_BY_CATEGORY[value]).addEventListener(
      'change',
      (changeEvent) => {
        setListingCategoryVisible(value, (changeEvent.target as HTMLInputElement).checked);
        applyClientFilters();
        renderShowControls();
      }
    );
  }
  getElement<HTMLInputElement>('discoveryIncludeSoldItems').addEventListener(
    'change',
    updateShowSoldOptionVisibility
  );

  getElement('sortDropdownBtn').addEventListener('click', () => toggleSortDropdownPanel());
  getElement('sortDropdownFooterBtn').addEventListener('click', () => closeSortDropdownPanel());
  for (const { value } of SORT_OPTIONS) {
    getElement<HTMLInputElement>(SORT_RADIO_ID_BY_OPTION[value]).addEventListener('change', () => {
      setSortBy(value);
      renderSortControls(value);
      renderDerived();
    });
  }

  // Single shared dismiss wiring for both dropdown controls: opening one
  // closes the other, and outside-click/Escape close whichever is open.
  document.addEventListener('click', (mouseEvent: MouseEvent) =>
    handleOutsideClick(mouseEvent.target as Node)
  );
  document.addEventListener('keydown', (keyboardEvent: KeyboardEvent) =>
    handleEscapeKey(keyboardEvent.key)
  );

  // Populate region dropdown and wire the allow-shipping checkbox
  fetch('/api/regions')
    .then((regionResponse) => regionResponse.json())
    .then((regions: RegionOption[]) => {
      populateRegionSelect(
        getElement<HTMLSelectElement>('discoveryRegion'),
        regions,
        DEFAULT_REGION_DISPLAY
      );
      updateDiscoveryBtn();
    })
    .catch(() => {
      /* regions unavailable — dropdown stays empty */
    });

  getElement<HTMLInputElement>('discoveryAllowShipping').addEventListener(
    'change',
    updateDiscoveryBtn
  );
  getElement<HTMLSelectElement>('discoveryRegion').addEventListener('change', updateDiscoveryBtn);

  getElement<HTMLTextAreaElement>('discoveryPrompt').addEventListener('input', updateDiscoveryBtn);
  getElement<HTMLInputElement>('discoveryMaxPrice').addEventListener('input', updateDiscoveryBtn);
  getElement<HTMLButtonElement>('discoveryBtn').addEventListener('click', () =>
    handleDiscoverySubmitAsync()
  );

  const submitDiscoveryForm = (): void => getElement<HTMLButtonElement>('discoveryBtn').click();
  getElement<HTMLTextAreaElement>('discoveryPrompt').addEventListener(
    'keydown',
    (keyboardEvent: KeyboardEvent) => handleDiscoveryKeydown(keyboardEvent, submitDiscoveryForm)
  );
  getElement<HTMLInputElement>('discoveryMaxPrice').addEventListener(
    'keydown',
    (keyboardEvent: KeyboardEvent) => handleDiscoveryKeydown(keyboardEvent, submitDiscoveryForm)
  );

  const debouncedRequestAiFilterRun = debounce(
    requestAiFilterRunIfPromptLongEnough,
    AI_FILTER_DEBOUNCE_MS
  );
  getElement<HTMLTextAreaElement>('aiFilter').addEventListener('input', markDirty);
  getElement<HTMLTextAreaElement>('aiFilter').addEventListener(
    'input',
    debouncedRequestAiFilterRun
  );
  getElement<HTMLTextAreaElement>('aiFilter').addEventListener('input', renderAiFilterButton);
  getElement<HTMLButtonElement>('aiFilterBtn').addEventListener('click', () =>
    requestAiFilterRun()
  );
  const submitAiFilterForm = (): void => getElement<HTMLButtonElement>('aiFilterBtn').click();
  getElement<HTMLTextAreaElement>('aiFilter').addEventListener(
    'keydown',
    (keyboardEvent: KeyboardEvent) => handleDiscoveryKeydown(keyboardEvent, submitAiFilterForm)
  );

  // Mark dirty on any URL input change or new URL card
  getElement('urlCardsContainer').addEventListener('input', markDirty);
  getElement('addUrlBtn').addEventListener('click', markDirty);

  // Recipe group headers: chevron toggles the rows, cancel stops all of the
  // group's running searches.
  getElement('urlCardsContainer').addEventListener('click', (mouseEvent: MouseEvent) => {
    const groupEl = (mouseEvent.target as HTMLElement).closest<HTMLElement>('.url-group');
    if (!groupEl) return;
    const groupId = Number(groupEl.dataset.recipeId) as RecipeId;
    if ((mouseEvent.target as HTMLElement).closest('.url-group-toggle')) {
      toggleUrlGroup(groupId);
      return;
    }
    if ((mouseEvent.target as HTMLElement).closest('.url-group-cancel')) {
      cancelGroupSearches(groupId);
    }
  });

  getElement('listingsContainer').addEventListener('click', (mouseEvent: MouseEvent) => {
    const openArea = resolveListingCardOpenArea(mouseEvent.target as HTMLElement);
    if (!openArea) return;
    const card = openArea.closest<HTMLElement>('.listing-card');
    if (!card) return;
    openListingCardModal(card);
  });

  getElement('listingsContainer').addEventListener('keydown', (keyboardEvent: KeyboardEvent) =>
    handleListingCardKeydown(keyboardEvent, openListingCardModal)
  );

  // ── Sidebar tabs / saved searches UI ──────────────────────────────────────────

  getElement('searchTabBtn').addEventListener('click', () =>
    activateSidebarTab(document, 'search')
  );
  getElement('favouritesTabBtn').addEventListener('click', () => {
    activateSidebarTab(document, 'favourites');
    fetchSavedSearchesAsync();
  });
  // Populate the tab's count badge without waiting for the first tab switch.
  fetchSavedSearchesAsync();

  getElement('saveCurrentBtn').addEventListener('click', openSaveSearchModal);

  getElement('saveSearchCancelBtn').addEventListener('click', closeSaveSearchModal);

  getElement('saveSearchModal').addEventListener('click', (mouseEvent: MouseEvent) => {
    if (mouseEvent.target === getElement('saveSearchModal')) closeSaveSearchModal();
  });

  getElement('saveSearchConfirmBtn').addEventListener('click', () =>
    handleSaveSearchConfirmAsync()
  );

  getElement<HTMLInputElement>('saveSearchName').addEventListener(
    'keydown',
    (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key === 'Enter')
        getElement<HTMLButtonElement>('saveSearchConfirmBtn').click();
      if (keyboardEvent.key === 'Escape') closeSaveSearchModal();
    }
  );

  getElement('listingModalCloseBtn').addEventListener('click', closeListingModal);

  getElement('listingModal').addEventListener('click', (mouseEvent: MouseEvent) => {
    if (mouseEvent.target === getElement('listingModal')) closeListingModal();
  });

  document.addEventListener('keydown', (keyboardEvent: KeyboardEvent) => {
    if (
      keyboardEvent.key === 'Escape' &&
      !getElement('listingModal').classList.contains('hidden')
    ) {
      closeListingModal();
    }
  });

  getElement('savedSearchesList').addEventListener('click', (mouseEvent: MouseEvent) => {
    void handleSavedSearchListClickAsync(mouseEvent);
  });
}

initApp();
