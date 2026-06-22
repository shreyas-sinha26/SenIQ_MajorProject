#!/usr/bin/env python3
"""Generate the SenIQ product roadmap PDF (scripts/build_roadmap_pdf.py)."""

from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import getSampleStyleSheet, ParagraphStyle
from reportlab.lib.units import mm
from reportlab.platypus import (
    SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle, HRFlowable, KeepTogether,
)

OUT = "SenIQ_Roadmap.pdf"

# ── Palette (matches the app's indigo/cyan theme) ──
INDIGO = colors.HexColor("#6366f1")
CYAN = colors.HexColor("#06b6d4")
INK = colors.HexColor("#1e293b")
MUTED = colors.HexColor("#64748b")
GREEN = colors.HexColor("#10b981")
LIGHT = colors.HexColor("#eef2ff")
ROW = colors.HexColor("#f8fafc")

styles = getSampleStyleSheet()
H1 = ParagraphStyle("H1", parent=styles["Title"], textColor=INDIGO, fontSize=26, spaceAfter=2, leading=30)
SUB = ParagraphStyle("SUB", parent=styles["Normal"], textColor=MUTED, fontSize=10.5, spaceAfter=2)
H2 = ParagraphStyle("H2", parent=styles["Heading2"], textColor=INK, fontSize=15, spaceBefore=14, spaceAfter=6, leading=18)
PHASE = ParagraphStyle("PHASE", parent=styles["Heading3"], textColor=INDIGO, fontSize=12.5, spaceBefore=12, spaceAfter=2, leading=15)
BODY = ParagraphStyle("BODY", parent=styles["Normal"], fontSize=9.8, leading=14, textColor=INK, spaceAfter=2, alignment=TA_LEFT)
BULLET = ParagraphStyle("BULLET", parent=BODY, leftIndent=12, bulletIndent=2, spaceAfter=1.5)
DONEW = ParagraphStyle("DONEW", parent=BODY, textColor=MUTED, fontSize=9, leftIndent=12, spaceAfter=8)
SMALL = ParagraphStyle("SMALL", parent=styles["Normal"], fontSize=8.5, textColor=MUTED, leading=11)
CELL = ParagraphStyle("CELL", parent=styles["Normal"], fontSize=9, leading=12, textColor=INK)
CELLB = ParagraphStyle("CELLB", parent=CELL, fontName="Helvetica-Bold")


def b(text):
    return Paragraph(f"•&nbsp;&nbsp;{text}", BULLET)


def done(text):
    return Paragraph(f"<b>Done when:</b> {text}", DONEW)


def rule():
    return HRFlowable(width="100%", thickness=0.6, color=colors.HexColor("#e2e8f0"), spaceBefore=4, spaceAfter=6)


story = []

# ── Header ──
story.append(Paragraph("SenIQ — Product Roadmap", H1))
story.append(Paragraph("Sentiment-driven market intelligence • Budget stance: cheapest-viable • Updated 2026-06-20", SUB))
story.append(HRFlowable(width="100%", thickness=2, color=CYAN, spaceBefore=6, spaceAfter=10))

story.append(Paragraph(
    "This roadmap supersedes the phase ordering in <font name='Helvetica-Oblique'>PLAN.md</font>. "
    "The original plan built every feature on localhost and deferred hosting. Two launch blockers — "
    "<b>OAuth sign-in</b> and <b>Stripe/Razorpay billing</b> — both require a public domain over HTTPS "
    "(for OAuth callback URLs and payment webhooks). So <b>Cloud Deployment + Domain</b> is pulled to the "
    "front of the remaining work; OAuth and billing follow once the public surface exists.", BODY))

# ── Section 1: Completed ──
story.append(Paragraph("Where we are today", H2))
story.append(Paragraph("Phases 0 through 3.5 are built and verified end-to-end on Postgres.", BODY))
story.append(Spacer(1, 4))

