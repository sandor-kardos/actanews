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

- **Primary** (`LLM_PRIMARY_*`): the default for everything, Claude Haiku (cheap, fast). Any OpenAI-compatible API also works with `LLM_PRIMARY_KIND=openai`.
- **Fallback** (`LLM_FALLBACK_*`, optional): used only if the primary call fails, e.g. OmniRoute or a local Ollama.
- **Quick model** (`LLM_QUICK_*`, optional): a cheap model (e.g. Claude Haiku) for picking the daily stories and image focus. Empty = primary does everything.
- **Morning drafts** (`PREGEN_DRAFTS=true`): after the stories are picked, the primary model writes the posts for each one in the background, so ⚡ Jack it! opens a ready draft instantly. Write your opinion and press Generate posts to rewrite it.
- **Better model** (`LLM_PAID_*`, optional, e.g. Claude Sonnet): never automatic; a dropdown appears in the header to switch to it for important posts.

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

## Brands and clients

Brands → **+ New brand**: paste a website, the server reads it and AI drafts the profile with colours and font. Set Type = Client for client work.
The **Service** tab tracks clients (package, price, status), monthly revenue, editable packages and writes tailored proposal emails.

## Data

Everything (brand styles, stories, stars, minuses, saved posts) is in `data/db.json`.
Back up that file; delete it to reset to the bundled seed (today's brands and stories).
The local and claude.ai versions don't sync with each other.

## Safety

Bound to `127.0.0.1` only and has no login. Don't publish the port. To reach it
from elsewhere, put it behind Cloudflare Zero Trust like your other services.

## Model picker and cost

Under **Generate posts** there is a model picker: *Auto* uses the cheap chain (primary, then fallback);
the paid model appears there once `LLM_PAID_*` is set, otherwise it shows as not set up.
Next to it, faintly: the estimated cost of the last AI call and this month's running total, from token counts
(`LLM_<NAME>_PRICE=in,out` overrides the built-in Claude prices). It is an estimate, not an invoice.
