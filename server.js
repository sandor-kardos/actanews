// ActaNews local server: serves the app, proxies AI calls, stores data in a JSON file
// and builds the daily "3 stories" list from RSS feeds. Zero dependencies (Node 20+).
"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const env = (k, d = "") => (process.env[k] ?? d).trim();
const PORT = Number(env("PORT", "8787"));
const DATA_DIR = env("DATA_DIR", path.join(__dirname, "data"));
const TZ = env("TZ", "Europe/London");
const NEWS_TIME = env("NEWS_TIME", "06:39");
const PUBLIC_DIR = path.join(__dirname, "public");
const DEFAULTS_DIR = path.join(__dirname, "defaults");

/* ---------------- AI providers ----------------
 * primary  = free local model (Ollama), used first
 * fallback = free gateway (OmniRoute), used only if primary fails
 * paid     = only when the user picks it in the UI, never automatic
 */
function provider(prefix) {
  const url = env(prefix + "_URL");
  if (!url) return null;
  if (env(prefix + "_KIND", "openai") === "anthropic" && !env(prefix + "_KEY")) return null; // no key, not usable
  return {
    name: prefix.replace("LLM_", "").toLowerCase(),
    kind: env(prefix + "_KIND", "openai"), // openai (any OpenAI-compatible API) | anthropic
    url: url.replace(/\/+$/, ""),
    model: env(prefix + "_MODEL"),
    key: env(prefix + "_KEY"),
    vision: env(prefix + "_VISION", "false") === "true",
    jsonMode: env(prefix + "_JSON_MODE", "true") === "true"
  };
}
const PRIMARY = provider("LLM_PRIMARY");
const FALLBACK = provider("LLM_FALLBACK");
const PAID = provider("LLM_PAID");
const QUICK = provider("LLM_QUICK"); // cheap model for picking/scoring and other "quick" calls
const TIMEOUT_MS = Number(env("LLM_TIMEOUT_MS", "240000"));

function dataUrlParts(u) {
  const m = /^data:([^;]+);base64,(.+)$/s.exec(u || "");
  return m ? { mediaType: m[1], data: m[2] } : null;
}

async function callProvider(p, prompt, images, wantJson) {
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  const imgs = p.vision ? images : [];
  if (p.kind === "anthropic") {
    const content = [
      ...imgs.map(dataUrlParts).filter(Boolean).map(i => ({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.data } })),
      { type: "text", text: prompt }
    ];
    const r = await fetch(p.url + "/v1/messages", {
      method: "POST", signal,
      headers: { "content-type": "application/json", "x-api-key": p.key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: p.model, max_tokens: 6000, messages: [{ role: "user", content }] })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j?.error?.message || "HTTP " + r.status), { status: r.status });
    return (j.content || []).filter(c => c.type === "text").map(c => c.text).join("");
  }
  const content = imgs.length
    ? [{ type: "text", text: prompt }, ...imgs.map(u => ({ type: "image_url", image_url: { url: u } }))]
    : prompt;
  const body = { model: p.model, messages: [{ role: "user", content }], temperature: 0.6, max_tokens: 6000 };
  const send = async withJson => {
    const r = await fetch(p.url + "/chat/completions", {
      method: "POST", signal,
      headers: Object.assign({ "content-type": "application/json" }, p.key ? { authorization: "Bearer " + p.key } : {}),
      body: JSON.stringify(withJson ? { ...body, response_format: { type: "json_object" } } : body)
    });
    const j = await r.json().catch(() => ({}));
    return { r, j };
  };
  let { r, j } = await send(wantJson && p.jsonMode);
  if (!r.ok && wantJson && p.jsonMode && r.status === 400) ({ r, j } = await send(false)); // provider without JSON mode
  if (!r.ok) throw Object.assign(new Error(j?.error?.message || j?.error || "HTTP " + r.status), { status: r.status });
  return j?.choices?.[0]?.message?.content || "";
}

