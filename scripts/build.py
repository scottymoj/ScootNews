#!/usr/bin/env python3
"""Scoot News data builder.

Runs inside GitHub Actions every ~20 minutes. Pulls public RSS feeds,
market quotes, today's US economic calendar and earnings, then writes
data/news.json and data/brief.json for the web app to read.
Standard library only, so there is nothing to install.
"""
import html
import json
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from xml.etree import ElementTree as ET
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data"
ET_TZ = ZoneInfo("America/New_York")
NOW = datetime.now(timezone.utc)
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/130.0 Safari/537.36")

CNBC = "https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id="
DJ = "https://feeds.content.dowjones.io/public/rss/"
NYT = "https://rss.nytimes.com/services/xml/rss/nyt/"

# (section, source name, url)
FEEDS = [
    # Markets & business
    ("markets", "WSJ", DJ + "RSSMarketsMain"),
    ("markets", "MarketWatch", DJ + "mw_topstories"),
    ("markets", "MarketWatch", DJ + "mw_marketpulse"),
    ("markets", "CNBC", CNBC + "100003114"),
    ("markets", "CNBC", CNBC + "20910258"),
    ("markets", "CNBC", CNBC + "10001147"),
    ("markets", "NYT", NYT + "Business.xml"),
    ("markets", "BBC", "https://feeds.bbci.co.uk/news/business/rss.xml"),
    # US & world
    ("world", "NYT", NYT + "HomePage.xml"),
    ("world", "NYT", NYT + "World.xml"),
    ("world", "NYT", NYT + "US.xml"),
    ("world", "WSJ", DJ + "RSSWorldNews"),
    ("world", "BBC", "https://feeds.bbci.co.uk/news/world/rss.xml"),
    ("world", "BBC", "https://feeds.bbci.co.uk/news/world/us_and_canada/rss.xml"),
    ("world", "NPR", "https://feeds.npr.org/1001/rss.xml"),
    ("world", "Guardian", "https://www.theguardian.com/world/rss"),
    ("world", "CNBC", CNBC + "100727362"),
    # Tech & AI
    ("tech", "TechCrunch", "https://techcrunch.com/feed/"),
    ("tech", "The Verge", "https://www.theverge.com/rss/index.xml"),
    ("tech", "Ars Technica", "https://feeds.arstechnica.com/arstechnica/index"),
    ("tech", "NYT", NYT + "Technology.xml"),
    ("tech", "WSJ", DJ + "RSSWSJD"),
    ("tech", "CNBC", CNBC + "19854910"),
    ("tech", "MIT Tech Review", "https://www.technologyreview.com/feed/"),
    # Politics
    ("politics", "NYT", NYT + "Politics.xml"),
    ("politics", "NPR", "https://feeds.npr.org/1014/rss.xml"),
    ("politics", "Politico", "https://rss.politico.com/politics-news.xml"),
    ("politics", "The Hill", "https://thehill.com/homenews/feed/"),
    ("politics", "Fox News", "https://moxie.foxnews.com/google-publisher/politics.xml"),
    ("politics", "WSJ", DJ + "socialpoliticsfeed"),
    ("politics", "CNBC", CNBC + "10000113"),
]

# Big outlets win ties when picking which version of a story leads.
SOURCE_RANK = {s: i for i, s in enumerate([
    "WSJ", "NYT", "CNBC", "BBC", "NPR", "MarketWatch", "Politico", "The Hill",
    "Fox News", "Guardian", "TechCrunch", "The Verge", "Ars Technica",
    "MIT Tech Review", "Yahoo Finance"])}

