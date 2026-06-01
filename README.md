# trademe-scraper

A Node.js/TypeScript tool that scrapes TradeMe for used MacBook Pro listings. Comes with a web app UI and a CLI. Supports configurable filters and fetches full listing details (description, buy now price, reserve status, pickup info).

## How it works

The scraper uses [Playwright](https://playwright.dev/) to drive a headless Chromium browser. It intercepts TradeMe's internal JSON search API to collect listings efficiently, then visits each filtered listing page to extract the full description and structured metadata from the rendered DOM and GraphQL responses.

## Requirements

- Node.js 18+
- npm

## Setup

```bash
npm install
npx playwright install chromium
```

## Web app

```bash
npm start
```

Opens at **http://localhost:3000**.

**Flow:**

1. Paste a TradeMe search URL and press Enter (or click Search)
2. All matching listings are fetched and displayed. The criteria implicit in the URL (category, search term, condition, RAM, screen size) are shown read-only beneath the URL field
3. The filter inputs appear — min/max price, keywords, and exclude keywords. These filter the displayed listings **instantly in the browser** with no re-scrape
4. Click **Deep Search** to fetch the full description, buy now price, reserve status, and pickup info for every currently visible listing. Results populate in real time as each listing is scraped
5. If you change a filter after a deep search and it reveals listings that haven't been scraped yet, the Deep Search button reactivates and will only fetch the newly visible ones

## CLI

```bash
npm run scrape
```

Runs a hardcoded search and prints full listing details to the terminal. The search URL and filters are configured at the top of [src/scraper.ts](src/scraper.ts).

## CLI filters

Edit the `FILTERS` block near the top of [src/scraper.ts](src/scraper.ts):

```typescript
const FILTERS: FilterCriteria = {
  minPrice: 1000,
  maxPrice: 2500,
  keywords: ['M2'],
  excludeKeywords: ['faulty', 'parts'],
  minYear: 2021,
};
```

To change the base search, update `SEARCH_URL` in the same file.

## Output fields

For each listing (web app deep search or CLI):

- Title
- Asking / starting price
- Buy Now price (if set)
- Reserve status (no reserve / met / not met)
- Location
- Pickup details (and whether pickup-only)
- Listing URL
- Full description

## Project structure

```
src/
  lib/scraper.ts   # Core scraper logic — shared by web app and CLI
  server.ts        # Express web server
  scraper.ts       # CLI entry point
public/
  index.html       # Web app frontend
```
