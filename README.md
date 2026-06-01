# trademe-scraper

A Node.js/TypeScript CLI tool that scrapes TradeMe for used MacBook Pro listings, with configurable filters and full listing detail extraction (description, buy now price, reserve status, pickup info).

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

## Usage

```bash
npm run scrape
```

Results are printed to the terminal.

## Filters

Edit the `FILTERS` block near the top of [src/scraper.ts](src/scraper.ts):

```typescript
const FILTERS: FilterCriteria = {
  minPrice: 1000,           // exclude listings below this price
  maxPrice: 2500,           // exclude listings above this price
  keywords: ['M2'],         // title must contain ALL of these (case-insensitive)
  excludeKeywords: ['faulty', 'parts'],  // title must contain NONE of these
  minYear: 2021,            // exclude if a year in the title is before this
};
```

The base TradeMe search URL is already scoped to:
- Used condition
- Apple laptops
- 16–31 GB RAM
- 13", 14", or 15" screen size

To change the search criteria, update `SEARCH_URL` in the same file.

## Output

For each listing that passes the filters, the scraper prints:

- Title
- Asking / starting price
- Buy Now price (if set)
- Reserve status (no reserve / met / not met)
- Location
- Pickup details (and whether pickup-only)
- Listing URL
- Full description
