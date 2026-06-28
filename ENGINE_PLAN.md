# SenIQ Intelligence Engine — Build Plan (v1)

**Owner:** the engine, alerts, and reporting are built and owned here.
**Goal:** a personal market analyst for each user — watches the companies they own, works out what
is genuinely important *to them*, pings them only for the big stuff, and writes it up like a human.

**Two principles, held the whole way:**
1. **Explainable** — we can always say *why* something was flagged (no black boxes).
2. **Log everything from day one** — so the system can learn from real outcomes later via *supervised*
   tuning. **No reinforcement learning** (wrong tool: no data on day one, unexplainable, and risky to
   optimize "engagement" in a finance product).

This plan is the engine track. It runs alongside the product roadmap (`SenIQ_Roadmap.pdf`) but is its
own thing. Phases 2 + 3.5 already built parts of this; the phases below deepen and reorganize the
engine around a **persistent Event** as the unit of analysis.

---

## Keystone: an Event is a first-class, remembered thing
Today a "story" is recomputed every cron run (`cluster_key` is per-batch). The whole vision —
"operate on events not articles", "what changed since yesterday", opportunity radar — needs a
**durable Event**: its own id, type, severity, source list, first-seen/last-seen. Articles attach to
events. Everything below assumes this.

---

## Phase E1 — Event foundation + entity resolution
- **Curated company reference** (a table, not a graph): per company — names/aliases, ticker, **sector**,
  exchange, country, asset class, and a few **key executives**. Seeded for a capped universe:
  **~US 100 / India 50 (Nifty) / crypto ~25.** Holdings *outside* the list still work on basic
  name/symbol matching — they just don't get sector/exec enrichment. Universe grows over time.
- **Entity resolution** replaces the brittle substring matcher (fixes bugs like "Bitcoin" → `COIN`):
  resolves company names, **executive names → their company**, and **sector mentions → holdings in that
  sector**.
- **Persistent events:** promote per-batch clusters to a durable `events` table; articles attach to
  events across runs (a duplicate tomorrow joins the same event, not a new one).
- **Done when:** the same story across sources and across runs collapses into one durable event, and a
  sector headline with no company named maps to the holdings it affects.

## Phase E2 — Event typing + the 6-factor impact score
- **Event typing:** label each event — earnings, guidance, legal/regulatory, M&A, executive change,
  insider/smart-money, product launch, operational disruption, macro. (Rule-based first.)
- **6-factor impact** (up from today's 3): **exposure** × **relevance** (direct / sector / macro) ×
  **severity** (event type) × **novelty** (z-surprise + event first-seen) × **confidence** ×
  **recency**. Each factor defined precisely to avoid double-counting.
- **Done when:** every event has a type and a per-user 6-factor impact score; sector events touch
  sector holdings.

## Phase E3 — Alerts that respect the user
- **Materiality + budgets:** fire only above the bar **and** cap noise — max alerts/user/day,
  per-holding rate limit, quiet hours, digest fallback for the rest.
- **Outcome logging:** for every event/alert, record features + open/dismiss + whether price moved
  materially in 1–3 days (computed automatically from prices we already pull). This is the dataset for
  future learning — it builds itself in production.
- **Done when:** a volatile day can't spam anyone, and every alert is logged with outcome fields.

## Phase E4 — Adding a holding feels smart
- On add: silent **historical backfill** (no alerts for old news), a short **company brief**, and a
  **"monitoring since" watermark** so only post-add events can alert.
- **Done when:** adding a stock gives an instant brief + recent context and never pings about old news.

## Phase E5 — The analyst voice (daily report + alert write-ups)
- **Grounding contract:** the engine emits a clean structured packet per user — top events by impact,
  **what changed since yesterday** (the diff is the *engine's* job), scores, smart-money context.
- **Daily brief** written by Claude, led by what changed + the single most important thing for the
  portfolio; human-readable **alert narratives** for big events.
- Cost guardrails: server-scheduled only, per-user daily quota, hard token caps, global kill-switch.
- **Done when:** a user gets a daily brief grounded entirely in their own holdings + readable alerts.

## Phase E6 — Ask it anything
- Natural-language portfolio questions ("Why is my portfolio down?", "Which holdings are improving?",
  "What's my biggest risk?") answered by Claude, grounded strictly on engine data.
- **Done when:** a user can ask in plain English and get grounded, cited answers.

---

## Testing — live refinement, no historical dataset
Two layers, because "does the code work" and "does it make good decisions" are different questions.

1. **Offline logic tests (no market data):** the deterministic pieces (entity resolution, clustering,
   event typing, the 6-factor math) are pure functions, tested on a dozen hand-written fixtures in CI.
   Proves the code does what we said.
2. **Live judgment loop (in production):**
   - **Canary portfolios** (US mega-caps / Indian large-caps / crypto / mixed) we review daily.
   - **Labels arrive on their own:** outcome logging (E3) records price-moves (auto, from prices we
     pull) + open/dismiss. After a few weeks we *have* a real dataset, built for free.
   - **Auto-metrics, no labeling:** events/day, alerts/day per user, % filtered as noise, avg cluster
     size (dedup health), open-vs-dismiss rate.
   - **Tune via config, not redeploys:** all thresholds live in `config.js`.
   - **Replay over stored data:** scoring is compute-on-read, so after a tuning change we re-run new
     scoring over the last N days already in the DB — the production DB is the test corpus as it fills.
   - **Failures → permanent tests:** each real mistake we spot becomes one regression fixture.

   Launch with conservative thresholds → watch canaries + metrics → tune config → lock regressions.

---

## v2 scope (what v1's foundation + logged data unlock)
1. **Learned relevance model** — train a simple, explainable model (logistic regression / gradient
   boosting) on accumulated outcomes to tune weights/thresholds; begin light per-user personalization.
   Still supervised, still no RL.
2. **Opportunity Radar** — reversals, smart-money accumulation, sector rotation, event-driven setups
   (surfaces ideas to watch, never advice). Built on E2's typed events.
3. **Grow the universe** — well past the v1 cap (more US, Indian mid/small caps, more crypto, other markets).
4. **Deeper graph (the real moat)** — supplier / customer / competitor links → second-order events
   ("a key supplier had a fire") map back to a holding.
5. **Richer sources** — X/Twitter (deferred), earnings-call transcripts, more primary/regulatory feeds.
6. **More proactive cadence** — intraday reports (Pro), sector-concentration insights, watchlists.

**Throughline:** v1 makes the analyst *correct and trustworthy* on a focused universe; v2 makes it
*smarter, broader, and personalized* using the data v1 quietly collected.

---

## Build order
E1 → E2 → E3 → E4 → E5 → E6. E1 is the keystone; alerts (E3) and onboarding (E4) need E2's scores;
report + Q&A (E5, E6) come last because a great report on shaky judgment is worthless.
