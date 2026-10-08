/**
 * NSE bulk and block deals — the Indian Institutions tab.
 *
 * Two small CSV files, replaced each trading evening with that day's deals:
 *   Date,Symbol,Security Name,Client Name,Buy/Sell,Quantity Traded,Trade Price / Wght. Avg. Price[,Remarks]
 * A day with no deals is a single "NO RECORDS" row. The file only ever holds the latest
 * day, so a day the poller does not run is a day of deals we never see.
 */

const { INDIA_SMART_MONEY } = require('../../config');
const { hashId } = require('../ingest/util');
const { matchInvestor } = require('../../data/indiaInvestors');
const { nseDate, nseNumber, csvFields, nseFetch } = require('./nse');

// CSV text → normalized deals. Rows that are not a real deal are dropped. Pure.
function parseDeals(csv, dealType) {
  const lines = String(csv || '').split(/\r?\n/).filter((l) => l.trim());
  const deals = [];
  for (const line of lines.slice(1)) { // first line is the header
    const [date, symbol, security, client, sideRaw, qty, price, remarks] = csvFields(line);
    const deal_date = nseDate(date);
    const ticker = String(symbol || '').toUpperCase().trim();
    const quantity = nseNumber(qty);
    const px = nseNumber(price);
    const side = /^b/i.test(sideRaw || '') ? 'buy' : /^s/i.test(sideRaw || '') ? 'sell' : null;
    if (!deal_date || !ticker || !client || !side || !quantity || !px) continue;
    const investor = matchInvestor(client);
    deals.push({
      source_id: hashId('indeal', dealType, deal_date, ticker, client, side, String(quantity), String(px)),
      deal_type: dealType,
      deal_date,
      ticker,
      security_name: (security || '').slice(0, 200),
      client_name: client.slice(0, 200),
      investor_slug: investor ? investor.slug : null,
      side,
      quantity,
      price: px,
      value: quantity * px,
      remarks: remarks && remarks !== '-' ? remarks.slice(0, 200) : null,
    });
  }
  return deals;
}

// Fetch today's file for one deal type ('bulk' | 'block').
async function fetchDeals(dealType) {
  const url = dealType === 'block' ? INDIA_SMART_MONEY.BLOCK_DEALS_URL : INDIA_SMART_MONEY.BULK_DEALS_URL;
  const res = await nseFetch(url, 'text/csv,*/*');
  return parseDeals(await res.text(), dealType);
}

module.exports = { parseDeals, fetchDeals };
