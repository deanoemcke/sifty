// Server-side only — normalizes scheduler failure text down to a stable
// comparison key, shared by scheduler.ts (cross-run "same failure as last
// time" comparison) and signalMessage.ts (within-one-alert line collapsing).
// Extracted to its own module rather than living in either file: scheduler.ts
// imports value bindings (the formatters) from signalMessage.ts, so importing
// this function directly from scheduler.ts into signalMessage.ts would create
// a runtime circular dependency between the two.

// Collapses a failure reason down to a stable comparison key by stripping
// content that varies run-to-run (or URL-to-URL) for the same underlying
// failure — e.g. Facebook's login-wall message embeds however many listings
// loaded before the wall appeared, and a scrape-timeout message embeds the
// specific URL. Without this, two errors describing the identical root cause
// rarely produce identical raw strings, so neither scheduler.ts's "is this
// the same failure as last run" check nor signalMessage.ts's within-alert
// dedup would ever recognize them as the same thing. This only affects
// comparison — the raw, un-normalized reason is still what's shown in full
// in the alert body and recorded in summary.errors/last_run_detail.
export function normalizeScrapeErrorReason(reason: string): string {
  return reason.replace(/https?:\/\/\S+/g, '<url>').replace(/\d+/g, '#');
}
