/**
 * Best-effort CUSIP → ticker map for common large-caps.
 *
 * 13F information tables identify holdings by CUSIP (and issuer name), not ticker.
 * A full CUSIP→ticker resolution needs a paid CUSIP database, which is out of scope
 * under cheapest-viable. This static map covers the mega-caps most users actually hold
 * so their portfolio matches against 13F holdings. Unmapped CUSIPs keep a null ticker
 * and just display the issuer name — honest about the coverage gap.
 */

const CUSIP_TO_TICKER = {
  '037833100': 'AAPL',  '594918104': 'MSFT',  '67066G104': 'NVDA',  '023135106': 'AMZN',
  '02079K305': 'GOOGL', '02079K107': 'GOOG',  '30303M102': 'META',  '88160R101': 'TSLA',
  '084670702': 'BRK.B', '46625H100': 'JPM',   '92826C839': 'V',     '91324P102': 'UNH',
  '30231G102': 'XOM',   '478160104': 'JNJ',   '931142103': 'WMT',   '57636Q104': 'MA',
  '742718109': 'PG',    '437076102': 'HD',    '060505104': 'BAC',   '191216100': 'KO',
  '713448108': 'PEP',   '22160K105': 'COST',  '254687106': 'DIS',   '64110L106': 'NFLX',
  '007903107': 'AMD',   '458140100': 'INTC',  '79466L302': 'CRM',   '17275R102': 'CSCO',
  '00724F101': 'ADBE',  '68389X105': 'ORCL',  '717081103': 'PFE',   '00206R102': 'T',
  '92343V104': 'VZ',    '01609W102': 'BABA',  '70450Y103': 'PYPL',  '009066101': 'ABNB',
  '19260Q107': 'COIN',  '90353T100': 'UBER',  '82509L107': 'SHOP',  '852234103': 'XYZ',
  '345370860': 'F',     '37045V100': 'GM',    '097023105': 'BA',    '654106103': 'NKE',
  '580135101': 'MCD',   '855244109': 'SBUX',  '674599105': 'OXY',   '500754106': 'KHC',
  '025816109': 'AXP',   '166764100': 'CVX',   '02005N100': 'ALLY',  '92556H206': 'VICI',
  '375558103': 'GILD',  '110122108': 'BMY',   '524901105': 'LEN',
};

function cusipToTicker(cusip) {
  if (!cusip) return null;
  return CUSIP_TO_TICKER[cusip.toUpperCase()] || null;
}

module.exports = { cusipToTicker, CUSIP_TO_TICKER };
