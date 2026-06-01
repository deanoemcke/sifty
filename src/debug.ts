import { chromium } from 'playwright';
import { writeFileSync } from 'fs';

// A listing that returned (unavailable)
const URL = 'https://www.trademe.co.nz/a/marketplace/computers/laptops/laptops/apple/listing/5957802556';

async function debug(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-NZ',
  });
  const page = await context.newPage();

  let gqlCount = 0;
  page.on('response', async (resp) => {
    if (!resp.url().includes('api.trademe.co.nz/graphql')) return;
    if (resp.status() !== 200) return;
    gqlCount++;
    const json = await resp.json().catch(() => null);
    const keys = json?.data ? Object.keys(json.data) : [];
    const hasListing = !!json?.data?.listing;
    const hasAttrs = !!json?.data?.listing?.attributes;
    console.log(`GraphQL #${gqlCount}: data keys=${keys}, hasListing=${hasListing}, hasAttrs=${hasAttrs}`);
    if (hasAttrs) {
      writeFileSync('/tmp/trademe-unavail.json', JSON.stringify(json, null, 2));
      console.log('  -> saved');
    }
  });

  await page.goto(URL, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(8000);

  // Also try DOM extraction
  const descEl = await page.locator('tm-marketplace-listing-description, [data-testid="description"], .tm-listing-description').first().textContent({ timeout: 3000 }).catch(() => null);
  console.log('\nDOM description selector result:', descEl?.slice(0, 200));

  // Try page text
  const bodyText = await page.evaluate(() => document.body.innerText);
  const descIdx = bodyText.indexOf('Description\n');
  const shippingIdx = bodyText.indexOf('Shipping & pick-up');
  const afterDesc = descIdx >= 0 ? bodyText.slice(descIdx + 'Description\n'.length, shippingIdx > descIdx ? shippingIdx : descIdx + 3000).trim() : 'not found';
  console.log('\nPage text description extract:', afterDesc.slice(0, 500));

  await browser.close();
}

debug().catch(console.error);
