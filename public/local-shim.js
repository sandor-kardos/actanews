// Local stand-in for the claude.ai runtime: the app calls window.claude.use("sample" | "db" | "downloads")
// exactly as it does online; here those calls go to the local server instead.
(() => {
  "use strict";
  window.ACTA_LOCAL = true;
  const cfgP = fetch("/api/config").then(r => r.json()).catch(() => ({}));
  let paid = false;
  try { paid = localStorage.getItem("acta-paid") === "1"; } catch {}

  // Faint cost line in the header: last call and this month (estimate from token counts).
  const money = v => v == null ? "?" : v < 0.01 ? "$" + v.toFixed(4) : "$" + v.toFixed(2);
  function showCost(j) {
    const elC = document.getElementById("acta-cost"); if (!elC) return;
    const hu = (document.documentElement.lang || "hu") === "hu";
    elC.textContent = (j.cost !== undefined ? `~${money(j.cost)} · ` : "") + `${hu ? "hó" : "mo"} ~${money(j.monthCost)}`;
    elC.title = hu ? "Becsült költség a tokenszámból (nem számla)." : "Estimate from token counts (not an invoice).";
  }
  const blobToDataUrl = b => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(b); });
  async function callAi(input, opts = {}, json) {
    const imgs = opts.images ? [].concat(opts.images instanceof FileList ? [...opts.images] : opts.images) : [];
    const images = await Promise.all(imgs.map(blobToDataUrl));
    const r = await fetch("/api/sample", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ input, images, json, paid, tier: opts.modelTier || "default" }), signal: opts.signal });
    const j = await r.json().catch(() => ({}));
    if (r.ok) showCost(j);
    if (!r.ok) throw { code: j.code || (r.status === 429 ? "rate_limited" : "unavailable"), message: j.message || "HTTP " + r.status };
    return j;
  }
  const sample = async (input, opts = {}) => {
    const j = await callAi(input, opts, false);
    try { opts.onText && opts.onText({ text: j.text, delta: j.text }); } catch {}
    return { text: j.text, truncated: false, modelApplied: j.model };
  };
  sample.json = async (input, opts = {}) => (await callAi(input, opts, true)).json;
  sample.limits = async () => {
    const c = await cfgP;
    return c.vision ? { inputBytes: 40e6, images: { maxCount: 4, maxBytes: 8e6, mediaTypes: ["image/jpeg", "image/png", "image/webp", "image/gif"] } } : { inputBytes: 40e6 };
  };

  /* ---- db: same surface the page uses (collection().onSnapshot, doc().set/update/delete) ---- */
  const subs = new Map(); // collection -> Set<{next, error}>
  const snap = docs => ({ docs: docs.map(d => ({ id: d.id, exists: true, data: () => d.data, metadata: {} })), size: docs.length, empty: !docs.length, docChanges: () => [] });
  async function refresh(c) {
    const set = subs.get(c); if (!set || !set.size) return;
    try {
      const j = await (await fetch("/api/db/" + encodeURIComponent(c))).json();
      set.forEach(s => { try { s.next(snap(j.docs || [])); } catch (e) { console.error(e); } });
    } catch (e) { set.forEach(s => s.error && s.error(e)); }
  }
  async function write(method, c, id, data) {
    const r = await fetch(`/api/db/${encodeURIComponent(c)}/${encodeURIComponent(id)}`, { method, headers: { "content-type": "application/json" }, body: data === undefined ? undefined : JSON.stringify(data) });
    if (!r.ok) throw { code: "unavailable", message: "HTTP " + r.status };
    await refresh(c);
  }
  const docRef = (c, id) => ({
    id,
    set: data => write("PUT", c, id, data),
    update: data => write("PATCH", c, id, data),
    delete: () => write("DELETE", c, id),
    get: async () => { const r = await fetch(`/api/db/${encodeURIComponent(c)}/${encodeURIComponent(id)}`); const j = r.ok ? await r.json() : null; return { id, exists: !!j, data: () => j?.data, metadata: {} }; }
  });
  const collectionRef = c => ({
    doc: id => docRef(c, id || String(Date.now())),
    onSnapshot(next, error) {
      if (!subs.has(c)) subs.set(c, new Set());
      const s = { next, error }; subs.get(c).add(s); refresh(c);
      return () => subs.get(c).delete(s);
    }
  });
  const dbNs = {
    collection: collectionRef,
    doc: p => { const parts = p.split("/"); return docRef(parts.slice(0, -1).join("/"), parts[parts.length - 1]); }
  };
  let rev = -1;
  setInterval(async () => {
    try { const j = await (await fetch("/api/db/rev")).json(); if (rev !== -1 && j.rev !== rev) subs.forEach((_, c) => refresh(c)); rev = j.rev; } catch {}
  }, 4000);

  const downloads = {
    async save({ filename, data }) {
      const blob = data instanceof Blob ? data : new Blob([data]);
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      return { saved: true };
    }
  };
  const user = { isOwner: () => true, canEdit: () => true, can: () => true, id: async () => "local", me: async () => ({ id: "local", name: "" }) };
  const NS = { sample, db: dbNs, downloads, user };
  window.claude = { use: name => new Promise(res => setTimeout(() => res(NS[name] || null), 0)) };

  /* ---- local-only controls: model picker + news refresh ---- */
  document.addEventListener("DOMContentLoaded", async () => {
    const c = await cfgP;
    const hu = () => (document.documentElement.lang || "hu") === "hu";
    const header = document.querySelector("header .in");
    if (!header) return;
    // Model picker is always visible: automatic (cheap) chain, plus the paid model when it is configured.
    const sel = document.createElement("select");
    sel.id = "acta-model"; sel.title = "AI";
    sel.style.cssText = "width:auto;max-width:150px;padding:5px 8px;font-size:12px;border-radius:999px";
    const short = m => String(m || "?").replace(/^claude-/, "");
    const auto = "Auto · " + short(c.primary?.model) + (c.fallback ? " → " + short(c.fallback.model) : "");
    sel.innerHTML = `<option value="0">${auto}</option>` + (c.paidAvailable
      ? `<option value="1">${short(c.paid.model)} ($)</option>`
      : `<option value="1" disabled>${hu() ? "Drágább modell: nincs beállítva" : "Paid model: not set up"}</option>`);
    if (!c.paidAvailable) paid = false;
    sel.value = paid ? "1" : "0";
    sel.addEventListener("change", () => { paid = sel.value === "1"; try { localStorage.setItem("acta-paid", paid ? "1" : "0"); } catch {} });
    const cost = document.createElement("span");
    cost.id = "acta-cost";
    cost.style.cssText = "font:12px/1.3 ui-monospace,monospace;opacity:.55;white-space:nowrap";
    // Under the generate button, where the choice matters; header stays one line.
    const row = document.createElement("div");
    row.style.cssText = "display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-top:8px";
    row.append(sel, cost);
    const gen = document.getElementById("genBtn");
    if (gen) gen.parentElement.after(row); else header.insertBefore(row, header.querySelector("nav"));
    showCost({ monthCost: c.monthCost || 0 });
  });
})();