QUOTES = [
    # (group, label, yahoo symbol, kind, cnbc symbol)
    ("futures", "S&P 500 fut", "ES=F", "idx", "@SP.1"),
    ("futures", "Dow fut", "YM=F", "idx", "@DJ.1"),
    ("futures", "Nasdaq fut", "NQ=F", "idx", "@ND.1"),
    ("us", "S&P 500", "^GSPC", "idx", ".SPX"),
    ("us", "Dow", "^DJI", "idx", ".DJI"),
    ("us", "Nasdaq", "^IXIC", "idx", ".IXIC"),
    ("us", "Russell 2000", "^RUT", "idx", ".RUT"),
    ("us", "VIX", "^VIX", "idx", ".VIX"),
    ("global", "Nikkei 225", "^N225", "idx", ".N225"),
    ("global", "Hang Seng", "^HSI", "idx", ".HSI"),
    ("global", "Shanghai", "000001.SS", "idx", ".SSEC"),
    ("global", "Stoxx 600", "^STOXX", "idx", ".STOXX"),
    ("global", "FTSE 100", "^FTSE", "idx", ".FTSE"),
    ("global", "DAX", "^GDAXI", "idx", ".GDAXI"),
    ("curve", "2-yr yield", "2YY=F", "yield", "US2Y"),
    ("curve", "10-yr yield", "^TNX", "yield", "US10Y"),
    ("curve", "30-yr yield", "^TYX", "yield", "US30Y"),
    ("fx", "Dollar index", "DX-Y.NYB", "idx", ".DXY"),
    ("fx", "Euro (EUR/USD)", "EURUSD=X", "fx", "EUR="),
    ("fx", "Yen (USD/JPY)", "JPY=X", "fx", "JPY="),
    ("fx", "Pound (GBP/USD)", "GBPUSD=X", "fx", "GBP="),
    ("fx", "Yuan (USD/CNY)", "CNY=X", "fx", "CNY="),
    ("macro", "WTI oil", "CL=F", "usd", "@CL.1"),
    ("macro", "Brent oil", "BZ=F", "usd", "@LCO.1"),
    ("macro", "Gold", "GC=F", "usd", "@GC.1"),
    ("macro", "Bitcoin", "BTC-USD", "usd", "BTC.CM="),
    ("macro", "Ether", "ETH-USD", "usd", "ETH.CM="),
    ("sectors", "Technology", "XLK", "etf", "XLK"),
    ("sectors", "Communication", "XLC", "etf", "XLC"),
    ("sectors", "Consumer discr.", "XLY", "etf", "XLY"),
    ("sectors", "Financials", "XLF", "etf", "XLF"),
    ("sectors", "Health care", "XLV", "etf", "XLV"),
    ("sectors", "Industrials", "XLI", "etf", "XLI"),
    ("sectors", "Energy", "XLE", "etf", "XLE"),
    ("sectors", "Materials", "XLB", "etf", "XLB"),
    ("sectors", "Consumer staples", "XLP", "etf", "XLP"),
    ("sectors", "Utilities", "XLU", "etf", "XLU"),
    ("sectors", "Real estate", "XLRE", "etf", "XLRE"),
]

DIAG = []  # error notes saved into brief.json so problems are easy to see


def note(msg):
    DIAG.append(msg[:160])
    print(msg, file=sys.stderr)


STOP = set("""a an the and or but of to in on at for from by with as is are was were be been
it its this that these those after before over under into about than then says say said
new will would could can may might not no yes up down out off how why what who when where
amid against more most less very just also first last year years week day today report
reports us u.s. news live update updates""".split())


def get(url, timeout=20, accept="*/*", extra=None):
    h = {"User-Agent": UA, "Accept": accept, "Accept-Language": "en-US,en;q=0.9"}
    h.update(extra or {})
    req = urllib.request.Request(url, headers=h)
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def clean(text, limit=None):
    if not text:
        return ""
    text = html.unescape(re.sub(r"<[^>]+>", " ", text))
    text = re.sub(r"\s+", " ", text).strip()
    if limit and len(text) > limit:
        cut = text[:limit].rsplit(" ", 1)[0]
        text = cut.rstrip(",;:-") + "…"
    return text