function extractJson(text) {
  const s = String(text || "").replace(/```(?:json)?/gi, "").trim();
  try { return JSON.parse(s); } catch {}
  const start = s.search(/[{[]/);
  if (start < 0) return undefined;
  for (let end = s.length; end > start; end--) {
    const ch = s[end - 1];
    if (ch !== "}" && ch !== "]") continue;
    try { return JSON.parse(s.slice(start, end)); } catch {}
  }
  return undefined;
}

async function runLlm({ prompt, images = [], json = false, paid = false, tier = "default" }) {
  const chain = paid ? [PAID] : tier === "quick" ? [QUICK, PRIMARY, FALLBACK] : [PRIMARY, FALLBACK];
  const list = chain.filter(Boolean);
  if (!list.length) throw Object.assign(new Error(paid ? "No paid model is configured (LLM_PAID_URL)." : "No model is configured (LLM_PRIMARY_URL)."), { code: "unavailable" });
  let lastErr;
  for (const p of list) {
    try {
      let text = await callProvider(p, prompt, images, json);
      if (!json) return { text, provider: p.name, model: p.model };
      let parsed = extractJson(text);
      if (parsed === undefined) {
        text = await callProvider(p, prompt + "\n\nYour previous answer was not valid JSON. Reply with ONLY the JSON object, nothing else.", images, true);
        parsed = extractJson(text);
      }
      if (parsed !== undefined) return { text, json: parsed, provider: p.name, model: p.model };
      lastErr = new Error(`${p.name} (${p.model}) did not return valid JSON.`);
    } catch (e) {
      lastErr = e;
      console.warn(`[llm] ${p.name} failed: ${e.message}`);
    }
  }
  throw lastErr;
}

/* ---------------- JSON file database ---------------- */
const DB_FILE = path.join(DATA_DIR, "db.json");
const NAME_RE = /^[A-Za-z0-9_\-.~:@+]{1,200}$/;
let db = { rev: 0, collections: {} };

// Seed docs are imported once each: new ones arrive with a deploy, existing data is never overwritten,
// and anything you delete stays deleted (imported ids are remembered in db.seeded).
function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const fresh = !fs.existsSync(DB_FILE);
  if (!fresh) db = JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  db.seeded ||= {};
  const seedFile = path.join(DEFAULTS_DIR, "seed.json");
  let added = 0;
  if (fs.existsSync(seedFile)) {
    const seed = JSON.parse(fs.readFileSync(seedFile, "utf8"));
    for (const [c, docs] of Object.entries(seed)) for (const [id, data] of Object.entries(docs)) {
      const key = c + "/" + id;
      if (db.seeded[key]) continue;
      db.seeded[key] = true;
      if (!col(c)[id]) { col(c)[id] = data; added++; }
      else if (c === "news" && Array.isArray(data.extras) && !col(c)[id].extras) { col(c)[id].extras = data.extras; added++; }
    }
  }
  if (added || fresh) { db.rev++; saveDb(); }
  console.log(`[db] ${fresh ? "created" : "loaded"} ${DB_FILE}, ${added} new seed item(s) imported`);
}
function saveDb() {
  const tmp = DB_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
  fs.renameSync(tmp, DB_FILE);
}
const col = name => (db.collections[name] ||= {});
function setDoc(c, id, data) { col(c)[id] = data; db.rev++; saveDb(); }
function delDoc(c, id) { delete col(c)[id]; db.rev++; saveDb(); }

/* ---------------- News from RSS ---------------- */
const FEEDS_FILE = path.join(DATA_DIR, "feeds.json");
function loadFeeds() {
  if (!fs.existsSync(FEEDS_FILE)) fs.copyFileSync(path.join(DEFAULTS_DIR, "feeds.json"), FEEDS_FILE);
  return JSON.parse(fs.readFileSync(FEEDS_FILE, "utf8"));
}
function feedUrl(f) {
  if (f.url) return f.url;
  const g = f.google || {};
  const hu = g.lang === "hu";
  const q = encodeURIComponent(g.q + (g.when ? ` when:${g.when}` : " when:2d"));
  return hu
    ? `https://news.google.com/rss/search?q=${q}&hl=hu&gl=HU&ceid=HU:hu`
    : `https://news.google.com/rss/search?q=${q}&hl=en-GB&gl=GB&ceid=GB:en`;
}
const decode = s => String(s || "")
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
  .replace(/<[^>]+>/g, " ")
  .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, "&")
  .replace(/\s+/g, " ").trim();
