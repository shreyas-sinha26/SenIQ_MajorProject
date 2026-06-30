# SenIQ — IPO & Small/Mid-Cap Sentiment Optimization (plan)

## The thesis
Sentiment has the **most predictive power on small, new, and recently-listed companies** — they
have little analyst coverage, thin liquidity, sparse history, and heavy retail participation, so
price moves on *expectations* (news, hype, demand) far more than on fundamentals. IPOs are the
extreme case: no earnings history, so price ≈ sentiment at first.

**Why this fits SenIQ:** the existing edge (13F + congress tracking) is a **large-cap** game —
institutions and politicians trade big names. That coverage is *blind* to small-caps and IPOs.
SenIQ's **sentiment engine** is exactly the tool for that blind spot. So the positioning becomes:
**big-money signals for the giants, sentiment + IPO intelligence for the small and new ones.**

> Status: **plan only.** Nothing below is built yet. Ordered by leverage (cheap/reuses-data first).

---

## Change 1 — Size-aware sentiment  *(highest leverage; reuses existing data)*
Today the impact score treats a sentiment delta the same for Reliance and a ₹2,000cr small-cap.
Add a **sentiment-sensitivity multiplier** so the same sentiment moves the score *more* for
small/uncovered/new names:
- inputs: market cap (smaller → higher), liquidity / avg volume (thinner → higher), news/analyst
  coverage density (lower → higher), age since listing (newer → higher).
- mechanically: one new factor in `impactScoring.js` (6-factor → add a `sensitivity` term). No new
  data needed.
- **Effect:** SenIQ now "knows" a hype spike on a tiny name matters more than on a mega-cap — the
  core research finding, implemented directly.

## Change 2 — Composite "Signal Score" (0–100)  *(reuses existing data)*
Blend SenIQ's existing pipelines into **one number per ticker** (e.g. "NVDA 84/100 bullish"):

| Signal | Have it? |
|---|---|
| News sentiment | ✅ engine |
| Social sentiment | ✅ Reddit (X later) |
| Institutional (13F) | ✅ EDGAR |
| Congress / insider | ✅ FMP |
| Analyst upgrades | ⚠️ needs a source (Finnhub has some) |
| Options activity | ❌ no source (skip v1) |

- **Size-adjusted weights:** up-weight news/social for small caps, down-weight for efficient
  large caps. Start with sensible fixed weights; make them **learnable later** (Change 5).
- Better than a generic blend because it includes **congress + 13F**, which most sentiment scores
  lack.
- Becomes a **first-class signal factor in the strategy builder** ("enter when Signal Score > 75")
  — this feature and the strategy engine reinforce each other.

## Change 3 — IPO Radar  *(the new, differentiated surface; new data)*
A dedicated tab for **upcoming + recently-listed** IPOs, tracked across the lifecycle
(pre-listing → listing day → momentum → fundamental convergence):
- **India:** Grey Market Premium (GMP), subscription ratios (Retail / HNI / QIB), anchor-investor
  quality, issue size, promoter holding.
- **US:** no GMP — instead S-1 data, offer price/range, lock-up expiry, first-day pop, underwriter
  quality.
- plus the **sentiment burst** around listing and a short-horizon **listing-gain estimate**.
- **Honest data note:** GMP + subscription data is mostly **unofficial / scraped and India-centric**
  (Chittorgarh / IPO-Watch style sources; NSE/BSE for subscription). US IPO data is a different
  shape. So this module is somewhat market-specific and the **data layer is the real work** — start
  **India-first** (richest concept + data), then add US.

## Change 4 — Auto-monitor new listings from announcement
The moment an IPO / new company is announced, **auto-add it to the monitored universe** so its
sentiment history starts accumulating *before* it lists. (Ties to the universe-wide signal-recording
decision.) By listing day you already have the full pre-listing hype arc — the exact window the
research says predicts the pop.

## Change 5 — Outcome logging → listing-gain predictor  *(v2; needs data first)*
The listing-day / 1-week / 1-month return model is real but **can't be trained on day one** (no
labeled outcomes). Like the E3 outcome-logging design: **log every IPO's features + actual returns
now**; after a few dozen IPOs, train a simple, explainable model (gradient boosting / logistic
regression). Features: offer price, issue size, market cap, promoter holding, anchor allocation,
subscription ratios, GMP, news/social sentiment, article count, sector momentum, Nifty/VIX, FII/DII
flows. Targets: listing-day / 1w / 1m / 3m return, P(beat benchmark). **Build the logging now; the
model rides on the accumulated data.**

---

## Honest constraints (design around these)
1. **IPO data sourcing** (GMP/subscription) is the hard, scrape-heavy, India-leaning part — the
   biggest unknown.
2. **Free small-cap news is thin** — *except* around the IPO event itself, which is fortunately the
   moment that matters, so the signal is there when needed.
3. **Horizon honesty:** sentiment predicts the *short-term* pop; fundamentals dominate long-term
   (many IPOs give back early gains). Label IPO signals as short-horizon, keep the **informational,
   not advice** frame — retail gets hurt here most.

## Sequencing
1. **Now (cheap, reuses data):** Change 1 (size-aware sentiment) + Change 2 (Signal Score).
2. **Next (new data):** Change 3 IPO Radar — **India first**, then US.
3. **Alongside:** Change 4 (auto-add IPOs to the universe) + start IPO outcome logging.
4. **v2:** Change 5 (train the listing-gain predictor) once the logged dataset is real.

## Ties into existing plans
- `impactScoring.js` 6-factor model (Change 1 adds a sensitivity term).
- `STRATEGY_PLAN.md` — the Signal Score is a SenIQ signal factor for the builder/MCP.
- Universe expansion (S&P 500 + Nifty 100 + curated small/mid + auto-added IPOs) — Change 3/4 need it.
- E3 outcome logging — the pattern Change 5 reuses.
