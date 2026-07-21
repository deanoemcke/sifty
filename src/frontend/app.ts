import type { RecipeId } from '../lib/recipes/metadata';
import {
  AI_FILTER_DEBOUNCE_MS,
  requestAiFilterRun,
  requestAiFilterRunIfPromptLongEnough,
} from './aiFilter';
import {
  closeAiFilterDropdownPanel,
  populateAiFilterDropdown,
  toggleAiFilterDropdownPanel,
} from './aiFilterDropdown';
import { debounce } from './debounce';
import {
  DEFAULT_REGION_DISPLAY,
  DISCOVERY_BUTTON_LABEL,
  handleDiscoveryKeydown,
  populateRegionSelect,
  type RegionOption,
  updateDiscoveryBtn,
} from './discoveryForm';
import { getElement, requireChild } from './domUtils';
import { loadDraftSession, scheduleDraftSessionSave } from './draftSession';
import {
  handleDropdownPopState,
  handleDropdownTabKey,
  handleEscapeKey,
  handleOutsideClick,
} from './dropdownPanel';
import { SEARCH_ICON } from './icons';
import { handleListingCardKeydown, resolveListingCardOpenArea } from './listingCardActivation';
import { closeListingModal, openListingCardModal, runDeepSearchAsync } from './listingDetail';
import { applyBrandTitle } from './pageTitle';
import { searchUrlCardAsync } from './quickSearch';
import { applyClientFilters, renderAiFilterButton, renderDerived } from './resultsView';
import {
  closeSaveSearchModal,
  fetchSavedSearchesAsync,
  handleDiscoverySubmitAsync,
  handleSavedSearchAlertToggleAsync,
  handleSavedSearchListClickAsync,
  handleSaveSearchConfirmAsync,
  markDirty,
  openSaveSearchModal,
  restoreDraftSessionAsync,
} from './searchSession';
import {
  closeShowDropdownPanel,
  populateShowControls,
  renderShowControls,
  toggleShowDropdownPanel,
} from './showDropdown';
import { activateSidebarTab, type SidebarTabName } from './sidebarTabs';
import {
  closeSortDropdownPanel,
  populateSortControls,
  renderSortControls,
  toggleSortDropdownPanel,
} from './sortDropdown';
import { DEFAULT_SORT_OPTION, type SortOption } from './sortListings';
import {
  activeSidebarTab,
  currentSearchId,
  type ListingVisibilityCategory,
  openModalListingUrl,
  setActiveSidebarTab,
  setListingCategoryVisible,
  setSortBy,
} from './state';
import { cancelGroupSearches, createUrlCard } from './urlCardRow';
import { toggleUrlGroup } from './urlGroupsView';
import {
  applyUrlState,
  currentLocationSearchParams,
  isAppPushedModalEntryFor,
  parseUrlState,
  syncUrlToState,
} from './urlState';

// ── Event wiring ──────────────────────────────────────────────────────────────

function handleShowCategoryToggle(category: ListingVisibilityCategory, isVisible: boolean): void {
  setListingCategoryVisible(category, isVisible);
  applyClientFilters();
  renderShowControls();
  syncUrlToState({ push: false });
}

function handleSortOptionChange(sortOption: SortOption): void {
  setSortBy(sortOption);
  renderSortControls(sortOption);
  renderDerived();
  syncUrlToState({ push: false });
}

function handleSidebarTabClick(tabName: SidebarTabName): void {
  if (tabName === activeSidebarTab) return;
  setActiveSidebarTab(tabName);
  activateSidebarTab(document, tabName);
  syncUrlToState({ push: true });
}

// Every openListingCardModal/closeListingModal call site lives here, so the
// decision of whether a close consumes a pushed history entry (history.back())
// or just replaces can live here too, rather than inside listingDetail.ts.
function openListingCardModalAndSyncUrl(card: HTMLElement): void {
  openListingCardModal(card);
  syncUrlToState({ push: true });
}

function closeListingModalAndSyncUrl(): void {
  const closingUrl = openModalListingUrl;
  closeListingModal();
  if (closingUrl && isAppPushedModalEntryFor(closingUrl)) history.back();
  else syncUrlToState({ push: false });
}

