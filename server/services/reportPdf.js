/**
 * The report as a PDF — what a report email carries (services/reportEmails.js).
 *
 * One layout for both reports, drawn with pdfkit from the same data the app shows:
 *   header band → verdict → figures at a glance → headline cards (why it matters, how it
 *   affects the portfolio, how sure we are) → why the portfolio moved → price and news
 *   pulling apart → concentration → what changed → holdings → smart money → how earlier
 *   readings held up → disclaimer + page numbers.
 * The explaining sections come from report.insights (reportInsights.js); without it the
 * report falls back to the most important event and a ranked events table.
 * Sections with nothing to show are left out. No I/O beyond reading the bundled Inter
 * fonts (embedded, so ₹ and other non-Latin-1 characters in headlines print correctly).
 *
 * buildReportPdf(report) → Promise<Buffer>
 *   report = { kind:'daily'|'weekly', name, dateLabel, marketLabel, headline, narrative, writer,
 *              events:[{title, source, last_seen, exposure_pct, direction, impact_score}],
 *              moreEvents, holdings:[{ticker, name, exposure_pct, sentiment_label,
 *              sentiment_acute, z}], changed:{has_prior, new_events, sentiment_swings},
 *              smartMoney:{congress, institutions}, alertCount, note,
 *              insights: reportInsights.buildReportInsights() | null }
 */

const path = require('path');
const PDFDocument = require('pdfkit');
const { DISCLAIMER } = require('../config');

const FONT_DIR = path.dirname(require.resolve('@expo-google-fonts/inter/package.json'));
const FONTS = {
  regular: path.join(FONT_DIR, '400Regular', 'Inter_400Regular.ttf'),
  medium: path.join(FONT_DIR, '500Medium', 'Inter_500Medium.ttf'),
  semibold: path.join(FONT_DIR, '600SemiBold', 'Inter_600SemiBold.ttf'),
  bold: path.join(FONT_DIR, '700Bold', 'Inter_700Bold.ttf'),
};

// The app's light theme (public/css/style.css): navy ink on white, one blue accent.
const C = {
  navy: '#0A2540', blue: '#1E40AF', ink: '#0F172A', text: '#334155', muted: '#64748B',
  faint: '#94A3B8', line: '#E2E8F0', panel: '#F8FAFC', white: '#FFFFFF',
  positive: '#15803D', positiveBg: '#DCFCE7', negative: '#B91C1C', negativeBg: '#FEE2E2',
  neutral: '#475569', neutralBg: '#E2E8F0', accentBg: '#DBEAFE',
};
const TONE = {
  positive: { fg: C.positive, bg: C.positiveBg, word: 'Positive' },
  negative: { fg: C.negative, bg: C.negativeBg, word: 'Negative' },
  neutral: { fg: C.neutral, bg: C.neutralBg, word: 'Mixed' },
};
const tone = (label) => TONE[label] || TONE.neutral;

const PAGE = { width: 595.28, height: 841.89, margin: 44, footer: 46 };
const CONTENT_W = PAGE.width - PAGE.margin * 2;
const BOTTOM = PAGE.height - PAGE.footer - 14;
// Below this many graded readings a hit rate is noise, so the count is shown instead.
const MIN_GRADED_READINGS = 20;

// ── Pure formatters ──
const clean = (s) => String(s ?? '').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
const pct = (n) => (n == null || Number.isNaN(Number(n)) ? '—' : `${Math.round(Number(n) * 10) / 10}%`);
const num = (n, d = 2) => (n == null || Number.isNaN(Number(n)) ? '—' : Number(n).toFixed(d));
function shortDate(d) {
  const t = new Date(d);
  return Number.isNaN(t.getTime()) ? '' : t.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
}
// "+1.2σ above its usual" — how far today's sentiment sits from the holding's own 90-day normal.
function vsNormal(z) {
  if (z == null || Number.isNaN(Number(z))) return 'Not enough history';
  const v = Number(z);
  if (Math.abs(v) < 0.5) return 'In its usual range';
  return `${v > 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}σ ${v > 0 ? 'above' : 'below'} usual`;
}