const tag = (block, name) => { const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(block); return m ? m[1] : ""; };
function parseFeed(xml, feed) {
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || [];
  return blocks.map(b => {
    const atomLink = /<link[^>]*href="([^"]+)"/i.exec(b);
    const link = decode(tag(b, "link")) || (atomLink ? atomLink[1] : "");
    const when = new Date(decode(tag(b, "pubDate") || tag(b, "published") || tag(b, "updated") || tag(b, "dc:date")));
    let title = decode(tag(b, "title"));
    const source = decode(tag(b, "source")) || feed.source || "";
    if (source && title.endsWith(" - " + source)) title = title.slice(0, -(source.length + 3)); // Google News suffix
    return { title, url: link, source, date: isNaN(when) ? null : when, snippet: decode(tag(b, "description") || tag(b, "summary")).slice(0, 300), brand: feed.brand, lang: feed.lang || "en" };
  }).filter(i => i.title && i.url);
}
const ymd = (d, tz = TZ) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(d);
const hm = (d, tz = TZ) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);

let newsRunning = false, lastNewsStatus = { state: "idle" };
async function runNews(reason = "manual") {
  if (newsRunning) return lastNewsStatus;
  newsRunning = true; lastNewsStatus = { state: "running", reason, startedAt: new Date().toISOString() };
  try {
    const feeds = loadFeeds();
    const prefs = col("prefs").news || { liked: [], disliked: [] };
    const seen = new Set(Object.values(col("news")).flatMap(d => (d.items || []).map(i => i.url)));
    const disliked = new Set((prefs.disliked || []).map(x => x.url).filter(Boolean));
    const dislikedTitles = (prefs.disliked || []).map(x => (x.title_original || x.title || "").toLowerCase()).filter(Boolean);
    const cutoff = Date.now() - Number(env("NEWS_MAX_AGE_HOURS", "72")) * 3600e3;
    const results = await Promise.allSettled(feeds.map(async f => {
      const r = await fetch(feedUrl(f), { signal: AbortSignal.timeout(20000), headers: { "user-agent": "Mozilla/5.0 ActaNews/1.0" } });
      if (!r.ok) throw new Error(`${feedUrl(f)} HTTP ${r.status}`);
      return parseFeed(await r.text(), f).slice(0, 12);
    }));
    results.filter(r => r.status === "rejected").forEach(r => console.warn("[news] feed failed:", r.reason.message));
    const byUrl = new Map();
    results.filter(r => r.status === "fulfilled").flatMap(r => r.value)
      .filter(i => (!i.date || i.date.getTime() >= cutoff) && !seen.has(i.url) && !disliked.has(i.url) && !dislikedTitles.includes(i.title.toLowerCase()))
      .forEach(i => { if (!byUrl.has(i.url)) byUrl.set(i.url, i); });
    const candidates = [...byUrl.values()].sort((a, b) => (b.date?.getTime() || 0) - (a.date?.getTime() || 0)).slice(0, 60);
    if (!candidates.length) throw new Error("No fresh candidates from the feeds. Check data/feeds.json and the container's internet access.");
    const brands = col("brands");
    const brandInfo = Object.fromEntries(Object.entries(brands).map(([id, b]) => [id, { name: b.name, audience: b.audience, language: b.language, rules: b.rules }]));
    const prompt = `You pick today's 3 news stories for a small business owner to react to on social media, one brand each where possible.

BRANDS (JSON)
${JSON.stringify(brandInfo, null, 1)}

OWNER FEEDBACK
Starred (prefer similar topics/sources): ${JSON.stringify((prefs.liked || []).slice(-10).map(x => x.title))}
Not needed (avoid these topics and angles): ${JSON.stringify((prefs.disliked || []).slice(-15).map(x => x.title_original || x.title))}

CANDIDATES (index, suggested brand, language, date, source, title, snippet)
${candidates.map((c, i) => `${i} | ${c.brand} | ${c.lang} | ${c.date ? ymd(c.date) : "?"} | ${c.source} | ${c.title} | ${c.snippet}`).join("\n")}

Rules: pick exactly 3 different candidates, ideally for 3 different brands. Never pick tragedies, crime, violence, suicide, disasters or politically divisive items for mindhaven or asc. bereljufot items must concern Hungary. Base summaries ONLY on the title and snippet given; do not add facts, numbers or quotes that are not there. No em dashes.
Return ONLY JSON: {"items":[{"index":0,"brand":"brand id","title":"short Hungarian headline","title_en":"short English headline","summary":"1-2 sentence Hungarian summary","summary_en":"the same in English","angle":"one-line Hungarian posting angle for that brand","angle_en":"the same in English"}]}`;
    const out = await runLlm({ prompt, json: true, tier: "quick" });
    const picks = (out.json?.items || []).filter(p => Number.isInteger(p.index) && candidates[p.index]).slice(0, 3);
    if (!picks.length) throw new Error("The model returned no usable picks.");
    const date = ymd(new Date());
    const items = picks.map(p => {
      const c = candidates[p.index];
      return {
        title: p.title || c.title, title_en: p.title_en || "", title_original: c.title,
        summary: p.summary || c.snippet, summary_en: p.summary_en || "",
        angle: p.angle || "", angle_en: p.angle_en || "",
        source: c.source, url: c.url, date: c.date ? ymd(c.date) : date,
        brands: [brands[p.brand] ? p.brand : c.brand]
      };
    });
    setDoc("news", date, { date, items, note: `RSS + ${out.provider} (${out.model}), ${reason}` });
    lastNewsStatus = { state: "done", date, count: items.length, provider: out.provider, finishedAt: new Date().toISOString() };
    pregenDrafts(date).catch(e => console.warn("[drafts] " + e.message));
    console.log(`[news] ${date}: ${items.map(i => i.title).join(" | ")}`);
  } catch (e) {
    lastNewsStatus = { state: "error", message: e.message, finishedAt: new Date().toISOString() };
    console.warn("[news] " + e.message);
  } finally { newsRunning = false; }
  return lastNewsStatus;
}
let lastScheduledDay = "";
setInterval(() => {
  const now = new Date();
  if (hm(now) === NEWS_TIME && lastScheduledDay !== ymd(now)) { lastScheduledDay = ymd(now); runNews("scheduled"); }
}, 30000);