done_rows = [
    [Paragraph("Phase", CELLB), Paragraph("Scope", CELLB), Paragraph("Status", CELLB)],
    [Paragraph("0 · Foundations", CELL), Paragraph("Postgres + migration runner, config/feature-flag layer, global disclaimer", CELL), Paragraph("Done", CELLB)],
    [Paragraph("1 · Multi-asset portfolio", CELL), Paragraph("Equity / crypto / commodity, per-holding quantity → exposure weights", CELL), Paragraph("Done", CELLB)],
    [Paragraph("2 · Sentiment engine v2", CELL), Paragraph("Decay/momentum/90-day z-score, multi-source ingest, FinBERT, Portfolio Impact Scoring (North Star)", CELL), Paragraph("Done", CELLB)],
    [Paragraph("3 · Smart money", CELL), Paragraph("13F via SEC EDGAR + Congress trades, follows, signed outbound webhooks", CELL), Paragraph("Done", CELLB)],
    [Paragraph("3.5 · News relevance & de-spam", CELL), Paragraph("3-bucket feed (holdings/market/world), event clustering, materiality alerts, top-level tab UI", CELL), Paragraph("Done", CELLB)],
]
t = Table(done_rows, colWidths=[42*mm, 105*mm, 18*mm])
t.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (-1, 0), INDIGO),
    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
    ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, ROW]),
    ("TEXTCOLOR", (2, 1), (2, -1), GREEN),
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ("TOPPADDING", (0, 0), (-1, -1), 5),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ("LEFTPADDING", (0, 0), (-1, -1), 7),
    ("LINEBELOW", (0, 0), (-1, 0), 0.5, INDIGO),
    ("GRID", (0, 1), (-1, -1), 0.4, colors.HexColor("#e2e8f0")),
]))
story.append(t)

# ── Section 2: Remaining phases ──
story.append(Paragraph("The road ahead", H2))


def phase(num, title, tag, goal, bullets, done_text, kickoff=None):
    blk = [Paragraph(f"Phase {num} — {title} &nbsp; <font size=8 color='#06b6d4'>[{tag}]</font>", PHASE),
           Paragraph(f"<b>Goal:</b> {goal}", BODY)]
    for x in bullets:
        blk.append(b(x))
    if kickoff:
        blk.append(Paragraph(f"<b>Kickoff Qs:</b> {kickoff}", DONEW))
    blk.append(done(done_text))
    blk.append(rule())
    story.append(KeepTogether(blk))


phase(
    "4", "Cloud Deployment, Domain & HTTPS", "NEW · do first · unblocks 5 & 6",
    "Take SenIQ off localhost onto a public, always-on, TLS-secured host so the cron pipeline runs 24/7 and OAuth/Stripe callbacks have a real URL.",
    [
        "<b>Hosting:</b> deploy to a managed PaaS (recommend <b>Render</b> or <b>Fly.io</b> — cheapest-viable, auto-TLS, built-in cron/worker support). Web service for Express + the in-process node-cron pipeline.",
        "<b>Managed Postgres:</b> move off the local <font name='Courier'>seniq</font> DB to a managed instance (Render PG / Neon / Supabase). Keep the <font name='Courier'>DATABASE_URL</font> contract; migrations already run on boot.",
        "<b>Domain name:</b> register a domain (e.g. <font name='Courier'>seniq.app</font> / <font name='Courier'>getseniq.com</font> via Cloudflare or Namecheap) and point DNS at the host.",
        "<b>HTTPS/TLS:</b> automatic certs from the host (or Cloudflare proxy); force HTTPS + HSTS.",
        "<b>Secrets:</b> move <font name='Courier'>.env</font> into host environment variables (JWT secret, Finnhub, Reddit, SEC UA, congress URL, and later Stripe/OAuth keys). Rotate the JWT secret for production.",
        "<b>CI/CD:</b> auto-deploy on push to <font name='Courier'>main</font>; run migrations on deploy.",
        "<b>Ops baseline:</b> health-check endpoint, structured logs, error monitoring (free Sentry tier), and automated DB backups.",
    ],
    "the app is reachable at https://&lt;domain&gt; over TLS, migrations apply on deploy, and the news + smart-money cron jobs run in the cloud.",
    kickoff="Render vs Fly vs VPS? Which domain to register + registrar? Managed PG provider? Keep cron in-process or split a worker dyno?",
)

