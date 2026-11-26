# Session summary

**Purpose.** The user reported that Facebook no longer supports setting the Marketplace location through the URL. I investigated live with Playwright and the user's synced cookies, then fixed it test-first.

**Findings (live, 26 Nov 2026).**
- Only 3 of the 18 city slugs in `assets/regions.json` (`auckland`, `christchurch`, `gisborne`) still resolved. The other 15 returned a 302 to `/marketplace/category/search/` and Facebook showed the account's default location (Wellington). Nothing errors, so pickup searches for those regions silently returned Wellington listings.
- `latitude`/`longitude` query params are ignored for location (`radius` is honoured). `/marketplace/hamilton/` resolves to Hamilton, Ontario.
- Numeric location page IDs in the path (`/marketplace/<id>/search`) work. I took the IDs from the `city_street_search` GraphQL response behind the "Change location" dialog (`node.page.id`), without clicking Apply (which would change the user's saved account location). Facebook spells Whanganui "Wanganui". All 18 IDs were verified by loading each URL: the page showed the right city with no redirect. Wellington's ID matched the one Facebook itself redirects to.

**Change.** `assets/regions.json` now stores `facebookLocationId` (numeric string) instead of `facebookLocation` (slug). `RegionEntry` in `src/server/services/regions.ts` and `buildFacebookUrl` in `src/server/recipes/facebook.ts` use it. Tests in `facebook.test.ts` were updated to the ID form, and a new `src/server/services/regions.test.ts` asserts every region has a numeric, distinct ID. Full suite, tsc and Biome were clean. One commit, 939d32c, PR #74.

**Known limits.**
- The IDs are not guaranteed stable. Nothing checks at runtime that Facebook honoured the location; a mismatch still falls back silently.
- The regions.test.ts checks the ID format and uniqueness only, not that Facebook accepts them.
- Each region maps to one principal city's ID (the same way the slugs did), with Facebook's default 65 km radius.

**Deliberately not done.** A runtime guard comparing the page's displayed location with the requested region (discussed, left as a separate change). No changes to the scraper's user agent or cookie handling.

**Separate topic, not part of this diff.** The user also asked about "new login from a device or location you don't usually use" notifications. Live checks showed two alerts (1d and 4d old) predating this work, and neither my probes nor loads with the scraper's user agent added any. Cause unresolved; nothing in this branch touches it.
