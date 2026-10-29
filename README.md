# ActaNews · Jack it!

Daily brand-fit stories to react to, per-brand Facebook / Instagram / LinkedIn / TikTok posts,
reply and troll analysis, star/minus memory, and face-aware image cropping with SEO filenames. HU/EN.

## Quick start (Docker)

```bash
git clone https://github.com/sandor-kardos/actanews
cd actanews
cp .env.example .env        # put your Anthropic API key in LLM_PRIMARY_KEY
docker compose up -d --build
```

Open http://localhost:8787. Logs: `docker logs -f actanews`

Without Docker (Node 20+): `node server.js` with the same variables set.

## Models

- **Primary** (`LLM_PRIMARY_*`): Anthropic API by default. Any OpenAI-compatible API also works with `LLM_PRIMARY_KIND=openai`.
- **Fallback** (`LLM_FALLBACK_*`, optional): used only if the primary call fails, e.g. OmniRoute or a local Ollama.
- **Second model** (`LLM_PAID_*`, optional): never automatic; a dropdown appears in the header to switch to it.

Keys stay on the server; the browser never sees them.

## Daily stories

The app doesn't browse the web itself, so the 3 daily stories come from RSS:
Google News searches per brand plus BBC feeds, listed in `data/feeds.json`
(created on first start, edit freely). Every day at `NEWS_TIME` the model
picks 3 from fresh items, skipping anything you minused or already saw.
"Refresh stories" next to the date runs it on demand.

Feed entry formats:

```json
{"brand": "bereljufot", "lang": "hu", "google": {"q": "utánfutó"}}
{"brand": "asc", "lang": "en", "url": "https://feeds.bbci.co.uk/news/scotland/edinburgh_east_and_fife/rss.xml", "source": "BBC News"}
```

## Data

Everything (brand styles, stories, stars, minuses, saved posts) is in `data/db.json`.
Back up that file; delete it to reset to the bundled seed (today's brands and stories).
The local and claude.ai versions don't sync with each other.

## Safety

Bound to `127.0.0.1` only and has no login. Don't publish the port. To reach it
from elsewhere, put it behind Cloudflare Zero Trust like your other services.