phase(
    "5", "Auth & Accounts — OAuth", "NEW",
    "Add social sign-in beside the existing email/password so users onboard in one click; depends on the public HTTPS domain from Phase 4 for callback URLs.",
    [
        "<b>OAuth providers:</b> Google first (highest conversion), GitHub optional. Use Authorization Code flow; callback at <font name='Courier'>https://&lt;domain&gt;/api/auth/oauth/&lt;provider&gt;/callback</font>.",
        "<b>Account model:</b> link an OAuth identity to a user row by verified email so password + Google land on the same account; store provider + provider_id.",
        "<b>Email flows:</b> email verification on signup + password reset (needs the email provider — see cross-cutting).",
        "<b>Hardening:</b> production JWT secret, sensible token expiry, optional refresh tokens, rate-limit auth endpoints.",
    ],
    "a user can sign in with Google and land directly in their portfolio, and email/password accounts can reset their password.",
    kickoff="Which providers at launch (Google only, or + GitHub/Apple)? Require email verification before use? Refresh tokens now or later?",
)

phase(
    "6", "Tiers & Billing (Free / Plus / Pro)", "was Phase 4",
    "Monetize via feature gating + payments, with hard cost guardrails on the Claude-backed reports. Needs the public HTTPS domain (Phase 4) for payment webhooks.",
    [
        "<b>Gating:</b> add <font name='Courier'>subscription_tier</font> to users + middleware; this finally enforces the smart-money split (Free teaser / Plus full / Pro webhooks) left open since Phase 3.",
        "<b>Payments:</b> Stripe (US) + Razorpay (India); webhook endpoints for tier changes. Region-gate by card BIN, not IP.",
        "<b>Pricing (decided):</b> Plus $9/mo (₹399), Pro $24/mo (₹999); annual ≈ 2 months free. Claude COGS is USD-fixed, so India can be cheaper but never below cost.",
        "<b>Claude cost guardrails (non-negotiable):</b> reports are server-scheduled only (no on-demand button); per-user daily quota; hard per-call token caps; global daily spend kill-switch; degrade to local Ollama past budget; log every call.",
    ],
    "gating returns an upsell for lower tiers, Stripe/Razorpay upgrades flip the tier via webhook, and the global kill-switch trips correctly in testing.",
    kickoff="Final prices + annual discount confirmed? Stripe + Razorpay accounts ready? Global daily kill-switch $ ceiling?",
)

phase(
    "7", "Strategies Tab", "was Phase 5",
    "Present 3–5 well-known sentiment strategies as education (not signals) with live applicability to the user's current holdings. No backtesting here (that lives in the separate project).",
    [
        "Describe each approach + logic: sentiment-momentum, sentiment-reversal (fade extremes), news-volume spike, smart-money follow, macro-risk-off overlay.",
        "<b>Live applicability:</b> show which of the user's current holdings each strategy flags right now from today's sentiment / z-score / impact data.",
        "Educational disclaimers throughout; link out to the user's backtesting project for historical performance.",
    ],
    "each strategy shows a description, its logic, and a live 'what it flags in your portfolio today' view.",
)

phase(
    "8", "API / MCP Server", "was Phase 6",
    "Expose the platform as a clean REST API and an MCP server the agent consumes, so the UI and the agent share one tool layer.",
    [
        "REST API keyed by tier: portfolio sentiment, smart-money, alerts, strategies.",
        "<b>MCP server</b> wrapping the same tools (get_portfolio_sentiment, get_smart_money, get_alerts, run_strategy) for any MCP agent.",
        "Per-key auth + rate limits; report generation is never a free-call tool (hits the same per-user quota).",
    ],
    "an external MCP client can authenticate and pull a user's full sentiment + smart-money picture.",
)

phase(
    "9", "Agent — Daily Report + Alerts", "was Phase 7",
    "Personalized, well-reasoned daily PDF report led by portfolio impact, plus instant alerts. The materiality alert engine already shipped in Phase 3.5 — this phase adds Claude narrative + delivery.",
    [
        "<b>Scheduled report:</b> reuse the ReportLab report builder; feed per-user sentiment + impact + smart-money context; generate prose with the <b>Claude API</b> (Ollama as dev/fallback). Cadence: Plus 1×/day, Pro 2×/day.",
        "<b>Lead with the North Star:</b> open with today's most important event + its % portfolio exposure.",
        "<b>Grounding, not model choice:</b> every claim cites a number (z-score, exposure %, smart-money fact).",
        "<b>Delivery:</b> email the report + real-time alerts (alert materiality + dedupe already built in 3.5); Pro gets Claude narrative within quota.",
    ],
    "a Plus user gets a daily portfolio-grounded PDF (Pro also an intraday one) and a major event pages them within minutes — all inside the Phase 6 quota/cost guardrails.",
)

