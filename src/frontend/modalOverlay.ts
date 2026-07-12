// ── Modal overlay primitives ─────────────────────────────────────────────────
// Shared by the listing detail modal and the Show/Sort dropdowns' mobile
// full-screen sheet — both are true modals (background inert, back button
// closes them instead of navigating away) even though they're built from
// otherwise-unrelated DOM. Kept here so the scroll-lock class and the
// history push/pop marker each have a single implementation.

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
export function popModalHistoryEntryIfPresent(): void {
  if ((history.state as { siftyModalOpen?: boolean } | null)?.siftyModalOpen) history.back();
}
