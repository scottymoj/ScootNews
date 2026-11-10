/* Scoot News — personal news app. Data: data/news.json + data/brief.json, rebuilt every ~20 min by GitHub Actions. */
"use strict";

const SECTIONS = {
  markets:  { name:"Markets & Business", short:"Markets" },
  world:    { name:"US & World", short:"World" },
  tech:     { name:"Tech & AI", short:"Tech" },
  politics: { name:"Politics", short:"Politics" },
};
// Words that make a story more likely to move markets (used to rank Home's top stories).
const MARKET_WORDS = /\b(fed|fomc|powell|rate|rates|inflation|cpi|ppi|jobs|payroll|unemployment|gdp|treasury|treasuries|yield|yields|bond|bonds|stocks?|s&p|dow|nasdaq|futures|earnings|guidance|revenue|profit|oil|opec|crude|gold|dollar|tariffs?|trade|sanctions|ipo|merger|acquisition|deal|bank|banks|recession|economy|economic|shares|nvidia|apple|microsoft|amazon|tesla|alphabet|meta|bitcoin|crypto|china|opec|budget|debt|shutdown)\b/i;

/* ---------------- utils ---------------- */
const $ = s => document.querySelector(s);
const app = $("#app");
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
const store = {
  get(k, d){ try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch(e){ return d; } },
  set(k, v){ try { localStorage.setItem(k, JSON.stringify(v)); } catch(e){} },
};
const ETZ = "America/New_York";
const fmtTimeET = iso => new Date(iso).toLocaleTimeString("en-US", { hour:"numeric", minute:"2-digit", timeZone:ETZ });
function ago(iso){
  const m = Math.round((Date.now() - new Date(iso)) / 6e4);
  if (m < 60) return `${Math.max(m,1)}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  return new Date(iso).toLocaleDateString([], { month:"short", day:"numeric" });
}
const img = (src, cls = "") => src ? `<img class="${cls}" src="${esc(src)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()">` : "";
const nf = (n, d = 2) => n == null ? "–" : n.toLocaleString("en-US", { minimumFractionDigits:d, maximumFractionDigits:d });
const sign = n => n > 0 ? "+" : n < 0 ? "−" : "";
const cls = n => n > 0 ? "pos" : n < 0 ? "neg" : "muted";

/* read + saved state */
let readIds = new Set(store.get("sn-read", []));
let saved = store.get("sn-saved", []);
const markRead = id => { readIds.add(id); store.set("sn-read", [...readIds].slice(-600)); };
const isSaved = id => saved.some(s => s.id === id);
function toggleSave(it){
  saved = isSaved(it.id) ? saved.filter(s => s.id !== it.id) : [{ ...it, savedAt: new Date().toISOString() }, ...saved];
  store.set("sn-saved", saved.slice(0, 200));
}

/* ---------------- data ---------------- */
let NEWS = null, BRIEF = null, BY_ID = {}, CL_BY_ID = {}, loadedAt = 0;
async function getJSON(path){
  const r = await fetch(`${path}?t=${Math.floor(Date.now() / 60000)}`, { cache:"no-store" });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}
async function load(force){
  if (!force && NEWS && Date.now() - loadedAt < 120000) return;
  const [n, b] = await Promise.all([getJSON("data/news.json"), getJSON("data/brief.json").catch(() => null)]);
  NEWS = n; BRIEF = b; loadedAt = Date.now();
  BY_ID = Object.fromEntries(n.items.map(i => [i.id, i]));
  CL_BY_ID = Object.fromEntries(n.clusters.map(c => [c.id, c]));
}
const leadOf = c => BY_ID[c.lead];
const clusterOf = it => CL_BY_ID[it.cluster];

function rankClusters(list, { market = false } = {}){
  const now = Date.now();
  return list.map(c => {
    const lead = leadOf(c); if (!lead) return null;
    const hrs = (now - new Date(c.latest)) / 36e5;
    let s = c.sources.length * 2.2 - hrs * 0.35;
    if (market){
      if (c.sections.includes("markets")) s += 2;
      if (MARKET_WORDS.test(lead.title + " " + lead.summary)) s += 2.5;
    }
    if (lead.image || c.image) s += 0.4;
    return { c, s, hrs };
  }).filter(Boolean).sort((a, b) => b.s - a.s).map(x => x.c);
}

/* ---------------- router / chrome ---------------- */
let viewToken = 0, current = null, timer = null;
function setChrome(tab, back){
  document.querySelectorAll(".nav a").forEach(a => a.classList.toggle("on", a.dataset.tab === tab));
  document.querySelectorAll(".mast-tools a").forEach(a => a.classList.toggle("on", a.getAttribute("href") === `#/${tab}`));
  $("#mast").classList.toggle("has-back", !!back);
}
$("#back").addEventListener("click", () => { if (history.length > 1) history.back(); else location.hash = "#/home"; });
function paint(tok, html){
  if (tok !== viewToken) return false;
  const y = window.scrollY; app.innerHTML = html; window.scrollTo(0, y); return true;
}
function schedule(){
  clearTimeout(timer);
  const tok = viewToken;
  timer = setTimeout(async () => { if (tok !== viewToken) return; if (!document.hidden && current) await current(true); schedule(); }, 5 * 60000);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && current && Date.now() - loadedAt > 120000) current(true); });

