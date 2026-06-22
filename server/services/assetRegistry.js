/**
 * Asset Registry
 * Classifies a symbol into an asset class and carries the extra metadata that
 * multi-asset support needs: a display name, the price source's id (CoinGecko id
 * for crypto), and the aliases used to match news to the asset.
 *
 * Equities are NOT enumerated here — there are too many; they resolve through
 * tickerMatcher's company list and default to the 'equity' class. This registry
 * is the source of truth for the non-equity assets SenIQ launches with.
 */

// Schema-valid classes. fx/index are accepted by the DB but gated off in v1
// (see LAUNCH_ASSET_CLASSES) — they overlap the __MARKET__ macro tag / add
// symbol ambiguity, so they ship in a later phase without a migration.
const ASSET_CLASSES = ['equity', 'crypto', 'commodity', 'fx', 'index'];
const LAUNCH_ASSET_CLASSES = ['equity', 'crypto', 'commodity'];

// Non-equity assets available at launch. `coingeckoId` is the crypto price key;
// commodities have no free spot-price source on the cheapest-viable stack, so
// they carry no price id (price resolves to null, surfaced as N/A).
const NON_EQUITY_ASSETS = {
  // ── Crypto (price via CoinGecko) ──
  BTC:   { assetClass: 'crypto', name: 'Bitcoin',     coingeckoId: 'bitcoin',      aliases: ['bitcoin', 'btc'] },
  ETH:   { assetClass: 'crypto', name: 'Ethereum',    coingeckoId: 'ethereum',     aliases: ['ethereum', 'ether'] },
  SOL:   { assetClass: 'crypto', name: 'Solana',      coingeckoId: 'solana',       aliases: ['solana'] },
  XRP:   { assetClass: 'crypto', name: 'XRP',         coingeckoId: 'ripple',       aliases: ['ripple', 'xrp'] },
  ADA:   { assetClass: 'crypto', name: 'Cardano',     coingeckoId: 'cardano',      aliases: ['cardano'] },
  DOGE:  { assetClass: 'crypto', name: 'Dogecoin',    coingeckoId: 'dogecoin',     aliases: ['dogecoin'] },
  DOT:   { assetClass: 'crypto', name: 'Polkadot',    coingeckoId: 'polkadot',     aliases: ['polkadot'] },
  AVAX:  { assetClass: 'crypto', name: 'Avalanche',   coingeckoId: 'avalanche-2',  aliases: ['avalanche'] },
  MATIC: { assetClass: 'crypto', name: 'Polygon',     coingeckoId: 'matic-network', aliases: ['polygon', 'matic'] },
  LINK:  { assetClass: 'crypto', name: 'Chainlink',   coingeckoId: 'chainlink',    aliases: ['chainlink'] },

  // ── Commodities (no free spot price; matched via aliases in the news) ──
  XAU:   { assetClass: 'commodity', name: 'Gold',            aliases: ['gold', 'xau', 'bullion'] },
  XAG:   { assetClass: 'commodity', name: 'Silver',          aliases: ['silver', 'xag'] },
  WTI:   { assetClass: 'commodity', name: 'Crude Oil (WTI)', aliases: ['crude oil', 'wti', 'oil prices', 'opec'] },
  NG:    { assetClass: 'commodity', name: 'Natural Gas',     aliases: ['natural gas'] },
};

// Aliases for non-equity assets, in tickerMatcher's { TICKER: [alias, ...] } shape.
// tickerMatcher merges this so BTC/ETH/gold/oil headlines resolve to holdings.
const NON_EQUITY_ALIASES = Object.fromEntries(
  Object.entries(NON_EQUITY_ASSETS).map(([ticker, a]) => [ticker, a.aliases])
);

/**
 * Resolve a symbol to its canonical asset metadata.
 * A caller-declared class wins for equities (the registry only knows non-equities);
 * otherwise we classify from the registry and fall back to 'equity'.
 * @returns {{ ticker, assetClass, name, coingeckoId: string|null }}
 */
function resolveAsset(symbol, declaredClass) {
  const ticker = String(symbol || '').toUpperCase().trim();
  const known = NON_EQUITY_ASSETS[ticker];

  if (known) {
    return {
      ticker,
      assetClass: known.assetClass,
      name: known.name,
      coingeckoId: known.coingeckoId || null,
    };
  }

  // Unknown symbol: trust a valid declared class, else assume equity.
  const assetClass = ASSET_CLASSES.includes(declaredClass) ? declaredClass : 'equity';
  return { ticker, assetClass, name: null, coingeckoId: null };
}

function isLaunchAssetClass(assetClass) {
  return LAUNCH_ASSET_CLASSES.includes(assetClass);
}

module.exports = {
  ASSET_CLASSES,
  LAUNCH_ASSET_CLASSES,
  NON_EQUITY_ASSETS,
  NON_EQUITY_ALIASES,
  resolveAsset,
  isLaunchAssetClass,
};