def parse_date(s):
    if not s:
        return None
    s = s.strip()
    try:
        d = parsedate_to_datetime(s)
    except (TypeError, ValueError):
        try:
            d = datetime.fromisoformat(s.replace("Z", "+00:00"))
        except ValueError:
            return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return d.astimezone(timezone.utc)


def local(tag):
    return tag.rsplit("}", 1)[-1].lower()


def find_image(el, desc_html):
    for c in el.iter():
        t = local(c.tag)
        if t in ("content", "thumbnail") and c.get("url"):
            if t == "content" and c.get("medium") not in (None, "image") and not re.search(
                    r"\.(jpe?g|png|webp)", c.get("url"), re.I):
                continue
            return c.get("url")
        if t == "enclosure" and (c.get("type") or "").startswith("image") and c.get("url"):
            return c.get("url")
    m = re.search(r'<img[^>]+src=["\']([^"\']+)', desc_html or "")
    return html.unescape(m.group(1)) if m else ""


def parse_feed(raw, section, source):
    root = ET.fromstring(raw)
    items = []
    entries = [e for e in root.iter() if local(e.tag) in ("item", "entry")]
    for e in entries:
        f = {}
        for c in e:
            t = local(c.tag)
            if t == "link":
                href = c.get("href")
                if href and c.get("rel", "alternate") == "alternate":
                    f.setdefault("link", href)
                elif c.text and c.text.strip():
                    f.setdefault("link", c.text.strip())
            elif t in ("title", "description", "summary", "encoded", "pubdate",
                       "published", "updated", "date", "creator", "name"):
                f.setdefault(t, "".join(c.itertext()))
            elif t == "author":
                f.setdefault("creator", "".join(c.itertext()))
        title = clean(f.get("title"))
        link = (f.get("link") or "").strip()
        if not title or not link.startswith("http"):
            continue
        desc_html = f.get("description") or f.get("summary") or f.get("encoded") or ""
        d = parse_date(f.get("pubdate") or f.get("published") or f.get("updated") or f.get("date"))
        if not d:
            continue
        summary = clean(desc_html, 320)
        if summary.lower().startswith(title.lower()[:40]):
            summary = summary[len(title):].strip(" -–—:") or summary
        items.append({
            "title": title,
            "url": link.split("#")[0],
            "source": source,
            "section": section,
            "time": d.isoformat().replace("+00:00", "Z"),
            "summary": summary,
            "image": find_image(e, desc_html),
            "author": clean(f.get("creator"), 80),
        })
    return items


def words(title):
    toks = re.findall(r"[a-z0-9$%][a-z0-9$%.'-]*", title.lower())
    out = set()
    for t in toks:
        t = t.strip(".'-")
        if len(t) < 3 or t in STOP:
            continue
        if t.endswith("s") and len(t) > 4:
            t = t[:-1]
        out.add(t)
    return out


def cluster(items):
    """Group headlines from different outlets about the same story."""
    clusters = []
    for it in sorted(items, key=lambda x: x["time"], reverse=True):
        w = words(it["title"] + " " + it["summary"][:120])
        it["_w"] = w
        best, score = None, 0.0
        for c in clusters:
            inter = len(w & c["w"])
            if inter < 3:
                continue
            s = inter / max(1, min(len(w), len(c["w"])))
            if s > score:
                best, score = c, s
        if best and score >= 0.42:
            best["items"].append(it)
            best["w"] |= w
        else:
            clusters.append({"w": set(w), "items": [it]})
    return clusters