async function route(){
  viewToken++; clearTimeout(timer);
  const [v, ...a] = (location.hash.replace(/^#\/?/, "") || "home").split("/").map(decodeURIComponent);
  let fn;
  if (v === "s" && SECTIONS[a[0]]) fn = q => viewSection(a[0], a[1] || "top", a[2] || "all", q);
  else if (v === "a") fn = q => viewArticle(a[0], q);
  else if (v === "saved") fn = q => viewSaved(q);
  else if (v === "search") fn = q => viewSearch(q);
  else fn = q => viewHome(q);
  current = fn;
  window.scrollTo(0, 0);
  app.innerHTML = `<span class="spin"></span>`;
  try { await fn(false); schedule(); }
  catch (e) {
    console.error(e);
    const first = /news\.json: 404/.test(e.message);
    app.innerHTML = first
      ? `<div class="err"><b>No news data yet.</b> On GitHub, open the repo's Actions tab, choose "Update news", and press "Run workflow". Refresh here in about a minute.</div>`
      : `<div class="err">Couldn't load the news right now. Pull down to try again.<br><small class="muted">${esc(e.message)}</small></div>`;
  }
}
window.addEventListener("hashchange", route);

/* ---------------- shared pieces ---------------- */
const updatedLine = () => NEWS ? `<div class="updated">Updated ${esc(fmtTimeET(NEWS.updated))} ET · ${NEWS.feeds.filter(f => f.ok).length} feeds<br>Headlines and summaries come from each outlet's public feed.</div>` : "";
function moreTag(c){ const n = c ? c.sources.length - 1 : 0; return n > 0 ? `<span class="multi">+${n}</span>` : ""; }
function storyRow(it, { tag = true } = {}){
  const c = clusterOf(it), pic = it.image || (c && c.image);
  return `<a class="story ${pic ? "" : "noimg"} ${readIds.has(it.id) ? "read" : ""}" href="#/a/${esc(it.id)}">
    <div>${tag ? `<div class="tag">${esc(it.source)}${moreTag(c)}</div>` : ""}<h3>${esc(it.title)}</h3>
    ${it.summary ? `<p>${esc(it.summary)}</p>` : ""}<div class="when">${ago(it.time)}</div></div>
    ${pic ? img(pic) : ""}</a>`;
}
function leadBlock(c){
  const it = leadOf(c), pic = it.image || c.image;
  return `<a class="lead ${readIds.has(it.id) ? "read" : ""}" href="#/a/${esc(it.id)}">${img(pic)}
    <div class="tag">${esc(it.source)}${moreTag(c)}</div><h3>${esc(it.title)}</h3>
    ${it.summary ? `<p>${esc(it.summary)}</p>` : ""}<div class="when">${ago(it.time)}${c.sources.length > 1 ? ` · Also: ${esc(c.sources.filter(s => s !== it.source).slice(0,3).join(", "))}` : ""}</div></a>`;
}

/* ---------------- market helpers ---------------- */
function marketOpen(){
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone:ETZ, weekday:"short", hour:"numeric", minute:"numeric", hour12:false })
    .formatToParts(new Date()).map(x => [x.type, x.value]));
  const mins = (+p.hour % 24) * 60 + +p.minute;
  return !["Sat","Sun"].includes(p.weekday) && mins >= 570 && mins < 960;
}
function priceStr(r){
  if (r.kind === "yield") return nf(r.price, 3) + "%";
  if (r.symbol === "BTC-USD") return "$" + nf(r.price, 0);
  if (r.kind === "usd") return "$" + nf(r.price, 2);
  return nf(r.price, 2);
}
function chgStr(r){
  if (r.pct == null) return "";
  if (r.kind === "yield") return `${sign(r.chg_bp)}${Math.abs(r.chg_bp).toFixed(1)} bp`;
  return `${sign(r.pct)}${Math.abs(r.pct).toFixed(2)}%`;
}
const mkt = sym => BRIEF && BRIEF.markets.find(r => r.symbol === sym);

