// Builds data/cards.json: every English set's card list from TCGdex in one file,
// so the binder loads one file instead of asking TCGdex about every card.
// Runs nightly on GitHub Actions. Only new sets, recent sets and sets not refreshed
// for REFRESH_DAYS are fetched again; everything else is reused from the last build.
import { readFile, writeFile, mkdir } from "node:fs/promises";

const TCG = process.env.TCGDEX || "https://api.tcgdex.net/v2/en";
const OUT = "data/cards.json";
const REFRESH_DAYS = 30, RECENT_DAYS = 180, CONCURRENCY = 12;
const DAY = 864e5, now = Date.now();

const html = await readFile("index.html", "utf8");
const block = html.slice(html.indexOf("const SERIES = ["), html.indexOf("/* ---------- English card data"));
const sets = [...block.matchAll(/\{id:"([^"]+)"([^}]*)\}/g)]
  .filter(m => !/local:true/.test(m[2]))
  .map(m => ({ id: m[1], date: (m[2].match(/date:"([^"]+)"/) || [])[1] || "" }));
if (!sets.length) throw new Error("No sets found in index.html");

let prev = { sets: {} };
try { prev = JSON.parse(await readFile(OUT, "utf8")); } catch {}

async function get(path, tries = 4) {
  for (let t = 1; ; t++) {
    try {
      const r = await fetch(TCG + path, { headers: { "User-Agent": "pokemon-binder-build (github.com/Monchow-lab/pokemon-binder)" } });
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("HTTP " + r.status);
      return await r.json();
    } catch (e) {
      if (t >= tries) throw e;
      await new Promise(res => setTimeout(res, 1000 * t * t));
    }
  }
}
async function pool(items, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const k = i++; await fn(items[k], k); } }));
}
// same rules as the site used when it fetched live
function variantsOf(d) {
  const vs = [];
  for (const v of (d && d.variants_detailed) || []) {
    if (v.stamp || v.foil === "cosmos" || (v.size && v.size !== "standard")) continue;
    const key = v.type === "reverse" ? "r-" + (v.foil || "") : v.type[0];
    if (!vs.includes(key)) vs.push(key);
  }
  if (!vs.length) vs.push("n");
  return vs;
}

const out = { built: new Date().toISOString(), sets: {} };
let fetched = 0, reused = 0, failed = [];
for (const s of sets) {
  const old = prev.sets[s.id];
  const recent = s.date && now - Date.parse(s.date) < RECENT_DAYS * DAY;
  let st;
  try { st = await get(`/sets/${encodeURIComponent(s.id)}`); } catch (e) { st = null; }
  if (!st) { if (old) { out.sets[s.id] = old; reused++; } else failed.push(s.id); continue; }
  const same = old && old.rows.length === st.cards.length;
  if (same && !recent && now - old.at < REFRESH_DAYS * DAY) {
    out.sets[s.id] = { ...old, official: (st.cardCount && st.cardCount.official) || old.official, logo: st.logo || old.logo || "" };
    reused++; continue;
  }
  const oldRows = Object.fromEntries((old ? old.rows : []).map(r => [r[0], r]));
  const rows = new Array(st.cards.length);
  await pool(st.cards, CONCURRENCY, async (c, k) => {
    let d = null;
    try { d = await get(`/cards/${encodeURIComponent(c.id)}`); } catch {}
    rows[k] = d ? [c.localId, c.name, d.rarity || "", variantsOf(d)] : (oldRows[c.localId] || [c.localId, c.name, "", ["n"]]);
  });
  out.sets[s.id] = { at: now, official: (st.cardCount && st.cardCount.official) || rows.length + 999, logo: st.logo || "", rows };
  fetched++;
  console.log(`${s.id}: ${rows.length} cards`);
}
await mkdir("data", { recursive: true });
await writeFile(OUT, JSON.stringify(out));
console.log(`Done: ${fetched} sets fetched, ${reused} reused, ${failed.length} unavailable${failed.length ? " (" + failed.join(", ") + ")" : ""}`);