def fetch_news():
    seen, items, status = {}, [], []
    for section, source, url in FEEDS:
        try:
            got = parse_feed(get(url, accept="application/rss+xml, application/xml, text/xml"),
                             section, source)
            status.append({"source": source, "section": section, "ok": True, "n": len(got)})
        except Exception as ex:  # one bad feed never breaks the build
            status.append({"source": source, "section": section, "ok": False, "err": str(ex)[:80]})
            print(f"feed failed: {source} {url}: {ex}", file=sys.stderr)
            continue
        for it in got[:30]:
            if NOW - datetime.fromisoformat(it["time"].replace("Z", "+00:00")) > timedelta(hours=48):
                continue
            key = re.sub(r"[?].*$", "", it["url"])
            if key in seen:
                prev = seen[key]
                if it["section"] not in prev["sections"]:
                    prev["sections"].append(it["section"])
                continue
            it["sections"] = [it.pop("section")]
            seen[key] = it
            items.append(it)

    clusters = cluster(items)
    out_items, out_clusters = [], []
    for ci, c in enumerate(clusters):
        group = sorted(c["items"], key=lambda x: (SOURCE_RANK.get(x["source"], 99),
                                                 0 if x["image"] else 1, x["time"]))
        lead = group[0]
        sources = sorted({x["source"] for x in group}, key=lambda s: SOURCE_RANK.get(s, 99))
        sections = sorted({s for x in group for s in x["sections"]})
        latest = max(x["time"] for x in group)
        cid = f"c{ci}"
        for x in group:
            x.pop("_w", None)
            x["cluster"] = cid
            x["id"] = re.sub(r"[^a-z0-9]", "", (x["source"] + x["title"]).lower())[:48]
            out_items.append(x)
        if not lead["image"]:
            lead_img = next((x["image"] for x in group if x["image"]), "")
        else:
            lead_img = lead["image"]
        out_clusters.append({
            "id": cid, "lead": lead["id"], "items": [x["id"] for x in group],
            "sources": sources, "sections": sections, "latest": latest, "image": lead_img,
        })
    return out_items, out_clusters, status


def yahoo(symbol):
    sym = urllib.parse.quote(symbol)
    last = None
    for host in ("query1", "query2"):
        try:
            raw = get(f"https://{host}.finance.yahoo.com/v8/finance/chart/{sym}?range=1d&interval=15m",
                      accept="application/json")
            meta = json.loads(raw)["chart"]["result"][0]["meta"]
            price = meta.get("regularMarketPrice")
            prev = meta.get("chartPreviousClose") or meta.get("previousClose")
            return price, prev, meta.get("regularMarketTime")
        except Exception as ex:
            last = ex
            time.sleep(1)
    raise last


def num(v):
    if v is None:
        return None
    t = re.sub(r"[^0-9.\-+]", "", str(v))
    try:
        return float(t)
    except ValueError:
        return None


def cnbc_quotes():
    syms = "|".join(q[4] for q in QUOTES)
    url = ("https://quote.cnbc.com/quote-html-webservice/restQuote/symbolType/symbol?symbols="
           + urllib.parse.quote(syms, safe="|") +
           "&requestMethod=itv&noform=1&partnerId=2&fund=1&exthrs=1&output=json&events=1")
    data = json.loads(get(url, accept="application/json"))
    res = data.get("FormattedQuoteResult", {}).get("FormattedQuote", [])
    if isinstance(res, dict):
        res = [res]
    return {r.get("symbol"): r for r in res}


def fetch_markets():
    rows, cq = [], {}
    try:
        cq = cnbc_quotes()
    except Exception as ex:
        note(f"cnbc quotes failed: {ex}")
    for group, label, sym, kind, csym in QUOTES:
        row = {"group": group, "label": label, "symbol": sym, "kind": kind}
        q = cq.get(csym)
        price = num(q.get("last")) if q else None
        if price is not None:
            prev = num(q.get("previous_day_closing"))
            chg = num(q.get("change"))
            if chg is None and prev:
                chg = price - prev
            if prev is None and chg is not None:
                prev = price - chg
            row["price"] = price
            row["src"] = "cnbc"
            if chg is not None and prev:
                row["chg"] = chg
                row["pct"] = chg / prev * 100
                if kind == "yield":
                    row["chg_bp"] = round(chg * 100, 1)
        else:
            try:
                price, prev, ts = yahoo(sym)
            except Exception as ex:
                note(f"quote failed {sym}/{csym}: {ex}")
                continue
            if price is None:
                continue
            row["price"] = price
            row["src"] = "yahoo"
            if prev:
                row["chg"] = price - prev
                row["pct"] = (price - prev) / prev * 100
                if kind == "yield":
                    row["chg_bp"] = round((price - prev) * 100, 1)
        rows.append(row)
    return rows