function snapshotStrip(){
  const open = marketOpen();
  const syms = open ? ["^GSPC","^DJI","^IXIC"] : ["ES=F","YM=F","NQ=F"];
  const list = [...syms, "^TNX", "DX-Y.NYB", "CL=F", "GC=F", "BTC-USD"].map(mkt).filter(Boolean);
  if (!list.length) return "";
  return `<div class="strip">${list.map(r => `<div class="tick"><div class="n">${esc(r.label)}</div>
    <div class="p">${priceStr(r)}</div><div class="c ${cls(r.kind === "yield" ? r.chg_bp : r.pct)}">${chgStr(r) || "&nbsp;"}</div></div>`).join("")}</div>`;
}
function snapshotTable(){
  if (!BRIEF || !BRIEF.markets.length) return `<div class="empty">Market data will show after the next update.</div>`;
  const groups = [["us","US stocks (last)"],["futures","US futures"],["global","Asia & Europe"],["macro","Rates, dollar, commodities, crypto"]];
  const rows = groups.map(([g, name]) => {
    const rs = BRIEF.markets.filter(r => r.group === g); if (!rs.length) return "";
    return `<tr class="grp"><td colspan="3">${name}</td></tr>` + rs.map(r => {
      const v = r.kind === "yield" ? r.chg_bp : r.pct;
      return `<tr><td>${esc(r.label)}</td><td><b>${priceStr(r)}</b></td><td class="${cls(v)}">${chgStr(r)}</td></tr>`;
    }).join("");
  }).join("");
  return `<div class="tbl-wrap"><table class="t"><thead><tr><th>Market</th><th>Price</th><th>Change</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}
function calendarTable(){
  const ev = (BRIEF && BRIEF.calendar) || [];
  if (!ev.length) return `<div class="empty">No major US data releases on today's calendar.</div>`;
  const now = Date.now();
  return `<div class="tbl-wrap"><table class="t"><thead><tr><th>Time ET</th><th style="text-align:left">Release</th><th>Actual</th><th>Fcst</th><th>Prior</th></tr></thead><tbody>${
    ev.map(e => `<tr class="${new Date(e.time) < now && !e.actual ? "" : ""}">
      <td>${e.allDay ? "All day" : esc(fmtTimeET(e.time))}</td>
      <td class="l"><span class="imp ${esc(e.impact)}" title="${esc(e.impact)} impact"></span>${esc(e.title)}</td>
      <td><b>${esc(e.actual || "–")}</b></td><td>${esc(e.forecast || "–")}</td><td>${esc(e.previous || "–")}</td></tr>`).join("")
  }</tbody></table></div><div class="note"><span class="imp High"></span>High impact <span class="imp Medium" style="margin-left:10px"></span>Medium <span class="imp" style="margin-left:10px"></span>Low</div>`;
}
function earningsBlock(){
  const e = BRIEF && BRIEF.earnings;
  if (!e || (!e.pre.length && !e.post.length && !e.other.length)) return `<div class="empty">No notable earnings today.</div>`;
  const col = (title, list) => `<div><h4>${title}</h4>${list.length ? list.map(x => `<div class="e"><b>${esc(x.symbol)}</b><span>${esc(x.name)}</span></div>`).join("") : `<div class="e"><span>None</span></div>`}</div>`;
  return `<div class="earn">${col("Before the open", e.pre)}${col("After the close", e.post.length ? e.post : e.other)}</div>`;
}
function bottomLine(top){
  const open = marketOpen();
  const bits = [];
  const eq = mkt(open ? "^GSPC" : "ES=F");
  if (eq && eq.pct != null) bits.push(`${open ? "The S&P 500 is" : "S&P 500 futures are"} ${eq.pct >= 0 ? "up" : "down"} ${Math.abs(eq.pct).toFixed(1)}%`);
  const y = mkt("^TNX");
  if (y) bits.push(`the 10-year yield is ${nf(y.price, 2)}%${y.chg_bp != null ? ` (${sign(y.chg_bp)}${Math.abs(Math.round(y.chg_bp))} bp)` : ""}`);
  const oil = mkt("CL=F");
  if (oil && oil.pct != null) bits.push(`oil is ${oil.pct >= 0 ? "up" : "down"} ${Math.abs(oil.pct).toFixed(1)}%`);
  let s = bits.length ? bits.join(", ").replace(/, ([^,]*)$/, " and $1") + "." : "";
  s = s.charAt(0).toUpperCase() + s.slice(1);
  if (top) s += ` Top story: ${top.title.replace(/\.$/, "")}.`;
  return s;
}

