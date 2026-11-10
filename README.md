# Scoot News

Personal news app. The home page is the Morning Market Brief: market snapshot, top stories ranked by market impact, today's US economic calendar, earnings and a bottom line. It also has Markets, World, Tech and Politics tabs, search and saved stories.

The app is set up the same way as The Scoot: a static site on GitHub Pages.

## How it stays up to date
A GitHub Action (`.github/workflows/update.yml`) runs `scripts/build.py` about every 20 minutes. The script reads public RSS feeds, Yahoo Finance quotes, the Forex Factory calendar and the Nasdaq earnings calendar, then saves `data/news.json` and `data/brief.json`. The app reads those two files.

## Change things
- Sources: edit `FEEDS` in `scripts/build.py`
- Market tickers: edit `QUOTES` in `scripts/build.py`
- Look: `styles.css` uses the same colors and fonts as The Scoot
