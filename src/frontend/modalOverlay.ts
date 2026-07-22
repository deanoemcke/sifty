// ── Modal overlay primitives ─────────────────────────────────────────────────
// Scroll-lock is shared by the listing detail modal and the Show/Sort
// dropdowns' mobile full-screen sheet. The history push/pop marker below is
// used only by the dropdowns' mobile sheet now — the listing modal's
// back-button handling moved to real URL state (see urlState.ts/app.ts),
// since dropdowns are intentionally outside the URL schema.

const SCROLL_LOCK_CLASS = 'scroll-locked';

export function lockBodyScroll(): void {
  document.body.classList.add(SCROLL_LOCK_CLASS);
}

export function unlockBodyScroll(): void {
  document.body.classList.remove(SCROLL_LOCK_CLASS);
}

// Pushed when a modal opens, so the back button has an entry to consume
// instead of navigating off the page. Carries no per-modal identity — the
// popstate handler just closes whichever modal is actually open — so a
// single marker shape covers all of them.
const MODAL_HISTORY_MARKER = { siftyModalOpen: true } as const;

export function pushModalHistoryEntry(): void {
  history.pushState(MODAL_HISTORY_MARKER, '');
}

// Called from every non-popstate close path (Escape, outside click,
// footer/close button, one modal auto-closing another). Checks
// history.state itself rather than trusting the caller, so it's safe to call
// even when no entry was pushed (e.g. a close triggered without a prior
// open) — it simply no-ops instead of popping an unrelated entry.
//
// Set right before history.back() below, so the app-wide popstate listener
// (app.ts) can tell "this popstate is just the dropdown consuming its own
// marker" apart from a real back-navigation via consumeModalDismissalPopState.
// Without this, that listener's applyUrlState() call re-derives *all* state
// (tab/sort/show/modal) from wherever history.back() lands — which is the
// entry from *before* the modal opened, predating any state change made
// while it was open (e.g. a Show-filter toggle) — silently reverting it the
// moment the sheet closes. Dropdowns are deliberately outside the URL schema
// (see this file's header comment) precisely so their own bookkeeping must
// never feed back into real app state like that.
let dismissingViaHistoryBack = false;

export function popModalHistoryEntryIfPresent(): void {
  if ((history.state as { siftyModalOpen?: boolean } | null)?.siftyModalOpen) {
    dismissingViaHistoryBack = true;
    history.back();
  }
}

// Consumes the flag so it only ever suppresses the one popstate event it
// caused, never a subsequent, genuine back/forward navigation.
export function consumeModalDismissalPopState(): boolean {
  const wasDismissal = dismissingViaHistoryBack;
  dismissingViaHistoryBack = false;
  return wasDismissal;
}