/* ---------------- views ---------------- */
async function viewHome(refresh){
  setChrome("home", false);
  const tok = viewToken; await load(refresh);
  const d = new Date();
  const dateStr = d.toLocaleDateString("en-US", { weekday:"long", month:"long", day:"numeric", timeZone:ETZ });
  const fresh = NEWS.clusters.filter(c => (Date.now() - new Date(c.latest)) / 36e5 < 20);
  const top = rankClusters(fresh.length >= 7 ? fresh : NEWS.clusters, { market:true }).slice(0, 7);
  const open = marketOpen();

  const stories = top.map((c, i) => {
    const it = leadOf(c), pic = i === 0 ? (it.image || c.image) : "";
    const others = c.sources.filter(s => s !== it.source);
    return `<a class="ts ${readIds.has(it.id) ? "read" : ""}" href="#/a/${esc(it.id)}">${pic ? img(pic, "hero") : ""}
      <div class="num">${i + 1}</div><div class="body"><h3>${esc(it.title)}</h3>
      ${it.summary ? `<div class="lbl">What happened</div><p>${esc(it.summary)}</p>` : ""}
      <div class="meta"><b>${esc(it.source)}</b>${others.length ? ` · also ${esc(others.slice(0, 3).join(", "))}${others.length > 3 ? ` +${others.length - 3}` : ""}` : ""} · ${ago(c.latest)}</div></div></a>`;
  }).join("");

  const sectionPeek = Object.entries(SECTIONS).filter(([k]) => k !== "markets").map(([k, s]) => {
    const cl = rankClusters(NEWS.clusters.filter(c => c.sections.includes(k) && !top.includes(c))).slice(0, 3);
    if (!cl.length) return "";
    return `<div class="h-sec"><h2>${s.name}</h2><a href="#/s/${k}">All ›</a></div>${cl.map(c => storyRow(leadOf(c))).join("")}`;
  }).join("");

  paint(tok, `
    <div class="bhead"><div class="kicker">Morning Market Brief</div><h1>${esc(dateStr)}</h1>
      <div class="sub"><span class="mstate ${open ? "open" : ""}">${open ? "Market open" : "Market closed"}</span>Updated <b>${esc(fmtTimeET(NEWS.updated))} ET</b></div></div>
    ${snapshotStrip()}
    <div class="h-sec"><h2>Top Stories</h2><span>Ranked by market impact</span></div>
    ${stories || `<div class="empty">No stories yet.</div>`}
    <div class="h-sec"><h2>Market Snapshot</h2>${BRIEF && BRIEF.markets[0] && BRIEF.markets[0].asof ? `<span>${esc(fmtTimeET(BRIEF.updated))} ET</span>` : ""}</div>
    ${snapshotTable()}
    <div class="h-sec"><h2>Today's Calendar</h2><span>US data &amp; Fed</span></div>
    ${calendarTable()}
    <div class="h-sec"><h2>Earnings Today</h2></div>
    ${earningsBlock()}
    <div class="h-sec"><h2>Bottom Line</h2></div>
    <div class="bline">${esc(bottomLine(top[0] && leadOf(top[0])))}</div>
    ${sectionPeek}
    ${updatedLine()}`);
}

