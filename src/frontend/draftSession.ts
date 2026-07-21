// ── Draft session persistence ────────────────────────────────────────────────
// Autosaves the in-progress, unsaved (ad-hoc) discovery session to
// localStorage so it survives a mobile browser silently reloading the page
// after backgrounding it (Android Chrome evicts backgrounded tab processes
// under memory pressure, and pages with an open SSE stream — like this app's
// deep/quick searches — are never eligible for the back-forward cache, so
// that reload is a real full reload, not a restore from memory). This is
// orthogonal to urlState.ts: the URL encodes navigable app state, this module
// persists ad-hoc session *content* that isn't cheap enough to put in a URL.
// A loaded saved search is already durable via the server, so this never
// persists one — see the currentSearchId guard in saveDraftSession.

import { debounce } from './debounce';
import { readDiscoverInputs } from './discoveryForm';
import { getElement } from './domUtils';
import { currentSearchId, type DiscoverInputs } from './state';
import { readCardUrl, urlCards } from './urlCardStore';

export interface DraftSession {
  urls: string[];
  discoverInputs: DiscoverInputs;
  aiFilter: string;
}

const DRAFT_SESSION_STORAGE_KEY = 'sifty:draftSession';
const DRAFT_SESSION_SAVE_DEBOUNCE_MS = 500;

function isDiscoverInputsShape(value: unknown): value is DiscoverInputs {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as DiscoverInputs).prompt === 'string' &&
    typeof (value as DiscoverInputs).fulfillment === 'string'
  );
}

function isDraftSessionShape(value: unknown): value is DraftSession {
  return (
    typeof value === 'object' &&
    value !== null &&
    Array.isArray((value as DraftSession).urls) &&
    (value as DraftSession).urls.every((url) => typeof url === 'string') &&
    isDiscoverInputsShape((value as DraftSession).discoverInputs) &&
    typeof (value as DraftSession).aiFilter === 'string'
  );
}

// A saved search is already durable via the server (reachable through
// ?search=<id>), so there is never a need to also shadow it in localStorage.
export function saveDraftSession(): void {
  if (currentSearchId !== null) return;
  const draft: DraftSession = {
    urls: urlCards.map(readCardUrl).filter(Boolean),
    discoverInputs: readDiscoverInputs(),
    aiFilter: getElement<HTMLTextAreaElement>('aiFilter').value,
  };
  localStorage.setItem(DRAFT_SESSION_STORAGE_KEY, JSON.stringify(draft));
}

// localStorage content is external input (another tab, an older app version,
// manual tampering) — reject anything that doesn't match the expected shape
// rather than restoring a partial/broken session.
export function loadDraftSession(): DraftSession | null {
  const raw = localStorage.getItem(DRAFT_SESSION_STORAGE_KEY);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return isDraftSessionShape(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearDraftSession(): void {
  localStorage.removeItem(DRAFT_SESSION_STORAGE_KEY);
}

export const scheduleDraftSessionSave = debounce(saveDraftSession, DRAFT_SESSION_SAVE_DEBOUNCE_MS);
