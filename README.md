# Sifty

An AI-powered marketplace search tool. Describe what you're looking for in plain English, and Sifty discovers the right search URLs across TradeMe and Facebook Marketplace, fetches listings, and uses an LLM to filter out the irrelevant ones.

## How it works

1. **Discover** — you type a search prompt (e.g. "Apple MacBook Pro 13 M1"). The AI picks the right TradeMe categories and builds search URLs. Facebook Marketplace uses the prompt directly.
2. **Quick search** — listings are fetched from each URL using Playwright (headless Chromium). Results stream in via SSE.
3. **AI filter** — an LLM reviews each listing and removes ones that clearly don't match your criteria.
4. **Deep search** — click into any listing for the full description, buy now price, reserve status, pickup info, and Q&A.
5. **Save** — save searches by name for instant replay.

Results and listing details are cached in SQLite for one hour. Repeat searches within that window are served instantly.

## Requirements

- Node.js 20+
- npm
- A Groq API key (or OpenRouter / Gemini — see [AI providers](#ai-providers))

## Setup

```bash
npm install
npx playwright install chromium
cp .env.example .env   # then fill in your API key
```

`.env` minimum:

```
AI_PROVIDER=groq
GROQ_API_KEY=your-key-here
```

## Running

```bash
npm run dev
```

Opens at **http://localhost:5173**.

## AI providers

Set `AI_PROVIDER` to one of:

| Provider | Model | Key variable |
|----------|-------|-------------|
| `groq` (default) | llama-3.3-70b-versatile | `GROQ_API_KEY` |
| `openrouter` | meta-llama/llama-3.3-70b-instruct | `OPENROUTER_API_KEY` |
| `gemini` | gemini-3.1-flash-lite | `GEMINI_API_KEY` |

## Facebook Marketplace

To enable Facebook Marketplace results, add your browser cookies to `.env`:

```
FB_COOKIES='[{"domain":".facebook.com","name":"datr","value":"..."}]'
```

Export them from a logged-in browser session using a cookie export extension.

## Project structure

```
src/
  frontend/          # Client-side TypeScript (Vite SPA)
  server/
    ai.ts            # LLM provider config and JSON completion
    db.ts            # SQLite schema and prepared statements
    routes/          # API route handlers (discover, quickSearch, aiFilter, …)
    recipes/         # Marketplace scrapers (TradeMe, Facebook)
  lib/               # Shared types, validation, concurrency queue
scripts/
  prompt-tests/      # AI prompt testing utility (see below)
```

## Tests

```bash
npm test             # unit + integration tests (no API calls, no browser)
npm run test:watch   # watch mode
```

## AI prompt testing utility

A standalone CLI for testing the LLM prompts against real providers. Not part of the normal test suite — it makes real API calls and costs credits.

### Modes

| Command | What it does |
|---------|-------------|
| `npm run test:prompts` | Replay saved fixture responses through validators (no API calls) |
| `npm run test:prompts:live` | Call all configured providers and validate responses |
| `npm run test:prompts:capture` | Same as live, and save responses as fixtures for future replay |

### Options

```bash
# Single provider
npx tsx --env-file-if-exists=.env scripts/prompt-tests/runner.ts --live --provider groq

# Single suite
npx tsx --env-file-if-exists=.env scripts/prompt-tests/runner.ts --live --suite ai-filter

# Available suites: ai-filter, trademe-discover
```

### TradeMe Discover suite

The TradeMe discover tests need the category database, which is populated after the first `npm run dev` session. If running from a git worktree without its own cache, point the runner at the main project's database:

```bash
CACHE_DB_PATH=../sifty-webapp/.cache/cache.db npm run test:prompts:live
```

### Adding a new test case

Open the relevant suite file and add one object to the cases array:

```typescript
// scripts/prompt-tests/suites/aiFilterSuite.ts
defineFilterCase({
  id: "aiFilter-my-new-case",
  label: "My new case description",
  criteria: "what the user is searching for",
  listings: [
    { title: "...", price: "$100", location: "Auckland", description: "" },
  ],
  validate(output) {
    // call assertPasses / assertFails on listing indices
  },
}),
```

Then run `--live --capture` to generate a fixture for it.

### What the utility is for

- **Prompt regressions** — after changing a prompt, run `--capture` and review the fixture diff
- **Cross-provider comparison** — run `--live` with multiple providers configured; results are shown side by side
- **Quality spot-checks** — the validators encode the expected behaviour (e.g. a couch listing must fail a "MacBook Pro" filter). A failure means the prompt or the model isn't meeting that expectation

Fixture files live in `scripts/prompt-tests/fixtures/{provider}/{test-id}.json` and are committed to the repo so the team can replay them without spending credits.