async function viewSection(key, mode, src, refresh){
  setChrome(key, false);
  const tok = viewToken; await load(refresh);
  const S = SECTIONS[key];
  const pool = NEWS.items.filter(i => i.sections.includes(key));
  const sources = [...new Set(pool.map(i => i.source))].sort();
  const base = `#/s/${key}`;
  let body = "";
  if (src !== "all"){
    body = pool.filter(i => i.source === src).sort((a, b) => b.time.localeCompare(a.time)).map(i => storyRow(i)).join("");
  } else if (mode === "latest"){
    const seen = new Set();
    body = pool.sort((a, b) => b.time.localeCompare(a.time)).filter(i => !seen.has(i.cluster) && seen.add(i.cluster)).slice(0, 60).map(i => storyRow(i)).join("");
  } else {
    const cl = rankClusters(NEWS.clusters.filter(c => c.sections.includes(key)), { market: key === "markets" }).slice(0, 40);
    body = cl.length ? leadBlock(cl[0]) + cl.slice(1).map(c => storyRow(leadOf(c))).join("") : "";
  }
  paint(tok, `
    <div class="pagehead"><div class="kicker">Scoot News</div><h1>${esc(S.name)}</h1></div>
    ${key === "markets" ? snapshotStrip() : ""}
    <div class="subtabs"><a class="${mode !== "latest" && src === "all" ? "on" : ""}" href="${base}/top">Top</a><a class="${mode === "latest" && src === "all" ? "on" : ""}" href="${base}/latest">Latest</a></div>
    <div class="chips"><a class="chip ${src === "all" ? "on" : ""}" href="${base}/${mode}">All sources</a>${sources.map(s => `<a class="chip ${src === s ? "on" : ""}" href="${base}/${mode}/${encodeURIComponent(s)}">${esc(s)}</a>`).join("")}</div>
    ${body || `<div class="empty">Nothing here yet.</div>`}
    ${updatedLine()}`);
}

