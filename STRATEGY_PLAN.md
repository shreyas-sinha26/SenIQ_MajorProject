# SenIQ Strategies + MCP — Design (Phases 7 & 8)

Visual **strategy builder**, **backtesting**, and **paper trading** for US stocks + crypto
(+ India), where rules can mix **technical indicators** with **SenIQ signal factors**
(sentiment, smart-money, impact). Plus an **MCP server** exposing SenIQ signals + strategy tools
to agents. Reuses the existing **zeuniq Python engine** as a separate service.

> Status: **design + scaffold.** The sidebar has Strategy Builder / Your Strategies / Backtest /
> Paper Trade as placeholder pages; the engine service below is not built yet.

---

## Boundaries (firm)
- **In:** backtesting, paper trading (simulated fills, virtual money), live signals, visual
  builder, MCP — for **US equities + crypto** (India already works in zeuniq).
- **Out:** real-money / live execution. zeuniq's `live_strategy_runner` + Dhan execution + the
  "Deploy → it trades" whitelist **stay in zeuniq**. SenIQ extracts only the engine + backtest +
  paper subset.

## Architecture
```
 SenIQ frontend (visual builder, backtest/paper UI)
        │  emits Strategy JSON
        ▼
 SenIQ (Node/Express)  ──HTTP──►  Strategy Service (Python/FastAPI = zeuniq engine)
   • auth, tiers, UI                 • indicators (ema/rsi/macd/roc…)
   • MCP server (Phase 8)            • schema-driven evaluator → SIGNALS
   • signal tool layer  ◄──fetch──   • backtest loop + analytics
        │                            • paper OMS (sim fills, no broker)
        ▼                            • DataProvider abstraction (below)
  MCP clients (a user's Claude/agent)
```
- **Integration:** zeuniq engine runs as its **own service** (it already has FastAPI
  `routes/backtest.py` + `strategies.py`); SenIQ (Node) calls it over HTTP with a shared secret.
- **Reuse from zeuniq:** `engine/strategy/indicators.py`, `backtest_runner`, `strategy_validation`,
  the sim OMS/portfolio, and the `engine/data/*` `DataProvider` interface (already has
  `YFinanceProvider` + `DhanProvider`, env-switchable).

## Data adapters (locked 2026-06-30)
| Market | Live prices | Backtest / intraday | Notes |
|---|---|---|---|
| **Crypto** | CoinGecko (done, free) | Binance / CoinGecko OHLC | Already live in SenIQ. |
| **US stocks** | **Finnhub** (`FINNHUB_API_KEY`) | **Alpaca** or yfinance | Finnhub for real-time quotes; Alpaca later for intraday bars + paper. |
| **India** | **Dhan** (from zeuniq) | **yfinance** `.NS` / Dhan | Dhan = the only solid real-time NSE/BSE source; yfinance `.NS` free fallback (delayed). |
| **Commodities** | FMP (gold/metals); ~15-min via yfinance | **yfinance** futures (`GC=F`, `CL=F`…) | yfinance covers oil/gas that FMP free won't. |

## The strategy schema (the shared contract)
A strategy = **entry rules** + **exit rules**, each a comparison over a **factor**. Factors come
from two families, but are otherwise uniform:
- **`source: "technical"`** — computed by the engine from price/OHLC: `ema, sma, rsi, macd, roc,
  highest, lowest, price, volume`.
- **`source: "seniq"`** — fetched from the SenIQ engine via its tool layer / MCP: `sentiment_acute,
  sentiment_zscore, momentum, impact_score, event_type, smart_money_action, congress_action`.

```json
{
  "universe": ["NVDA"], "timeframe": "1d",
  "factors": [
    {"id":"ema_f","source":"technical","fn":"ema","params":{"period":20}},
    {"id":"ema_s","source":"technical","fn":"ema","params":{"period":50}},
    {"id":"rsi","source":"technical","fn":"rsi","params":{"period":14}},
    {"id":"senti_z","source":"seniq","metric":"sentiment_zscore"},
    {"id":"senti","source":"seniq","metric":"sentiment_acute"},
    {"id":"smart","source":"seniq","metric":"smart_money_action","window_days":7}
  ],
  "entry":{"all":[{"crossover":["ema_f","ema_s"]},{"gt":["senti_z",1.5]},{"eq":["smart","buy"]}]},
  "exit": {"any":[{"gt":["rsi",70]},{"lt":["senti",0.4]},{"stop_loss_pct":5}]},
  "sizing":{"type":"percent_equity","value":10}
}
```

## How a strategy runs (signals / backtest / paper)
```
Strategy JSON → Strategy Service:
  ├─ pull PRICE candles (Finnhub/yfinance/Binance) ──► compute technical factors
  ├─ pull SENIQ signals (SenIQ API/MCP tool layer) ──► sentiment/smart-money time series
  ├─ ALIGN both on the (date, ticker) timeline      (SenIQ rows are all timestamped:
  │                                                   article_sentiments, events,
  │                                                   event_portfolio_impact, congress_trades,
  │                                                   institution_holdings)
  └─ evaluate entry/exit rules each bar ──► buy/sell/hold + which conditions fired
```
- **Visual builder** (frontend) shows two factor palettes (Technicals + SenIQ Signals); the user
  drops both into rules → emits the schema above.
- **MCP server** is the signal-delivery bridge: internally it's how SenIQ signals get *into* the
  engine (`get_signal_history`); externally an agent calls the same tools to assemble + run the
  same schema.

## MCP tools (Phase 8)
`get_signal · get_signal_history · get_portfolio_sentiment · get_smart_money · create_strategy ·
backtest · run_strategy · list_strategies · paper_status`. Per-user API key, **Pro-gated**. Report
generation is never a free tool (existing cost guardrails).

## Honest caveat — backtest depth for SenIQ factors
- **Technical-only rules** backtest back **years** (deep price history).
- **SenIQ-signal rules** backtest only as far back as SenIQ has been **recording** — its
  sentiment/smart-money history is young and grows over time (this is the E3 outcome-logging
  dataset). Live signals + paper trading get full power immediately; the builder should **warn /
  limit the date range** when a SenIQ factor is used in a backtest.

## Tier gating (Phase 6)
Builder + backtest = **Plus+** · Paper trading = **Pro** · MCP / API = **Pro**.

## Phasing
- **Phase 7:** strategy service + data adapters + schema + signals + visual builder + backtest UI
  + paper trading.
- **Phase 8:** MCP server + per-user API keys; then Alpaca intraday.

## Open questions (resolve before coding)
1. Where the Python service lives + how we lift zeuniq's engine (vendored `strategy-service/`
   folder vs git submodule vs shared package) — extracting `engine/` + backtest + indicators +
   sim OMS, leaving live/Dhan behind.
2. Paper-trading state store: SenIQ Postgres vs the service's own DB.
3. Auth between SenIQ and the service (shared secret / mTLS).
4. Hosting: a second process — Phase 4 deploy implications (two services on Render).
5. The exact SenIQ signal-factor vocabulary + the `get_signal_history` contract (agree before the
   builder, engine, and MCP are written).