def fetch_calendar(today):
    try:
        data = json.loads(get("https://nfs.faireconomy.media/ff_calendar_thisweek.json",
                              accept="application/json"))
    except Exception as ex:
        note(f"calendar failed: {ex}")
        return None
    out = []
    for ev in data:
        if ev.get("country") != "USD":
            continue
        d = parse_date(ev.get("date"))
        if not d:
            continue
        dl = d.astimezone(ET_TZ)
        if dl.date() < today:
            continue
        all_day = dl.hour == 0 and dl.minute == 0
        out.append({
            "time": d.isoformat().replace("+00:00", "Z"), "allDay": all_day,
            "title": ev.get("title", ""), "impact": ev.get("impact", ""),
            "forecast": ev.get("forecast", ""), "previous": ev.get("previous", ""),
            "actual": ev.get("actual", ""),
            "day": dl.date().isoformat(),
        })
    out.sort(key=lambda x: x["time"])
    return out


def money(s):
    try:
        return float(re.sub(r"[^0-9.]", "", s or "") or 0)
    except ValueError:
        return 0.0


def fetch_earnings(today):
    try:
        data = json.loads(get(f"https://api.nasdaq.com/api/calendar/earnings?date={today.isoformat()}",
                              accept="application/json, text/plain, */*", timeout=25,
                              extra={"Origin": "https://www.nasdaq.com",
                                     "Referer": "https://www.nasdaq.com/"}))
        rows = (data.get("data") or {}).get("rows") or []
        if not rows:
            note(f"earnings: no rows (status {(data.get('status') or {}).get('rCode')})")
    except Exception as ex:
        note(f"earnings failed: {ex}")
        return None
    pre, post, other = [], [], []
    for r in sorted(rows, key=lambda r: money(r.get("marketCap")), reverse=True):
        e = {"symbol": r.get("symbol", ""), "name": clean(r.get("name"), 40),
             "eps": r.get("epsForecast", ""), "cap": money(r.get("marketCap"))}
        t = r.get("time", "")
        (pre if "pre" in t else post if "after" in t else other).append(e)
    return {"pre": pre[:10], "post": post[:10], "other": other[:6]}


def main():
    OUT.mkdir(exist_ok=True)
    today = NOW.astimezone(ET_TZ).date()
    items, clusters, status = fetch_news()
    if len(items) < 20:
        print(f"only {len(items)} articles, keeping the old data", file=sys.stderr)
        sys.exit(0)
    stamp = NOW.isoformat().replace("+00:00", "Z")
    (OUT / "news.json").write_text(json.dumps(
        {"updated": stamp, "items": items, "clusters": clusters, "feeds": status},
        ensure_ascii=False, separators=(",", ":")))

    old = {}
    try:
        old = json.loads((OUT / "brief.json").read_text())
    except Exception:
        pass
    markets = fetch_markets() or old.get("markets", [])
    cal = fetch_calendar(today)
    earn = fetch_earnings(today)
    if old.get("date") == today.isoformat():
        cal = cal if cal is not None else old.get("calendar")
        earn = earn if earn is not None else old.get("earnings")
    (OUT / "brief.json").write_text(json.dumps({
        "updated": stamp, "date": today.isoformat(), "markets": markets,
        "calendar": cal or [], "earnings": earn or {"pre": [], "post": [], "other": []},
        "diag": DIAG[:30],
    }, ensure_ascii=False, separators=(",", ":")))
    ok = sum(1 for s in status if s["ok"])
    print(f"{len(items)} articles, {len(clusters)} stories, {ok}/{len(status)} feeds, "
          f"{len(markets)} quotes, {len(cal or [])} calendar events")


if __name__ == "__main__":
    main()