// The figures in the strip under the lead. Pure — also what the tests read.
function reportStats(r) {
  const events = (r.events || []).length + (r.moreEvents || 0);
  const ch = r.changed || {};
  const stats = [{ label: 'Holdings', value: String((r.holdings || []).length) }];
  if (r.kind === 'weekly') {
    stats.push({ label: 'Events this week', value: String(events) });
    stats.push({ label: 'Alerts this week', value: String(r.alertCount || 0) });
  } else {
    stats.push({ label: 'Events ranked', value: String(events) });
    stats.push({ label: 'New events', value: ch.has_prior ? String((ch.new_events || []).length) : '—' });
    stats.push({ label: 'Sentiment shifts', value: ch.has_prior ? String((ch.sentiment_swings || []).length) : '—' });
  }
  const top = (r.holdings || []).slice().sort((a, b) => (b.exposure_pct || 0) - (a.exposure_pct || 0))[0];
  if (top) stats.push({ label: 'Largest position', value: `${top.ticker} ${pct(top.exposure_pct)}` });
  return stats;
}

// The strip when the report carries insights: money first, then counts. Pure.
function insightStats(r) {
  const ins = r.insights || {};
  const stats = [];
  if (ins.portfolio_value) stats.push({ label: 'Portfolio value', value: ins.portfolio_value });
  const move = ins.movers && ins.movers.portfolio_change_pct;
  if (move != null) stats.push({ label: 'Latest session', value: `${move > 0 ? '+' : move < 0 ? '−' : ''}${Math.abs(move).toFixed(2)}%`, tone: move > 0 ? 'positive' : move < 0 ? 'negative' : null });
  stats.push({ label: 'To check', value: String((ins.verdict && ins.verdict.count) || 0) });
  stats.push({ label: 'Holdings', value: String((r.holdings || []).length) });
  const top = (r.holdings || []).slice().sort((a, b) => (b.exposure_pct || 0) - (a.exposure_pct || 0))[0];
  if (top) stats.push({ label: 'Largest position', value: `${top.ticker} ${pct(top.exposure_pct)}` });
  return stats;
}

