/**
 * Dates as an Ask answer says them. A tool writes a date out once, here, so every answer
 * gives it the same way ("13 Oct", "13 to 15 Oct") and none has to work it out. Pure.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// Today's date (UTC), for telling this year's dates from another's.
const todayIso = () => new Date().toISOString().slice(0, 10);

// "13 Oct", with the year when it is not this year's (or when today is not known).
function shortDay(iso, today = null) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  if (!m) return null;
  const year = today && String(today).slice(0, 4) === m[1] ? '' : ` ${m[1]}`;
  return `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}${year}`;
}

// Two dates as one span: "13 to 15 Oct" within a month, "30 Sep to 2 Oct" across two.
function daySpan(from, to, today = null) {
  const a = shortDay(from, today);
  const b = shortDay(to, today);
  if (!a || !b) return a || b;
  return String(from).slice(0, 7) === String(to).slice(0, 7) ? `${Number(String(from).slice(8, 10))} to ${b}` : `${a} to ${b}`;
}

// How much of the portfolio a story reaches, as a code-written text says it. A market-wide
// story (`market_wide`) reaches holdings through their market, not by naming them, so its
// figure is a weighted reach and not a plain share: "31.6% of your exposure" beside a
// hardware-wallet story, for a portfolio whose only crypto is 15.9% Bitcoin, read as a
// mistake. Pure.
function reachText(e) {
  return e && e.market_wide ? `market-wide, weighted reach ${e.exposure_pct}%` : `${e.exposure_pct}% of your exposure`;
}

module.exports = { shortDay, daySpan, todayIso, reachText };
