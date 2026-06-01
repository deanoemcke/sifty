import express from 'express';
import path from 'path';
import { quickSearch, deepSearch, Listing, FilterCriteria } from './lib/scraper';

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

let isBusy = false;

function startSSE(res: express.Response): void {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

function sse(res: express.Response, data: unknown): void {
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

app.post('/api/quick-search', async (req, res) => {
  if (isBusy) {
    res.status(429).json({ error: 'A search is already in progress — please wait.' });
    return;
  }
  const { url, filters = {} } = req.body as { url: string; filters?: FilterCriteria };
  if (!url) { res.status(400).json({ error: 'url is required' }); return; }

  isBusy = true;
  startSSE(res);
  try {
    await quickSearch(url, filters, (event) => sse(res, event));
  } catch (err) {
    sse(res, { type: 'error', message: (err as Error).message });
  } finally {
    isBusy = false;
    res.end();
  }
});

app.post('/api/deep-search', async (req, res) => {
  if (isBusy) {
    res.status(429).json({ error: 'A search is already in progress — please wait.' });
    return;
  }
  const { listings } = req.body as { listings: Listing[] };
  if (!Array.isArray(listings) || listings.length === 0) {
    res.status(400).json({ error: 'listings array is required' });
    return;
  }

  isBusy = true;
  startSSE(res);
  try {
    await deepSearch(listings, (event) => sse(res, event));
  } catch (err) {
    sse(res, { type: 'error', message: (err as Error).message });
  } finally {
    isBusy = false;
    res.end();
  }
});

const PORT = process.env.PORT ?? 3000;
app.listen(Number(PORT), () => {
  console.log(`TradeMe scraper running at http://localhost:${PORT}`);
});