async function bootFromPersistedStateAsync(): Promise<void> {
  const parsed = parseUrlState(currentLocationSearchParams());
  // A ?search=<id> link is authoritative — only fall back to a locally
  // autosaved draft (see draftSession.ts) when there's no favourite to load.
  if (parsed.savedSearchId === null) {
    const draft = loadDraftSession();
    if (draft) await restoreDraftSessionAsync(draft);
  }
  await applyUrlState(parsed);
  // Canonicalize the address bar once, at boot only — normalizes away any
  // malformed/unresolvable params applyUrlState just rejected to a default.
  syncUrlToState({ push: false });
}

function initApp(): void {
  applyBrandTitle(__WORKTREE_LABEL__);
  getElement('discoveryBtn').textContent = DISCOVERY_BUTTON_LABEL;
  populateAiFilterDropdown();
  populateShowControls(handleShowCategoryToggle);
  populateSortControls(DEFAULT_SORT_OPTION, handleSortOptionChange);
  createUrlCard(searchUrlCardAsync);
  getElement<HTMLTextAreaElement>('discoveryPrompt').focus();

  getElement('addUrlBtn').addEventListener('click', () => {
    const newCard = createUrlCard(searchUrlCardAsync);
    newCard.dom.input.focus();
    newCard.dom.containerElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });

  const deepBtn = getElement<HTMLButtonElement>('deepBtn');
  requireChild<HTMLSpanElement>(deepBtn, '.dropdown-trigger-icon').innerHTML = SEARCH_ICON;
  deepBtn.addEventListener('click', () => runDeepSearchAsync());

  getElement('showDropdownBtn').addEventListener('click', () => toggleShowDropdownPanel());
  getElement('showDropdownFooterBtn').addEventListener('click', () => closeShowDropdownPanel());

  getElement('sortDropdownBtn').addEventListener('click', () => toggleSortDropdownPanel());
  getElement('sortDropdownFooterBtn').addEventListener('click', () => closeSortDropdownPanel());

  // Single shared dismiss wiring for both dropdown controls: opening one
  // closes the other, and outside-click/Escape close whichever is open.
  // handleDropdownTabKey additionally traps Tab/Shift+Tab within the open
  // panel while it's the mobile full-screen sheet (no-op on the desktop
  // popover, and a no-op whenever no dropdown is open).
  document.addEventListener('click', (mouseEvent: MouseEvent) =>
    handleOutsideClick(mouseEvent.target as Node)
  );
  document.addEventListener('keydown', (keyboardEvent: KeyboardEvent) => {
    handleEscapeKey(keyboardEvent.key);
    handleDropdownTabKey(keyboardEvent);
  });

  // The browser back/forward buttons move through real app state now (tab,
  // sort, filters, open listing modal, loaded favourite) — see urlState.ts.
  // The Show/Sort dropdowns' mobile full-screen sheet stay outside that
  // schema and keep using the older marker-based history close (see
  // modalOverlay.ts), so handleDropdownPopState still runs alongside it.
  window.addEventListener('popstate', () => {
    handleDropdownPopState();
    void applyUrlState(parseUrlState(currentLocationSearchParams()));
  });

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

  getElement<HTMLInputElement>('discoveryAllowShipping').addEventListener('change', () => {
    updateDiscoveryBtn();
    scheduleDraftSessionSave();
  });
  getElement<HTMLSelectElement>('discoveryRegion').addEventListener('change', () => {
    updateDiscoveryBtn();
    scheduleDraftSessionSave();
  });
  getElement<HTMLInputElement>('discoveryIncludeSoldItems').addEventListener(
    'change',
    scheduleDraftSessionSave
  );
  getElement<HTMLInputElement>('discoveryIncludeNewItems').addEventListener(
    'change',
    scheduleDraftSessionSave
  );

  getElement<HTMLTextAreaElement>('discoveryPrompt').addEventListener('input', () => {
    updateDiscoveryBtn();
    scheduleDraftSessionSave();
  });
  getElement<HTMLInputElement>('discoveryMaxPrice').addEventListener('input', () => {
    updateDiscoveryBtn();
    scheduleDraftSessionSave();
  });
  getElement<HTMLButtonElement>('discoveryBtn').addEventListener('click', () => {
    // A saved search's history entry (pushed by the savedSearchesList handler
    // below) must survive a subsequent discover-and-submit, or Back skips
    // past it. Only a *successful* submit clears currentSearchId (see
    // loadDiscoveryResults in searchSession.ts); an empty prompt, network
    // error, or superseded request leaves it unchanged and correctly falls
    // back to a replace.
    const searchIdBeforeSubmit = currentSearchId;
    void handleDiscoverySubmitAsync().then(() => {
      syncUrlToState({
        push: searchIdBeforeSubmit !== null && currentSearchId !== searchIdBeforeSubmit,
      });
    });
  });

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
  getElement<HTMLTextAreaElement>('aiFilter').addEventListener('input', () =>
    renderAiFilterButton()
  );
  getElement<HTMLButtonElement>('aiFilterDropdownBtn').addEventListener('click', () =>
    toggleAiFilterDropdownPanel()
  );
  getElement<HTMLButtonElement>('aiFilterBtn').addEventListener('click', () => {
    requestAiFilterRun();
    closeAiFilterDropdownPanel();
  });
  const submitAiFilterForm = (): void => getElement<HTMLButtonElement>('aiFilterBtn').click();
  getElement<HTMLTextAreaElement>('aiFilter').addEventListener(
    'keydown',
    (keyboardEvent: KeyboardEvent) => handleDiscoveryKeydown(keyboardEvent, submitAiFilterForm)
  );

  // Mark dirty on any URL input change, new URL card, or removed URL card
  getElement('urlCardsContainer').addEventListener('input', markDirty);
  getElement('addUrlBtn').addEventListener('click', markDirty);
  getElement('urlCardsContainer').addEventListener('click', (mouseEvent: MouseEvent) => {
    if ((mouseEvent.target as HTMLElement).closest('.url-remove-btn')) markDirty();
  });

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
    openListingCardModalAndSyncUrl(card);
  });

  getElement('listingsContainer').addEventListener('keydown', (keyboardEvent: KeyboardEvent) =>
    handleListingCardKeydown(keyboardEvent, openListingCardModalAndSyncUrl)
  );

  // ── Sidebar tabs / saved searches UI ──────────────────────────────────────────

  getElement('searchTabBtn').addEventListener('click', () => handleSidebarTabClick('search'));
  getElement('favouritesTabBtn').addEventListener('click', () => {
    handleSidebarTabClick('favourites');
    fetchSavedSearchesAsync();
  });
  // Populate the tab's count badge without waiting for the first tab switch.
  fetchSavedSearchesAsync();

  getElement('saveCurrentBtn').addEventListener('click', openSaveSearchModal);

  getElement('saveSearchCancelBtn').addEventListener('click', closeSaveSearchModal);

  getElement('saveSearchModal').addEventListener('click', (mouseEvent: MouseEvent) => {
    if (mouseEvent.target === getElement('saveSearchModal')) closeSaveSearchModal();
  });

  getElement('saveSearchConfirmBtn').addEventListener('click', () => {
    void handleSaveSearchConfirmAsync().then((saved) => {
      if (saved) syncUrlToState({ push: true });
    });
  });

  getElement<HTMLInputElement>('saveSearchName').addEventListener(
    'keydown',
    (keyboardEvent: KeyboardEvent) => {
      if (keyboardEvent.key === 'Enter')
        getElement<HTMLButtonElement>('saveSearchConfirmBtn').click();
      if (keyboardEvent.key === 'Escape') closeSaveSearchModal();
    }
  );

  getElement('listingModalCloseBtn').addEventListener('click', () => closeListingModalAndSyncUrl());

  getElement('listingModal').addEventListener('click', (mouseEvent: MouseEvent) => {
    if (mouseEvent.target === getElement('listingModal')) closeListingModalAndSyncUrl();
  });

  document.addEventListener('keydown', (keyboardEvent: KeyboardEvent) => {
    if (
      keyboardEvent.key === 'Escape' &&
      !getElement('listingModal').classList.contains('hidden')
    ) {
      closeListingModalAndSyncUrl();
    }
  });

  getElement('savedSearchesList').addEventListener('click', (mouseEvent: MouseEvent) => {
    void handleSavedSearchListClickAsync(mouseEvent).then((result) => {
      if (result === 'loaded') syncUrlToState({ push: true });
    });
  });

  getElement('savedSearchesList').addEventListener('change', (changeEvent: Event) => {
    void handleSavedSearchAlertToggleAsync(changeEvent);
  });

  void bootFromPersistedStateAsync();
}

initApp();