/* ---------------- Article fetch (link -> clean text) ---------------- */
const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|0\.|\[?::1\]?$|.*\.local$|.*\.internal$)/i;
function metaContent(html, key) {
  const re1 = new RegExp(`<meta[^>]+(?:property|name)=["']${key}["'][^>]*content=["']([^"']*)["']`, "i");
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${key}["']`, "i");
  const m = re1.exec(html) || re2.exec(html);
  return m ? decode(m[1]) : "";
}
async function fetchArticle(raw) {
  let u;
  try { u = new URL(String(raw || "").trim()); } catch { throw new Error("Invalid link"); }
  if (!/^https?:$/.test(u.protocol) || (env("ARTICLE_ALLOW_PRIVATE") !== "1" && PRIVATE_HOST.test(u.hostname))) throw new Error("This link can't be fetched");
  const r = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(15000), headers: { "user-agent": "Mozilla/5.0 (compatible; ActaNews/1.2)", "accept-language": "en-GB,en;q=0.9,hu;q=0.8" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  if (!/html/i.test(r.headers.get("content-type") || "")) throw new Error("Not a web page");
  const html = (await r.text()).slice(0, 3e6);
  const title = metaContent(html, "og:title") || decode(tag(html, "title"));
  const description = metaContent(html, "og:description") || metaContent(html, "description");
  const site = metaContent(html, "og:site_name") || new URL(r.url).hostname.replace(/^www\./, "");
  const pub = metaContent(html, "article:published_time") || metaContent(html, "datePublished") || metaContent(html, "date");
  let body = html.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|figure)[\s\S]*?<\/\1>/gi, " ");
  const art = /<article[\s\S]*?<\/article>/i.exec(body); if (art) body = art[0];
  const paras = (body.match(/<p[\s>][\s\S]*?<\/p>/gi) || []).map(decode).filter(p => p.length > 40);
  const text = [...new Set(paras)].join("\n\n").slice(0, 6000);
  return { title, description, site, published: pub ? pub.slice(0, 10) : "", url: r.url, text };
}