# ── Section 3: Sequencing ──
story.append(Paragraph("Sequencing & dependencies", H2))
story.append(Paragraph(
    "<b>4 → (5, 6) → 7 → 8 → 9.</b> &nbsp; Deploy + domain + HTTPS (4) come first because both OAuth (5) "
    "and billing (6) need public callback/webhook URLs. 5 and 6 can run in parallel once 4 lands. "
    "Strategies (7), API/MCP (8) and the Agent (9) are feature work on top of a live, paid platform.", BODY))
story.append(Spacer(1, 6))

seq = [
    [Paragraph("Now", CELLB), Paragraph("Next", CELLB), Paragraph("Then", CELLB), Paragraph("Later", CELLB)],
    [Paragraph("Phase 4<br/>Deploy · Domain · HTTPS", CELL),
     Paragraph("Phase 5 · OAuth<br/>Phase 6 · Billing", CELL),
     Paragraph("Phase 7 · Strategies", CELL),
     Paragraph("Phase 8 · API/MCP<br/>Phase 9 · Agent", CELL)],
]
ts = Table(seq, colWidths=[None, None, None, None])
ts.setStyle(TableStyle([
    ("BACKGROUND", (0, 0), (0, 0), INDIGO),
    ("BACKGROUND", (1, 0), (1, 0), colors.HexColor("#818cf8")),
    ("BACKGROUND", (2, 0), (2, 0), colors.HexColor("#a5b4fc")),
    ("BACKGROUND", (3, 0), (3, 0), colors.HexColor("#c7d2fe")),
    ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
    ("BACKGROUND", (0, 1), (-1, 1), LIGHT),
    ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ("ALIGN", (0, 0), (-1, -1), "CENTER"),
    ("TOPPADDING", (0, 0), (-1, -1), 7),
    ("BOTTOMPADDING", (0, 0), (-1, -1), 7),
    ("GRID", (0, 0), (-1, -1), 0.5, colors.white),
]))
story.append(ts)

# ── Section 4: Cross-cutting ──
story.append(Paragraph("Cross-cutting (runs alongside the phases)", H2))
for x in [
    "<b>Email provider:</b> Resend or AWS SES — powers verification, password reset (Phase 5), alerts + daily reports (Phase 9).",
    "<b>Monitoring & backups:</b> error tracking, uptime checks, automated Postgres backups (stand up in Phase 4, maintain after).",
    "<b>Legal:</b> the 'informational, not investment advice' disclaimer is live; add Terms + Privacy before billing (Phase 6).",
    "<b>Open data gap:</b> live Congress data still runs on the bundled sample until a free source URL is set (CONGRESS_TRADES_URL) or a paid feed is chosen.",
]:
    story.append(b(x))

story.append(Spacer(1, 10))
story.append(HRFlowable(width="100%", thickness=1, color=CYAN, spaceBefore=4, spaceAfter=4))
story.append(Paragraph(
    "SenIQ is informational, not investment advice. Built on the ai-portfolio-copilot codebase. "
    "Roadmap doc generated 2026-06-20.", SMALL))


def footer(canvas, doc):
    canvas.saveState()
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(MUTED)
    canvas.drawString(18 * mm, 12 * mm, "SenIQ — Product Roadmap")
    canvas.drawRightString(192 * mm, 12 * mm, f"Page {doc.page}")
    canvas.restoreState()


doc = SimpleDocTemplate(
    OUT, pagesize=A4,
    leftMargin=18 * mm, rightMargin=18 * mm, topMargin=16 * mm, bottomMargin=18 * mm,
    title="SenIQ Product Roadmap", author="SenIQ",
)
doc.build(story, onFirstPage=footer, onLaterPages=footer)
print(f"wrote {OUT}")