async function viewArticle(id, refresh){
  setChrome("", true);
  const tok = viewToken;
  await load(refresh).catch(() => {});
  const it = BY_ID[id] || saved.find(s => s.id === id);
  if (!it){ paint(tok, `<div class="err">This story has rolled off the feed. Stories stay for about 48 hours.</div>`); return; }
  markRead(id);
  const c = clusterOf(it);
  const nav = it.sections && it.sections[0];
  if (nav) document.querySelectorAll(".nav a").forEach(a => a.classList.toggle("on", a.dataset.tab === nav));
  const others = c ? c.items.filter(x => x !== id).map(x => BY_ID[x]).filter(Boolean) : [];
  const pic = it.image || (c && c.image);
  const more = nav ? rankClusters(NEWS.clusters.filter(k => k.sections.includes(nav) && k !== c)).slice(0, 4) : [];
  paint(tok, `
    <article class="art">
      <div class="kicker">${esc(nav ? SECTIONS[nav].short : "")}${nav ? " · " : ""}${esc(it.source)}</div>
      <h1>${esc(it.title)}</h1>
      <div class="by">${it.author ? `By <b>${esc(it.author)}</b> · ` : ""}${esc(new Date(it.time).toLocaleString("en-US", { month:"short", day:"numeric", hour:"numeric", minute:"2-digit", timeZone:ETZ }))} ET · ${ago(it.time)}</div>
      ${pic ? img(pic, "hero") : ""}
      ${it.summary ? `<p class="sum">${esc(it.summary)}</p>` : `<p class="sum muted">No summary in ${esc(it.source)}'s feed. Open the full story below.</p>`}
      <div class="actions">
        <a class="btn primary" href="${esc(it.url)}" target="_blank" rel="noopener noreferrer">Read full story at ${esc(it.source)} ↗</a>
        <button class="btn ${isSaved(id) ? "on" : ""}" id="saveBtn">${isSaved(id) ? "Saved" : "Save"}</button>
      </div>
      <div class="note">Opens ${esc(it.source)}'s site. Some outlets need a subscription.</div>
    </article>
    ${others.length ? `<div class="h-sec"><h2>Also covering this</h2><span>${others.length} more</span></div>${others.map(o => `<a class="also" href="#/a/${esc(o.id)}"><div class="s">${esc(o.source)}</div><div class="t">${esc(o.title)}</div><div class="w">${ago(o.time)}</div></a>`).join("")}` : ""}
    ${more.length ? `<div class="h-sec"><h2>More in ${esc(SECTIONS[nav].short)}</h2><a href="#/s/${nav}">All ›</a></div>${more.map(k => storyRow(leadOf(k))).join("")}` : ""}`);
  const b = $("#saveBtn");
  if (b) b.onclick = () => { toggleSave(it); b.textContent = isSaved(id) ? "Saved" : "Save"; b.classList.toggle("on", isSaved(id)); };
}

async function viewSaved(){
  setChrome("saved", false);
  const tok = viewToken;
  await load(false).catch(() => {});
  paint(tok, `<div class="pagehead"><div class="kicker">Scoot News</div><h1>Saved</h1></div>
    ${saved.length ? saved.map(s => `<a class="story ${s.image ? "" : "noimg"}" href="#/a/${esc(s.id)}"><div><div class="tag">${esc(s.source)}</div><h3>${esc(s.title)}</h3><div class="when">Saved ${ago(s.savedAt)}</div></div>${img(s.image)}</a>`).join("")
      : `<div class="empty">Tap Save on any story to keep it here.</div>`}`);
}

async function viewSearch(){
  setChrome("search", false);
  const tok = viewToken; await load(false);
  paint(tok, `<div class="search"><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#121212" stroke-width="1.8"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 5 5"/></svg>
    <input id="q" type="search" placeholder="Search the news" autocomplete="off" value="${esc(store.get("sn-q", ""))}"></div><div id="res"></div>`);
  const q = $("#q"), res = $("#res");
  const run = () => {
    const v = q.value.trim().toLowerCase(); store.set("sn-q", q.value);
    if (v.length < 2){ res.innerHTML = `<div class="empty">Search headlines and summaries from the last 48 hours.</div>`; return; }
    const terms = v.split(/\s+/);
    const hits = NEWS.items.filter(i => { const t = (i.title + " " + i.summary + " " + i.source).toLowerCase(); return terms.every(x => t.includes(x)); })
      .sort((a, b) => b.time.localeCompare(a.time)).slice(0, 60);
    res.innerHTML = hits.length ? hits.map(i => storyRow(i)).join("") : `<div class="empty">No stories match "${esc(q.value)}".</div>`;
  };
  q.addEventListener("input", run); run();
  if (!q.value) q.focus();
}

/* ================= PULL TO REFRESH ================= */
(function(){
  const ind = document.createElement("div");
  ind.id = "ptr"; ind.innerHTML = `<span class="spin" style="margin:0"></span>`;
  document.body.appendChild(ind);
  let y0 = null, dy = 0, busy = false;
  window.addEventListener("touchstart", e => { if (window.scrollY <= 0 && !busy) { y0 = e.touches[0].clientY; dy = 0; } else y0 = null; }, { passive: true });
  window.addEventListener("touchmove", e => {
    if (y0 == null) return;
    dy = e.touches[0].clientY - y0;
    if (dy > 0){ ind.style.transform = `translate(-50%, ${Math.min(dy, 90) - 50}px)`; ind.style.opacity = Math.min(dy / 70, 1); }
  }, { passive: true });
  window.addEventListener("touchend", async () => {
    if (y0 == null) return;
    y0 = null;
    if (dy > 70 && current){
      busy = true;
      ind.style.transform = "translate(-50%, 30px)";
      try { await current(true); } catch (e){}
      busy = false;
    }
    ind.style.transform = "translate(-50%, -50px)"; ind.style.opacity = 0;
  });
})();

/* ---------------- boot ---------------- */
if (!location.hash) location.replace("#/home");
route();