function buildReportPdf(report) {
  return new Promise((resolve, reject) => {
    const r = report || {};
    const title = r.kind === 'weekly' ? 'Weekly Summary' : r.kind === 'evening' ? 'End-of-Day Report' : 'Daily Brief';
    const doc = new PDFDocument({
      size: 'A4', margin: PAGE.margin, bufferPages: true, autoFirstPage: true,
      info: { Title: `SenIQ ${title} — ${r.dateLabel || ''}`, Author: 'SenIQ', Subject: title },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
    for (const [name, file] of Object.entries(FONTS)) doc.registerFont(name, file);

    const X = PAGE.margin;
    let y = 0;

    // Start a new page when the next block would run into the footer.
    const need = (h) => { if (y + h > BOTTOM) { doc.addPage(); y = PAGE.margin; } };
    const heightOf = (text, font, size, width, opts = {}) => doc.font(font).fontSize(size).heightOfString(text, { width, ...opts });
    const write = (text, x, yy, font, size, color, opts = {}) => doc.font(font).fontSize(size).fillColor(color).text(text, x, yy, { lineBreak: opts.width != null, ...opts });

    function pill(label, x, yy, t) {
      doc.font('semibold').fontSize(7.5);
      const w = doc.widthOfString(label) + 14;
      doc.roundedRect(x, yy, w, 15, 7.5).fill(t.bg);
      write(label, x + 7, yy + 3.6, 'semibold', 7.5, t.fg);
      return w;
    }

    function section(heading, sub) {
      need(64);
      y += 20;
      doc.rect(X, y + 1, 3, 12).fill(C.blue);
      write(heading, X + 10, y, 'semibold', 11.5, C.ink);
      if (sub) write(sub, X + 10, y + 16, 'regular', 8, C.muted, { width: CONTENT_W - 10 });
      y += sub ? 16 + heightOf(sub, 'regular', 8, CONTENT_W - 10) + 8 : 24;
    }

    // ── Header band ──
    doc.rect(0, 0, PAGE.width, 96).fill(C.navy);
    write('SenIQ', X, 30, 'bold', 22, C.white);
    write('PORTFOLIO INTELLIGENCE', X, 58, 'medium', 7, '#9FB3C8', { characterSpacing: 1.4 });
    write(title, X, 28, 'semibold', 15, C.white, { width: CONTENT_W, align: 'right' });
    write(clean(r.dateLabel), X, 49, 'regular', 9.5, '#CBD5E1', { width: CONTENT_W, align: 'right' });
    const forLine = [r.name ? `Prepared for ${clean(r.name)}` : null, r.marketLabel ? `${clean(r.marketLabel)} market` : null].filter(Boolean).join('  ·  ');
    if (forLine) write(forLine, X, 64, 'regular', 8.5, '#9FB3C8', { width: CONTENT_W, align: 'right' });
    y = 96 + 22;

    const ins = r.insights || null;
    const verdict = ins && ins.verdict;

    // ── Lead: the verdict, or (without insights) the single most important event ──
    const lead = verdict ? null : (r.events || [])[0] || null;
    const leadTitle = clean(verdict ? verdict.text : lead ? lead.title : (r.headline || 'Nothing material to flag for your holdings.'));
    const leadSub = verdict ? clean(verdict.detail) : '';
    const leadW = CONTENT_W - 36;
    const leadH = heightOf(leadTitle, 'semibold', 14, leadW, { lineGap: 2 });
    const subH = leadSub ? heightOf(leadSub, 'regular', 9.5, leadW, { lineGap: 2 }) + 6 : 0;
    const cardH = 32 + leadH + subH + (lead ? 25 : 0) + 16;
    doc.roundedRect(X, y, CONTENT_W, cardH, 8).fillAndStroke(C.panel, C.line);
    doc.roundedRect(X, y, 4, cardH, 2).fill(verdict ? (verdict.level === 'check' ? C.blue : C.positive) : lead ? tone(lead.direction).fg : C.faint);
    const leadLabel = verdict ? (r.kind === 'weekly' ? 'THIS WEEK FOR YOUR PORTFOLIO' : r.kind === 'evening' ? 'TONIGHT FOR YOUR PORTFOLIO' : 'TODAY FOR YOUR PORTFOLIO') : lead ? 'MOST IMPORTANT FOR YOUR PORTFOLIO' : 'TODAY';
    write(leadLabel, X + 18, y + 16, 'semibold', 7.5, C.blue, { characterSpacing: 1 });
    write(leadTitle, X + 18, y + 32, 'semibold', 14, C.ink, { width: leadW, lineGap: 2 });
    if (leadSub) write(leadSub, X + 18, y + 32 + leadH + 6, 'regular', 9.5, C.text, { width: leadW, lineGap: 2 });
    if (lead) {
      const my = y + 32 + leadH + 10;
      let mx = X + 18;
      mx += pill(tone(lead.direction).word, mx, my, tone(lead.direction)) + 8;
      const meta = [`${pct(lead.exposure_pct)} of your exposure`, `Impact ${num(lead.impact_score)}`, clean(lead.source), shortDate(lead.last_seen)].filter(Boolean).join('   ·   ');
      write(meta, mx, my + 3, 'regular', 8.5, C.muted);
    }
    y += cardH;

    // ── Figures at a glance ──
    const stats = (ins ? insightStats(r) : reportStats(r)).slice(0, 5);
    if (stats.length) {
      y += 12;
      const gap = 8;
      const w = (CONTENT_W - gap * (stats.length - 1)) / stats.length;
      stats.forEach((s, i) => {
        const sx = X + i * (w + gap);
        doc.roundedRect(sx, y, w, 46, 6).fillAndStroke(C.white, C.line);
        write(s.label.toUpperCase(), sx + 10, y + 9, 'medium', 6.5, C.muted, { characterSpacing: 0.6 });
        write(clean(s.value), sx + 10, y + 22, 'semibold', s.value.length > 9 ? 10.5 : 14, s.tone ? TONE[s.tone].fg : C.ink, { width: w - 16, height: 18, ellipsis: true });
      });
      y += 46;
    }

    // ── Summary (prose only when a model wrote it; the template repeats the tables below) ──
    const prose = r.writer === 'claude' || r.writer === 'ollama' ? clean(r.narrative) : '';
    const summary = prose || clean(r.note);
    if (summary) {
      section(prose ? 'Analyst summary' : 'Summary');
      const paragraphs = (prose ? String(r.narrative) : String(r.note)).split(/\n{2,}/).map(clean).filter(Boolean);
      for (const p of paragraphs) {
        const h = heightOf(p, 'regular', 9.5, CONTENT_W, { lineGap: 3 });
        need(h + 8);
        write(p, X, y, 'regular', 9.5, C.text, { width: CONTENT_W, lineGap: 3 });
        y += h + 8;
      }
      y -= 8;
    }

    // ── Table helper: columns = [{ key, label, width, align }], cell(row, col) draws itself ──
    function table(columns, rows, rowHeight, drawRow) {
      const head = () => {
        doc.rect(X, y, CONTENT_W, 20).fill(C.panel);
        let cx = X + 10;
        for (const c of columns) {
          // Right-aligned headings end where their figures end (20pt inside the column).
          write(c.label.toUpperCase(), cx, y + 7, 'semibold', 6.5, C.muted, { width: c.width - (c.align === 'right' ? 20 : 10), align: c.align || 'left', characterSpacing: 0.5 });
          cx += c.width;
        }
        y += 20;
      };
      head();
      rows.forEach((row, i) => {
        const h = rowHeight(row);
        if (y + h > BOTTOM) { doc.addPage(); y = PAGE.margin; head(); }
        const xs = [];
        let cx = X + 10;
        for (const c of columns) { xs.push(cx); cx += c.width; }
        drawRow(row, xs, i);
        y += h;
        doc.moveTo(X, y).lineTo(X + CONTENT_W, y).lineWidth(0.5).strokeColor(C.line).stroke();
      });
    }

    const bullets = (lines, color = C.blue) => {
      for (const line of lines) {
        const t = clean(line);
        const h = heightOf(t, 'regular', 9.5, CONTENT_W - 14, { lineGap: 2 });
        need(h + 8);
        doc.circle(X + 4, y + 5.5, 2).fill(color);
        write(t, X + 14, y, 'regular', 9.5, C.text, { width: CONTENT_W - 14, lineGap: 2 });
        y += h + 7;
      }
    };

    // ── Headline cards: each headline with why it matters, how it affects, how sure ──
    const cards = (ins && ins.cards) || [];
    if (cards.length) {
      section(r.kind === 'weekly' ? 'The headline that mattered most this week' : 'Top headlines for your portfolio',
        'Each one says what it has to do with what you own. These describe pressure and typical patterns, not where a price will go.');
      const inner = CONTENT_W - 32;
      const rowsOf = (c) => [['What happened', c.what], ['Why it matters to you', c.why], ['How it affects your portfolio', c.how], ['How sure we are', c.sure]]
        .filter(([, text]) => text).map(([label, text]) => [label, clean(text)]);
      for (const c of cards) {
        const t = clean(c.title);
        const th = heightOf(t, 'semibold', 11, inner, { lineGap: 2 });
        const rows = rowsOf(c);
        const rowsH = rows.reduce((a, [, text]) => a + 12 + heightOf(text, 'regular', 9, inner, { lineGap: 2.5 }) + 8, 0);
        const h = 14 + th + 6 + 15 + 12 + rowsH + 6;
        need(h + 10);
        doc.roundedRect(X, y, CONTENT_W, h, 8).fillAndStroke(C.white, C.line);
        doc.roundedRect(X, y, 4, h, 2).fill(tone(c.direction).fg);
        let cy = y + 14;
        write(t, X + 16, cy, 'semibold', 11, C.ink, { width: inner, lineGap: 2 });
        cy += th + 6;
        let px = X + 16;
        px += pill(clean(c.channel_label), px, cy, c.channel === 'direct' ? { fg: C.blue, bg: C.accentBg } : TONE.neutral) + 6;
        px += pill(tone(c.direction).word, px, cy, tone(c.direction)) + 8;
        write([clean(c.type_label), clean(c.source), shortDate(c.last_seen)].filter(Boolean).join('  ·  '), px, cy + 3.5, 'regular', 8, C.muted, { width: X + CONTENT_W - 16 - px, height: 10, ellipsis: true });
        cy += 15 + 12;
        for (const [label, text] of rows) {
          write(label, X + 16, cy, 'semibold', 8, C.blue);
          cy += 12;
          write(text, X + 16, cy, 'regular', 9, C.text, { width: inner, lineGap: 2.5 });
          cy += heightOf(text, 'regular', 9, inner, { lineGap: 2.5 }) + 8;
        }
        y += h + 10;
      }
      y -= 10;
    }

    // ── Why the portfolio moved ──
    const movers = (ins && ins.movers && ins.movers.rows) || [];
    if (movers.length && r.kind !== 'weekly') {
      const total = ins.movers.portfolio_change_pct;
      const signed = (n, d = 2) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(Number(n)).toFixed(d)}%`;
      section('Why your portfolio moved',
        `Latest session: ${total == null ? 'not enough prices' : `${signed(total)} across your priced holdings`}. "Share of move" is how many of those points each holding added or took away. The news beside it is related coverage, not proof of cause.`);
      const cols = [
        { label: 'Holding', width: 78 },
        { label: 'Move', width: 62, align: 'right' },
        { label: 'Share of move', width: 96, align: 'right' },
        { label: 'News on it', width: CONTENT_W - 78 - 62 - 96 },
      ];
      const newsW = cols[3].width - 14;
      const newsOf = (m) => clean(m.news) || 'No company-specific news in our feed.';
      table(cols, movers.slice(0, 10),
        (m) => Math.max(26, heightOf(newsOf(m), 'regular', 8.5, newsW, { lineGap: 1.5 }) + 14),
        (m, xs) => {
          const col = (n) => (n > 0 ? C.positive : n < 0 ? C.negative : C.text);
          write(clean(m.ticker), xs[0], y + 7, 'semibold', 9.5, C.ink);
          write(signed(m.change_pct), xs[1], y + 7, 'semibold', 9, col(m.change_pct), { width: cols[1].width - 20, align: 'right' });
          write(signed(m.contribution_pct), xs[2], y + 7, 'semibold', 9, col(m.contribution_pct), { width: cols[2].width - 20, align: 'right' });
          write(newsOf(m), xs[3], y + 7, 'regular', 8.5, m.news ? C.text : C.faint, { width: newsW, lineGap: 1.5 });
        });
    }

    // ── Price and news pulling apart ──
    const divergences = (ins && ins.divergences) || [];
    if (divergences.length && r.kind !== 'weekly') {
      section('Price and news pulling apart', 'When a price and its news disagree, one of them usually catches up with the other. Worth a look, not a signal by itself.');
      bullets(divergences.map((d) => d.text));
    }

    // ── Concentration ──
    const conc = ins && ins.concentration;
    if (conc && (conc.split || []).length && r.kind !== 'weekly') {
      section('Where your portfolio is concentrated');
      let sx = X;
      for (const part of conc.split) {
        const label = `${clean(part.label)}  ${pct(part.pct)}`;
        doc.font('semibold').fontSize(7.5);
        const w = doc.widthOfString(label) + 14;
        if (sx + w > X + CONTENT_W) { sx = X; y += 20; need(20); }
        pill(label, sx, y, TONE.neutral);
        sx += w + 6;
      }
      y += 15 + 10;
      if (conc.lines.length) bullets(conc.lines);
      else { write('No single holding or sector dominates.', X, y, 'regular', 9.5, C.text); y += 14; }
      y -= 4;
    }

    // ── What changed since yesterday (daily) ──
    const ch = r.changed || {};
    const newEvents = (ch.new_events || []).slice(0, 4);
    const swings = (ch.sentiment_swings || []).slice(0, 6);
    if (r.kind !== 'weekly' && ch.has_prior && (newEvents.length || swings.length)) {
      section('What changed since yesterday');
      for (const e of newEvents) {
        const t = clean(e.title);
        const h = heightOf(t, 'regular', 9.5, CONTENT_W - 96, { lineGap: 2 });
        need(h + 10);
        doc.circle(X + 4, y + 5.5, 2).fill(tone(e.direction).fg);
        write(t, X + 14, y, 'regular', 9.5, C.text, { width: CONTENT_W - 96, lineGap: 2 });
        write(`${pct(e.exposure_pct)} exposure`, X, y, 'medium', 8.5, C.muted, { width: CONTENT_W, align: 'right' });
        y += h + 8;
      }
      if (swings.length) {
        need(30);
        y += 2;
        write('Sentiment shifted', X, y, 'medium', 8.5, C.muted);
        y += 14;
        let sx = X;
        for (const s of swings) {
          const label = `${clean(s.ticker)}  ${tone(s.from_label).word.toLowerCase()} → ${tone(s.to_label).word.toLowerCase()}`;
          doc.font('semibold').fontSize(7.5);
          const w = doc.widthOfString(label) + 14;
          if (sx + w > X + CONTENT_W) { sx = X; y += 20; need(20); }
          pill(label, sx, y, tone(s.to_label));
          sx += w + 6;
        }
        y += 15;
      }
    }

    // ── Events ranked by impact ──
    const events = cards.length ? [] : (r.events || []).slice(0, 8);
    if (events.length) {
      section(r.kind === 'weekly' ? 'The event that mattered most this week' : 'Events ranked by impact on your portfolio',
        'Impact combines how much of your portfolio an event touches with how strong, surprising and recent it is.');
      const cols = [
        { label: '#', width: 22 },
        { label: 'Event', width: CONTENT_W - 22 - 70 - 74 - 54 },
        { label: 'Exposure', width: 70, align: 'right' },
        { label: 'Reads', width: 74 },
        { label: 'Impact', width: 54, align: 'right' },
      ];
      const titleW = cols[1].width - 14;
      table(cols, events,
        (e) => heightOf(clean(e.title), 'medium', 9, titleW, { lineGap: 1.5 }) + 12 + 16,
        (e, xs, i) => {
          const th = heightOf(clean(e.title), 'medium', 9, titleW, { lineGap: 1.5 });
          write(String(i + 1), xs[0], y + 9, 'semibold', 9, C.faint);
          write(clean(e.title), xs[1], y + 8, 'medium', 9, C.ink, { width: titleW, lineGap: 1.5 });
          write([clean(e.source), shortDate(e.last_seen)].filter(Boolean).join('  ·  '), xs[1], y + 8 + th + 2, 'regular', 7.5, C.muted, { width: titleW, height: 10, ellipsis: true });
          write(pct(e.exposure_pct), xs[2], y + 9, 'semibold', 9, C.ink, { width: cols[2].width - 20, align: 'right' });
          pill(tone(e.direction).word, xs[3] + 6, y + 7, tone(e.direction));
          write(num(e.impact_score), xs[4], y + 9, 'semibold', 9, C.ink, { width: cols[4].width - 20, align: 'right' });
        });
      if (r.moreEvents > 0) {
        y += 8;
        const more = `${r.moreEvents} more event${r.moreEvents === 1 ? ' is' : 's are'} ranked in your impact feed in the app.`;
        need(16);
        write(more, X, y, 'regular', 8.5, C.muted, { width: CONTENT_W });
        y += 12;
      }
    }

    // ── Holdings ──
    const holdings = (r.holdings || []).slice(0, 15);
    if (holdings.length) {
      section('Your holdings', 'Exposure is each holding\'s share of your portfolio. Sentiment is the recent news reading (0–100); "vs usual" compares it with that holding\'s own 90-day normal.');
      const cols = [
        { label: 'Holding', width: CONTENT_W - 150 - 132 - 96 },
        { label: 'Exposure', width: 150 },
        { label: 'Sentiment', width: 132 },
        { label: 'Vs usual', width: 96 },
      ];
      table(cols, holdings, () => 30, (h, xs) => {
        write(clean(h.ticker), xs[0], y + 6, 'semibold', 9.5, C.ink);
        write(clean(h.name || ''), xs[0], y + 18, 'regular', 7.5, C.muted, { width: cols[0].width - 14, height: 10, ellipsis: true });
        // Exposure: the figure plus a bar on a fixed track, so rows compare at a glance.
        const share = Math.max(0, Math.min(100, Number(h.exposure_pct) || 0));
        write(pct(h.exposure_pct), xs[1], y + 10, 'semibold', 9, C.ink, { width: 38 });
        doc.roundedRect(xs[1] + 44, y + 12, 86, 6, 3).fill(C.line);
        if (share > 0) doc.roundedRect(xs[1] + 44, y + 12, Math.max(6, 86 * share / 100), 6, 3).fill(C.blue);
        const t = tone(h.sentiment_label);
        const w = pill(t.word, xs[2], y + 8, t);
        if (h.sentiment_acute != null) write(`${Math.round(Number(h.sentiment_acute) * 100)}/100`, xs[2] + w + 7, y + 11, 'regular', 8.5, C.muted);
        write(vsNormal(h.z), xs[3], y + 11, 'regular', 8.5, h.z == null ? C.faint : C.text, { width: cols[3].width - 12 });
      });
      const cov = ins && ins.coverage && clean(ins.coverage.text);
      if (cov) {
        const h = heightOf(cov, 'regular', 8.5, CONTENT_W, { lineGap: 2 });
        need(h + 10);
        y += 8;
        write(cov, X, y, 'regular', 8.5, C.muted, { width: CONTENT_W, lineGap: 2 });
        y += h;
      }
    }

    // ── Smart money ──
    const sm = r.smartMoney || {};
    const congress = (sm.congress || []).slice(0, 6);
    const institutions = (sm.institutions || []).slice(0, 6);
    if (congress.length || institutions.length) {
      section('Smart money in your names', 'Disclosed weeks after the fact by law — the dates are when the trade happened, not when it became public.');
      const all = [
        ...congress.map((c) => ({ who: clean(c.politician), kind: 'Congress', what: clean(c.action), ticker: clean(c.ticker), when: shortDate(c.date) })),
        ...institutions.map((i) => ({ who: clean(i.name), kind: '13F filing', what: clean(i.change), ticker: clean(i.ticker), when: '' })),
      ];
      // The same line can arrive twice (one fund, two share classes of one ticker).
      const seen = new Set();
      const rows = all.filter((row) => { const k = Object.values(row).join('|'); return seen.has(k) ? false : seen.add(k); });
      const cols = [
        { label: 'Who', width: CONTENT_W - 86 - 90 - 70 - 90 },
        { label: 'Source', width: 86 },
        { label: 'Action', width: 90 },
        { label: 'Ticker', width: 70 },
        { label: 'Trade date', width: 90 },
      ];
      table(cols, rows, () => 22, (row, xs) => {
        write(row.who, xs[0], y + 7, 'medium', 9, C.ink, { width: cols[0].width - 12, height: 11, ellipsis: true });
        write(row.kind, xs[1], y + 7, 'regular', 8.5, C.muted);
        const selling = /sell|sold|reduc|exit|trim/i.test(row.what);
        const buying = /buy|bought|purchas|add|new|increas/i.test(row.what);
        write(row.what ? row.what[0].toUpperCase() + row.what.slice(1) : '—', xs[2], y + 7, 'medium', 8.5, selling ? C.negative : buying ? C.positive : C.text);
        write(row.ticker || '—', xs[3], y + 7, 'semibold', 9, C.ink);
        write(row.when || '—', xs[4], y + 7, 'regular', 8.5, C.muted);
      });
    }

    // ── How earlier readings held up ──
    const tr = ins && ins.trackRecord;
    if (tr) {
      section('How earlier readings held up',
        'A reading is not a forecast. This compares each holding\'s daily news reading over the last 14 days with what its price did the next day, misses included.');
      if (tr.calls < MIN_GRADED_READINGS) {
        const t = `Too few graded readings so far (${tr.calls} of the ${MIN_GRADED_READINGS} needed before a rate means anything). This fills in as days pass.`;
        need(16);
        write(t, X, y, 'regular', 9.5, C.text, { width: CONTENT_W });
        y += 14;
      } else {
        const t = `Of ${tr.calls} readings across all tracked names, the next day's price went the same way ${tr.matched} time${tr.matched === 1 ? '' : 's'}, ` +
          `the other way ${tr.missed} time${tr.missed === 1 ? '' : 's'}, and barely moved ${tr.flat} time${tr.flat === 1 ? '' : 's'}.`;
        const h = heightOf(t, 'regular', 9.5, CONTENT_W, { lineGap: 2 });
        need(h + 8);
        write(t, X, y, 'regular', 9.5, C.text, { width: CONTENT_W, lineGap: 2 });
        y += h + 8;
        const mine = (tr.mine || []).slice(0, 5);
        if (mine.length) {
          const cols = [
            { label: 'Day', width: 110 },
            { label: 'Holding', width: 90 },
            { label: 'News read', width: 100 },
            { label: 'Next-day move', width: 100, align: 'right' },
            { label: 'Result', width: CONTENT_W - 400 },
          ];
          const RESULT = { matched: ['Same way', C.positive], missed: ['Other way', C.negative], flat: ['No clear move', C.muted] };
          table(cols, mine, () => 22, (g, xs) => {
            write(shortDate(g.day), xs[0], y + 7, 'regular', 8.5, C.muted);
            write(clean(g.ticker), xs[1], y + 7, 'semibold', 9, C.ink);
            write(tone(g.call).word, xs[2], y + 7, 'medium', 8.5, tone(g.call).fg);
            write(`${g.move_pct > 0 ? '+' : g.move_pct < 0 ? '−' : ''}${Math.abs(g.move_pct).toFixed(2)}%`, xs[3], y + 7, 'semibold', 9, C.ink, { width: cols[3].width - 20, align: 'right' });
            const [word, color] = RESULT[g.result] || RESULT.flat;
            write(word, xs[4] + 10, y + 7, 'medium', 8.5, color);
          });
        }
      }
    }

    // ── Footer on every page: disclaimer + page numbers ──
    const range = doc.bufferedPageRange();
    for (let i = 0; i < range.count; i++) {
      doc.switchToPage(range.start + i);
      const fy = PAGE.height - PAGE.footer;
      doc.moveTo(X, fy).lineTo(X + CONTENT_W, fy).lineWidth(0.5).strokeColor(C.line).stroke();
      // lineBreak:false + a y inside the bottom margin would otherwise start a new page.
      doc.page.margins.bottom = 0;
      write(DISCLAIMER, X, fy + 9, 'regular', 7, C.faint, { width: CONTENT_W - 70, height: 20 });
      write(`Page ${i + 1} of ${range.count}`, X, fy + 9, 'regular', 7, C.faint, { width: CONTENT_W, align: 'right', height: 10 });
      doc.page.margins.bottom = PAGE.margin;
    }

    doc.end();
  });
}

module.exports = { buildReportPdf, reportStats, insightStats, vsNormal };