/* ---------------- Site profile (website -> facts, colours, fonts for a new brand) ---------------- */
async function siteProfile(raw) {
  let u;
  try { u = new URL(/^https?:/i.test(String(raw || "").trim()) ? String(raw).trim() : "https://" + String(raw || "").trim()); } catch { throw new Error("Invalid link"); }
  if (env("ARTICLE_ALLOW_PRIVATE") !== "1" && PRIVATE_HOST.test(u.hostname)) throw new Error("This link can't be fetched");
  const r = await fetch(u, { redirect: "follow", signal: AbortSignal.timeout(15000), headers: { "user-agent": "Mozilla/5.0 (compatible; ActaNews/1.6)", "accept-language": "en-GB,en;q=0.9,hu;q=0.8" } });
  if (!r.ok) throw new Error("HTTP " + r.status);
  const html = (await r.text()).slice(0, 3e6);
  const counts = {};
  (html.match(/#[0-9a-fA-F]{6}\b/g) || []).forEach(c => { const k = c.toUpperCase(); if (!/^#(F{6}|0{6}|F[0-9A-F]F[0-9A-F]F[0-9A-F]|EE?E?E?E?E?)$/.test(k)) counts[k] = (counts[k] || 0) + 1; });
  const colors = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c, n]) => `${c} x${n}`);
  const fonts = [...new Set([...html.matchAll(/fonts\.googleapis\.com\/css2?\?[^"'>]*?family=([^"'&>:]+)/gi)].map(m => decodeURIComponent(m[1]).replace(/\+/g, " ")))].slice(0, 4);
  const cssFonts = [...new Set([...html.matchAll(/font-family:\s*['"]?([^;'",}]+)/gi)].map(m => m[1].trim()))].slice(0, 6);
  const body = html.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ");
  const heads = (body.match(/<h[1-3][\s>][\s\S]*?<\/h[1-3]>/gi) || []).map(decode).filter(Boolean).slice(0, 15);
  const paras = [...new Set((body.match(/<(p|li)[\s>][\s\S]*?<\/(p|li)>/gi) || []).map(decode).filter(x => x.length > 30))];
  return {
    url: r.url, title: decode(tag(html, "title")), site: metaContent(html, "og:site_name"),
    description: metaContent(html, "og:description") || metaContent(html, "description"),
    theme_color: metaContent(html, "theme-color"), colors, google_fonts: fonts, css_fonts: cssFonts,
    headings: heads, text: paras.join("\n").slice(0, 5000)
  };
}

/* ---------------- Morning drafts ----------------
 * After the stories are picked, write the posts for each one in the background, using the exact
 * prompt the page uses (read from the prompts block marked in index.html), so Jack it! opens instantly.
 */
function loadPromptCore() {
  const html = fs.readFileSync(path.join(PUBLIC_DIR, "index.html"), "utf8");
  const m = /\/\*<prompts>\*\/([\s\S]*?)\/\*<\/prompts>\*\//.exec(html);
  if (!m) throw new Error("prompt block missing in index.html");
  const ctx = vm.createContext({});
  vm.runInContext(m[1] + "\nthis.buildPromptCore = buildPromptCore;", ctx);
  return ctx.buildPromptCore;
}
async function pregenDrafts(date) {
  if (env("PREGEN_DRAFTS", "true") !== "true") return;
  const build = loadPromptCore();
  const plats = env("PREGEN_PLATFORMS", "facebook,instagram,linkedin").split(",").map(s => s.trim()).filter(Boolean);
  const lang = env("PREGEN_LANG", "Hungarian");
  const count = (col("news")[date]?.items || []).length;
  for (let i = 0; i < count; i++) {
    const n = col("news")[date]?.items?.[i];
    if (!n || n.draft) continue;
    let src = `${n.title_original || n.title}\n${n.summary_en || n.summary}\nSource: ${n.source}${n.url ? " " + n.url : ""} (${n.date || date})`;
    if (n.url) { try { const a = await fetchArticle(n.url); if (a.text && a.text.length > 200) src += `\n\n${a.title}\n${a.text}`; } catch {} }
    const brands = col("brands");
    const brandIds = (n.brands?.length ? n.brands : Object.keys(brands)).filter(id => brands[id]);
    try {
      const out = await runLlm({ prompt: build({ src, opinion: "", brandIds, platIds: plats, brands, prefs: col("prefs"), aiLang: lang, hasShot: false }), json: true });
      if (!Array.isArray(out.json?.brands)) throw new Error("unexpected format");
      const cur = col("news")[date];
      if (!cur?.items?.[i]) return;
      cur.items[i] = { ...cur.items[i], draft: { res: out.json, src, brandIds, platIds: plats, at: new Date().toISOString(), model: out.model } };
      db.rev++; saveDb();
      console.log(`[drafts] ${date} #${i + 1} ready (${out.model})`);
    } catch (e) { console.warn(`[drafts] ${date} #${i + 1}: ${e.message}`); }
  }
}

/* ---------------- HTTP ---------------- */
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon" };
const send = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }); res.end(JSON.stringify(obj)); };
async function readBody(req, limit = 40e6) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw Object.assign(new Error("Request too large"), { status: 413 }); chunks.push(c); }
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://local");
  const p = u.pathname;
  try {
    if (p === "/api/config" && req.method === "GET") {
      return send(res, 200, {
        vision: !!(PRIMARY?.vision || FALLBACK?.vision), paidAvailable: !!PAID,
        primary: PRIMARY && { model: PRIMARY.model }, quick: QUICK && { model: QUICK.model }, fallback: FALLBACK && { model: FALLBACK.model }, paid: PAID && { model: PAID.model },
        newsTime: NEWS_TIME, tz: TZ
      });
    }
    if (p === "/api/sample" && req.method === "POST") {
      const b = await readBody(req);
      const prompt = typeof b.input === "string" ? b.input : (b.input || []).map(m => `${m.role.toUpperCase()}: ${m.content}`).join("\n\n");
      try { return send(res, 200, await runLlm({ prompt, images: b.images || [], json: !!b.json, paid: !!b.paid, tier: b.tier === "quick" ? "quick" : "default" })); }
      catch (e) { return send(res, e.status === 429 ? 429 : 502, { code: e.code || (e.status === 429 ? "rate_limited" : "provider_error"), message: e.message }); }
    }
    if (p === "/api/db/rev" && req.method === "GET") return send(res, 200, { rev: db.rev });
    let m = /^\/api\/db\/([^/]+)$/.exec(p);
    if (m && req.method === "GET") {
      if (!NAME_RE.test(m[1])) return send(res, 400, { message: "bad collection" });
      return send(res, 200, { rev: db.rev, docs: Object.entries(col(m[1])).map(([id, data]) => ({ id, data })) });
    }
    m = /^\/api\/db\/([^/]+)\/([^/]+)$/.exec(p);
    if (m) {
      const [, c, id] = m;
      if (!NAME_RE.test(c) || !NAME_RE.test(id)) return send(res, 400, { message: "bad path" });
      if (req.method === "GET") return col(c)[id] ? send(res, 200, { id, data: col(c)[id] }) : send(res, 404, { message: "not found" });
      if (req.method === "PUT") { const data = await readBody(req, 2e6); setDoc(c, id, data); return send(res, 200, { ok: true, rev: db.rev }); }
      if (req.method === "PATCH") { const data = await readBody(req, 2e6); setDoc(c, id, { ...(col(c)[id] || {}), ...data }); return send(res, 200, { ok: true, rev: db.rev }); }
      if (req.method === "DELETE") { delDoc(c, id); return send(res, 200, { ok: true, rev: db.rev }); }
    }
    if (p === "/api/site-profile" && req.method === "POST") {
      const b = await readBody(req, 1e5);
      try { return send(res, 200, await siteProfile(b.url)); }
      catch (e) { return send(res, 422, { message: e.message }); }
    }
    if (p === "/api/article" && req.method === "POST") {
      const b = await readBody(req, 1e5);
      try { return send(res, 200, await fetchArticle(b.url)); }
      catch (e) { return send(res, 422, { message: e.message }); }
    }
    if (p === "/api/news/refresh" && req.method === "POST") { runNews("manual"); return send(res, 202, { state: "running" }); }
    if (p === "/api/news/status" && req.method === "GET") return send(res, 200, lastNewsStatus);

    // static files (browsers ask for /favicon.ico by default; serve the SVG icon)
    const file = path.normalize(path.join(PUBLIC_DIR, p === "/" ? "index.html" : p === "/favicon.ico" ? "favicon.svg" : p));
    if (!file.startsWith(PUBLIC_DIR) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end("Not found"); }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-cache" });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    send(res, e.status || 500, { message: e.message });
  }
});

loadDb();
loadFeeds();
server.listen(PORT, () => {
  console.log(`ActaNews on http://localhost:${PORT}`);
  console.log(`  primary : ${PRIMARY ? PRIMARY.model + " @ " + PRIMARY.url : "not set"}`);
  console.log(`  fallback: ${FALLBACK ? FALLBACK.model + " @ " + FALLBACK.url : "not set"}`);
  console.log(`  quick   : ${QUICK ? QUICK.model + " (story picking, scoring)" : "not set, using primary"}`);
  console.log(`  paid    : ${PAID ? PAID.model + " (manual only)" : "not set"}`);
  console.log(`  news    : daily at ${NEWS_TIME} ${TZ}, feeds in ${FEEDS_FILE}`);
});
