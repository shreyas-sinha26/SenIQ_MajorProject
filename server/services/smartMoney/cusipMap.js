/**
 * Best-effort CUSIP → ticker map for common large-caps.
 *
 * 13F information tables identify holdings by CUSIP (and issuer name), not ticker.
 * A full CUSIP→ticker resolution needs a paid CUSIP database, which is out of scope
 * under cheapest-viable. This static map covers every US name in the curated universe plus
 * a few other mega-caps, so portfolios and strategy factors can match against 13F holdings.
 * Unmapped CUSIPs keep a null ticker and just display the issuer name — honest about the
 * coverage gap.
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

  // ── The rest of the US universe (data/universe.js), added 2026-10-07 ──
  // One common-stock CUSIP per company. Candidates came from stored 13F rows and each was
  // confirmed against OpenFIGI (CUSIP → ticker, security type Common Stock / ADR / REIT) —
  // NOT matched by issuer name, which would have filed iShares ETFs under BLK and Strategy
  // ETFs and convertible notes under MSTR. ACN and LIN are Irish issuers (CINS identifiers).
  // Other share classes, units, preferreds and notes of these companies stay unmapped.
  '00287Y109': 'ABBV',  '002824100': 'ABT',   'G1151C101': 'ACN',   '038222105': 'AMAT',
  '031162100': 'AMGN',  '040413205': 'ANET',  '11135F101': 'AVGO',  '09857L108': 'BKNG',
  '09290D101': 'BLK',   '09260D107': 'BX',    '172967424': 'C',     '149123101': 'CAT',
  '20030N101': 'CMCSA', '169656105': 'CMG',   '20825C104': 'COP',   '22788C105': 'CRWD',
  '126650100': 'CVS',   '244199105': 'DE',    '24703L202': 'DELL',  '235851102': 'DHR',
  '31428X106': 'FDX',   '369604301': 'GE',    '38141G104': 'GS',    '438516205': 'HON',
  '770700102': 'HOOD',  '459200101': 'IBM',   '461202103': 'INTU',  '46120E602': 'ISRG',
  'G54950103': 'LIN',   '532457108': 'LLY',   '539830109': 'LMT',   '548661107': 'LOW',
  '609207105': 'MDLZ',  '58933Y105': 'MRK',   '617446448': 'MS',    '594972408': 'MSTR',
  '595112103': 'MU',    '65339F101': 'NEE',   '81762P102': 'NOW',   '697435105': 'PANW',
  '69608A108': 'PLTR',  '718172109': 'PM',    '747525103': 'QCOM',  '75513E101': 'RTX',
  '808513105': 'SCHW',  '78409V104': 'SPGI',  '87612E106': 'TGT',   '872540109': 'TJX',
  '883556102': 'TMO',   '872590104': 'TMUS',  '882508104': 'TXN',   '907818108': 'UNP',
  '911312106': 'UPS',   '949746101': 'WFC',
};

function cusipToTicker(cusip) {
  if (!cusip) return null;
  return CUSIP_TO_TICKER[cusip.toUpperCase()] || null;
}

module.exports = { cusipToTicker, CUSIP_TO_TICKER };
