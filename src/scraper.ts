import { quickSearch, deepSearch, FilterCriteria, Listing, ListingDetail } from './lib/scraper';

const FILTERS: FilterCriteria = {
  excludeKeywords: ['part', 'repair', 'faulty', 'fault', 'i5', 'i7', 'A2338', 'A2289', 'A1708'],
  minYear: 2020,
};

const SEARCH_URL =
  'https://www.trademe.co.nz/a/marketplace/computers/laptops/laptops/apple/search?' +
  'search_string=macbook%20pro' +
  '&condition=used' +
  '&RefinePanel5c34c1efa0ac468f91e15161d549c479=16%20to%2031%20gb' +
  '&RefinePanel7a2bb94c0cb44806ac995a4fc854bcbc=13%22' +
  '&RefinePanel7a2bb94c0cb44806ac995a4fc854bcbc=14%22' +
  '&RefinePanel7a2bb94c0cb44806ac995a4fc854bcbc=15%22';

function formatReserve(status: string): string {
  if (status === 'NONE') return 'No reserve';
  if (status === 'MET') return 'Reserve met';
  if (status === 'NOT_MET') return 'Reserve not met';
  return 'Unknown';
}

async function scrape(): Promise<void> {
  const listings: Listing[] = [];

  console.log('Searching TradeMe for used MacBook Pro listings (16-31 GB RAM, 13"/14"/15")...\n');

  await quickSearch(SEARCH_URL, FILTERS, (event) => {
    if (event.type === 'progress') process.stdout.write(`  ${event.message}\n`);
    if (event.type === 'listing') listings.push(event.data);
    if (event.type === 'complete') console.log(`\nFound ${event.filtered} of ${event.found} listings after filtering\n`);
    if (event.type === 'error') console.error('Error:', event.message);
  });

  if (listings.length === 0) { console.log('No listings found.'); return; }

  console.log(`Fetching details for ${listings.length} listings...\n`);

  const results: Array<{ listing: Listing; detail: ListingDetail }> = [];

  await deepSearch(listings, (event) => {
    if (event.type === 'progress') {
      process.stdout.write(`  [${event.index}/${event.total}] ${event.title.slice(0, 60)}...\n`);
    }
    if (event.type === 'detail') {
      const listing = listings.find((l) => l.url === event.url)!;
      results.push({ listing, detail: event.detail });
    }
    if (event.type === 'error') console.error('Error:', event.message);
  });

  console.log();

  for (const { listing, detail } of results) {
    console.log('─'.repeat(80));
    console.log(`Title      : ${listing.title}`);
    console.log(`Price      : ${listing.price}`);
    console.log(`Buy Now    : ${detail.buyNowPrice != null ? `$${detail.buyNowPrice.toLocaleString()}` : 'N/A'}`);
    console.log(`Reserve    : ${formatReserve(detail.reserveStatus)}`);
    console.log(`Location   : ${listing.location}`);
    console.log(`Pickup     : ${detail.pickupLocation || listing.location}${detail.pickupOnly ? ' (pickup only)' : ''}`);
    console.log(`URL        : ${listing.url}`);
    console.log(`\nDescription:\n${detail.description || '(no description provided)'}`);
    console.log('─'.repeat(80));
  }
}

scrape().catch((err) => {
  console.error('Scraper failed:', err.message);
  process.exit(1);
});
