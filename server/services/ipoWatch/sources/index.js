/**
 * IPO Watch calendar sources, in order of trust: an earlier source wins a field both have.
 *
 * A source is { name, fetchIssues }. fetchIssues() resolves to a list of plain issues:
 *   (an issue is Indian unless it says market: 'US'; a US issue has no board and may carry
 *    source_status, status_date, shares, issue_size_usd and is_spac)
 *   { name, board: 'mainboard' | 'sme', exchange?, symbol?, open_date?, close_date?,
 *     allotment_date?, listing_date?, price_low?, price_high?, lot_size?, issue_size_cr?,
 *     fresh_issue_cr?, ofs_cr?, withdrawn?, source_ref?, gmp?, gmp_history?, listing_price?,
 *     listing_gain_pct?,
 *     subscription? }
 * with dates as "YYYY-MM-DD", gmp in ₹ per share (a number, or absent when unknown), and
 *   subscription: { observed_on?, total, qib?, nii?, nii_small?, nii_big?, retail? }
 * in times subscribed, observed_on being the day the figures are as of.
 * gmp_history is [{ on, gmp }]: premiums the source reports for earlier days. listing_price
 * (₹ per share) and listing_gain_pct (over the issue price) come once the issue has listed;
 * a source may have only one of them. It makes as few requests as it can, identifies itself, and
 * throws on a refusal — the caller treats that as "no data today".
 *
 * BSE and NSE both refused automated requests from this client on 2026-10-09, so the first
 * source is an aggregator; an exchange source would go in front of it.
 */

const investorgain = require('./investorgain');
const finnhub = require('./finnhub');

// India from InvestorGain; the US from Finnhub when its key is set.
module.exports = [investorgain.calendar, investorgain.subscriptions, ...(process.env.FINNHUB_API_KEY ? [finnhub.calendar] : [])];
