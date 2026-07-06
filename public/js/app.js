/* ═══ AI Portfolio Copilot — Frontend Application ═══ */
const API = '';
let token = localStorage.getItem('copilot_token');
let currentUser = null;
let sentimentChart = null;
let refreshInterval = null;

// ─── Filter State ────────────────────────────────────────────
let activeFilter = null;
let cachedArticles = [];
let cachedBuckets = { holdings: [], market: [], world: [] };
let cachedAlerts = [];
let cachedSentiments = {};
let cachedOverallScore = 50;
let newsExpanded = false;
let alertsExpanded = false;
let newsSearchQuery = '';

// ─── Asset Database (for smart autocomplete) ────────────────
const ASSET_DB = [
  // US Stocks
  { ticker: 'AAPL', name: 'Apple Inc', type: 'stock', market: 'US Stock' },
  { ticker: 'TSLA', name: 'Tesla Inc', type: 'stock', market: 'US Stock' },
  { ticker: 'NVDA', name: 'Nvidia Corp', type: 'stock', market: 'US Stock' },
  { ticker: 'MSFT', name: 'Microsoft Corp', type: 'stock', market: 'US Stock' },
  { ticker: 'GOOGL', name: 'Alphabet (Google)', type: 'stock', market: 'US Stock' },
  { ticker: 'AMZN', name: 'Amazon.com Inc', type: 'stock', market: 'US Stock' },
  { ticker: 'META', name: 'Meta Platforms', type: 'stock', market: 'US Stock' },
  { ticker: 'NFLX', name: 'Netflix Inc', type: 'stock', market: 'US Stock' },
  { ticker: 'AMD', name: 'Advanced Micro Devices', type: 'stock', market: 'US Stock' },
  { ticker: 'INTC', name: 'Intel Corp', type: 'stock', market: 'US Stock' },
  { ticker: 'CRM', name: 'Salesforce Inc', type: 'stock', market: 'US Stock' },
  { ticker: 'BA', name: 'Boeing Co', type: 'stock', market: 'US Stock' },
  { ticker: 'JPM', name: 'JPMorgan Chase', type: 'stock', market: 'US Stock' },
  { ticker: 'V', name: 'Visa Inc', type: 'stock', market: 'US Stock' },
  { ticker: 'DIS', name: 'Walt Disney Co', type: 'stock', market: 'US Stock' },
  // Indian Stocks
  { ticker: 'RELIANCE', name: 'Reliance Industries', type: 'india', market: 'India Stock' },
  { ticker: 'HDFCBANK', name: 'HDFC Bank', type: 'india', market: 'India Stock' },
  { ticker: 'TCS', name: 'Tata Consultancy Services', type: 'india', market: 'India Stock' },
  { ticker: 'INFY', name: 'Infosys Ltd', type: 'india', market: 'India Stock' },
  { ticker: 'WIPRO', name: 'Wipro Ltd', type: 'india', market: 'India Stock' },
  { ticker: 'ICICIBANK', name: 'ICICI Bank', type: 'india', market: 'India Stock' },
  { ticker: 'SBIN', name: 'State Bank of India', type: 'india', market: 'India Stock' },
  { ticker: 'TATAMOTORS', name: 'Tata Motors', type: 'india', market: 'India Stock' },
  { ticker: 'BAJFINANCE', name: 'Bajaj Finance', type: 'india', market: 'India Stock' },
  { ticker: 'ITC', name: 'ITC Limited', type: 'india', market: 'India Stock' },
  // Crypto
  { ticker: 'BTC', name: 'Bitcoin', type: 'crypto', market: 'Crypto' },
  { ticker: 'ETH', name: 'Ethereum', type: 'crypto', market: 'Crypto' },
  { ticker: 'SOL', name: 'Solana', type: 'crypto', market: 'Crypto' },
  { ticker: 'XRP', name: 'Ripple', type: 'crypto', market: 'Crypto' },
  { ticker: 'ADA', name: 'Cardano', type: 'crypto', market: 'Crypto' },
  { ticker: 'DOGE', name: 'Dogecoin', type: 'crypto', market: 'Crypto' },
  { ticker: 'DOT', name: 'Polkadot', type: 'crypto', market: 'Crypto' },
  { ticker: 'AVAX', name: 'Avalanche', type: 'crypto', market: 'Crypto' },
  { ticker: 'MATIC', name: 'Polygon', type: 'crypto', market: 'Crypto' },
  { ticker: 'LINK', name: 'Chainlink', type: 'crypto', market: 'Crypto' },
  // Commodities
  { ticker: 'XAU', name: 'Gold', type: 'commodity', market: 'Commodity' },
  { ticker: 'WTI', name: 'Crude Oil (WTI)', type: 'commodity', market: 'Commodity' },
  { ticker: 'XAG', name: 'Silver', type: 'commodity', market: 'Commodity' },
  { ticker: 'NG', name: 'Natural Gas', type: 'commodity', market: 'Commodity' },
];

// ASSET_DB.type → DB asset_class. India/US stocks are both 'equity'.
const TYPE_TO_CLASS = { stock: 'equity', india: 'equity', crypto: 'crypto', commodity: 'commodity' };
function assetClassOf(ticker) {
  const a = ASSET_DB.find(x => x.ticker === ticker.toUpperCase());
  return a ? (TYPE_TO_CLASS[a.type] || 'equity') : 'equity';
}

// ─── API Helper ──────────────────────────────────────────────
async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${API}${path}`, { ...opts, headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || 'Request failed');
    err.status = res.status;
    err.data = data; // carries { upgrade: { requiredTier, requiredLabel } } on 402
    throw err;
  }
  return data;
}

// ─── Toast Notifications ─────────────────────────────────────
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  setTimeout(() => { toast.style.opacity = '0'; toast.style.transform = 'translateX(40px)'; setTimeout(() => toast.remove(), 300); }, 4000);
}

// ─── Auth Logic ──────────────────────────────────────────────
function selectAuthTab(name) {
  const tab = document.querySelector(`.auth-tab[data-tab="${name}"]`);
  if (tab) tab.click();
}

function initAuth() {
  // ── Tab switching (tabs + cross-form links) ──
  function switchTab(name) {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    const tab = document.querySelector(`.auth-tab[data-tab="${name}"]`);
    if (tab) tab.classList.add('active');
    document.getElementById('login-form').classList.toggle('hidden', name !== 'login');
    document.getElementById('signup-form').classList.toggle('hidden', name !== 'signup');
    document.getElementById('auth-error').classList.add('hidden');
    const signupErr = document.getElementById('auth-error-signup');
    if (signupErr) signupErr.classList.add('hidden');
  }

  document.querySelectorAll('.auth-tab').forEach(tab => {
    tab.addEventListener('click', () => switchTab(tab.dataset.tab));
  });

  // Cross-form link buttons ("Create one free →" / "Sign in →")
  document.querySelectorAll('.auth-link[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Deep link from the landing page: /app?auth=signup opens the Create Account tab.
  const wanted = new URLSearchParams(location.search).get('auth');
  if (wanted === 'signup') switchTab('signup');

  // ── Password visibility toggles ──
  document.querySelectorAll('.pw-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const input = document.getElementById(btn.dataset.target);
      if (!input) return;
      const isText = input.type === 'text';
      input.type = isText ? 'password' : 'text';
      const icon = btn.querySelector('.material-symbols-outlined');
      if (icon) icon.textContent = isText ? 'visibility' : 'visibility_off';
    });
  });

  // ── Login ──
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('auth-error');
    errEl.classList.add('hidden');
    const btn = document.getElementById('login-btn');
    btn.disabled = true;
    const span = btn.querySelector('span');
    const origText = span.textContent;
    span.textContent = 'Signing in…';
    try {
      const data = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          email: document.getElementById('login-email').value,
          password: document.getElementById('login-password').value
        })
      });
      token = data.token;
      localStorage.setItem('copilot_token', token);
      currentUser = data.user;
      showDashboard();
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      span.textContent = origText;
    }
  });

  // ── Signup ──
  document.getElementById('signup-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('auth-error-signup') || document.getElementById('auth-error');
    errEl.classList.add('hidden');
    const btn = document.getElementById('signup-btn');
    btn.disabled = true;
    const span = btn.querySelector('span');
    const origText = span.textContent;
    span.textContent = 'Creating account…';
    try {
      const data = await api('/api/auth/signup', {
        method: 'POST',
        body: JSON.stringify({
          name: document.getElementById('signup-name').value,
          email: document.getElementById('signup-email').value,
          password: document.getElementById('signup-password').value
        })
      });
      token = data.token;
      localStorage.setItem('copilot_token', token);
      currentUser = data.user;
      showDashboard();
      showToast('Welcome to SenIQ! 🚀', 'success');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
      span.textContent = origText;
    }
  });
}


// ─── Dashboard ───────────────────────────────────────────────
async function showDashboard() {
  document.getElementById('auth-view').classList.add('hidden');
  document.getElementById('dashboard-view').classList.remove('hidden');

  // Set user info
  if (currentUser) {
    document.getElementById('user-name').textContent = currentUser.name;
    document.getElementById('user-avatar').textContent = currentUser.name.charAt(0).toUpperCase();
  }
  renderTierControl();

  // Load all data
  await Promise.all([loadPortfolio(), loadNewsFeed(), loadAlerts(), loadPortfolioSentiment(), loadImpactFeed(), loadDailyBrief(), loadSmartMoney()]);

  // Auto-refresh every 60s
  if (refreshInterval) clearInterval(refreshInterval);
  refreshInterval = setInterval(() => {
    loadNewsFeed(); loadAlerts(); loadPortfolioSentiment(); loadImpactFeed(); loadSmartMoney();
  }, 60000);
}

// ─── Portfolio ───────────────────────────────────────────────
let holdings = [];

async function loadPortfolio() {
  try {
    const data = await api('/api/portfolio');
    holdings = data.holdings;
    document.getElementById('holdings-count').textContent = holdings.length;
    renderHoldings();
  } catch (err) {
    console.error('Portfolio load error:', err);
  }
}

function renderHoldings() {
  const grid = document.getElementById('holdings-grid');

  if (holdings.length === 0) {
    grid.innerHTML = `
      <tr><td class="empty-state-td" colspan="6">
        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" opacity="0.3">
          <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5"/>
        </svg>
        <p style="margin-top:10px;font-size:.88rem">No holdings yet — add your first asset above.</p>
      </td></tr>`;
    return;
  }

  grid.innerHTML = holdings.map(h => {
    let rowClass = '';
    if (activeFilter) {
      rowClass = h.ticker === activeFilter ? 'row-active' : 'row-dimmed';
    }
    const cls = h.asset_class || 'equity';
    const clsLabel = { equity: 'Equity', crypto: 'Crypto', commodity: 'Commodity' }[cls] || cls;
    const exposure = h.weight_pct != null
      ? `${h.weight_pct}%`
      : h.quantity != null ? `${h.quantity} units` : '—';
    const priceInline = h.price != null
      ? `<span class="ht-price">${fmtUsd(h.price)}${h.change_pct != null
          ? ` <span class="ht-chg ${h.change_pct >= 0 ? 'up' : 'down'}">${h.change_pct >= 0 ? '▲' : '▼'}${Math.abs(h.change_pct).toFixed(2)}%</span>`
          : ''}</span>`
      : '<span class="ht-price muted">—</span>';
    return `
    <tr class="${rowClass}" data-ticker="${h.ticker}" onclick="toggleFilter('${h.ticker}')">
      <td>
        <div class="ht-ticker">${h.ticker} <span class="asset-class-badge ${cls}">${clsLabel}</span> ${priceInline}</div>
        <div class="ht-name">${h.company_name || h.ticker}</div>
      </td>
      <td class="ht-exposure">${exposure}</td>
      <td><span class="ht-senti-label neutral" id="senti-label-${h.ticker}">—</span></td>
      <td><span class="ht-score neutral" id="score-${h.ticker}">—</span></td>
      <td><span class="ht-headline" id="headline-${h.ticker}">—</span></td>
      <td class="ht-actions">
        <button class="ht-info" onclick="event.stopPropagation(); openBriefFor('${h.ticker}')" title="Company brief">ℹ</button>
        <button class="ht-remove" onclick="event.stopPropagation(); removeStock('${h.ticker}')" title="Remove">×</button>
      </td>
    </tr>
  `}).join('');
}

// ─── Filter Logic ────────────────────────────────────────────
function toggleFilter(ticker) {
  if (activeFilter === ticker) {
    clearFilter();
  } else {
    setFilter(ticker);
  }
}

function setFilter(ticker) {
  activeFilter = ticker;
  document.getElementById('filter-bar').classList.remove('hidden');
  document.getElementById('filter-ticker-label').textContent = ticker;
  renderHoldings();
  applyFilterToViews();

  setTimeout(() => {
    const row = document.querySelector(`tr[data-ticker="${ticker}"]`);
    if (row) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, 50);
}

function clearFilter() {
  activeFilter = null;
  document.getElementById('filter-bar').classList.add('hidden');
  document.getElementById('ticker-search').value = '';
  renderHoldings();
  applyFilterToViews();
}

function applyFilterToViews() {
  renderFilteredNews();
  renderFilteredAlerts();
  renderFilteredSentiment();
  renderDashboardSummary();
}

// ─── Ticker Search Filter ────────────────────────────────────
function initTickerSearch() {
  const input = document.getElementById('ticker-search');
  const dropdown = document.getElementById('ticker-search-dropdown');
  const wrapper = document.getElementById('ticker-search-wrapper');

  input.addEventListener('input', () => {
    const query = input.value.trim().toUpperCase();
    if (!query) {
      dropdown.classList.add('hidden');
      return;
    }

    const matches = holdings.filter(h =>
      h.ticker.includes(query) ||
      (h.company_name || '').toUpperCase().includes(query)
    );

    if (matches.length === 0) {
      dropdown.innerHTML = '<div class="search-no-results">No matching tickers</div>';
    } else {
      dropdown.innerHTML = matches.map(h => {
        const s = cachedSentiments[h.ticker];
        const scoreVal = s ? Math.round(s.score * 100) : '—';
        const scoreClass = s ? s.label : 'neutral';
        const isActive = activeFilter === h.ticker;
        return `
          <div class="search-result-item${isActive ? ' active-item' : ''}" onclick="selectSearchResult('${h.ticker}')">
            <div>
              <span class="search-result-ticker">${h.ticker}</span>
              <span class="search-result-name">${h.company_name || ''}</span>
            </div>
            <span class="search-result-score sentiment-score ${scoreClass}">${scoreVal}${s ? '%' : ''}</span>
          </div>
        `;
      }).join('');
    }
    dropdown.classList.remove('hidden');
  });

  input.addEventListener('focus', () => {
    if (input.value.trim()) {
      input.dispatchEvent(new Event('input'));
    } else if (holdings.length > 0) {
      // Show all holdings on focus with empty input
      dropdown.innerHTML = holdings.map(h => {
        const s = cachedSentiments[h.ticker];
        const scoreVal = s ? Math.round(s.score * 100) : '—';
        const scoreClass = s ? s.label : 'neutral';
        const isActive = activeFilter === h.ticker;
        return `
          <div class="search-result-item${isActive ? ' active-item' : ''}" onclick="selectSearchResult('${h.ticker}')">
            <div>
              <span class="search-result-ticker">${h.ticker}</span>
              <span class="search-result-name">${h.company_name || ''}</span>
            </div>
            <span class="search-result-score sentiment-score ${scoreClass}">${scoreVal}${s ? '%' : ''}</span>
          </div>
        `;
      }).join('');
      dropdown.classList.remove('hidden');
    }
  });

  // Close dropdown when clicking outside
  document.addEventListener('click', (e) => {
    if (!wrapper.contains(e.target)) {
      dropdown.classList.add('hidden');
    }
  });

  // Enter key applies first match
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      const query = input.value.trim().toUpperCase();
      const match = holdings.find(h => h.ticker === query);
      if (match) {
        selectSearchResult(match.ticker);
      } else {
        const fuzzy = holdings.find(h =>
          h.ticker.includes(query) ||
          (h.company_name || '').toUpperCase().includes(query)
        );
        if (fuzzy) selectSearchResult(fuzzy.ticker);
      }
    } else if (e.key === 'Escape') {
      dropdown.classList.add('hidden');
      input.blur();
    }
  });
}

function selectSearchResult(ticker) {
  const input = document.getElementById('ticker-search');
  const dropdown = document.getElementById('ticker-search-dropdown');
  input.value = '';
  dropdown.classList.add('hidden');
  setFilter(ticker);

  const row = document.querySelector(`tr[data-ticker="${ticker}"]`);
  if (row) row.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

async function addStock(ticker, opts = {}) {
  // Optimistic: immediately show the card
  ticker = ticker.toUpperCase().trim();
  if (holdings.some(h => h.ticker === ticker)) {
    showToast(`${ticker} already in portfolio`, 'error');
    return;
  }
  const assetClass = opts.assetClass || assetClassOf(ticker);
  const quantity = opts.quantity ?? null;
  const costBasis = opts.costBasis ?? null;

  holdings.unshift({ ticker, company_name: ticker, asset_class: assetClass, quantity, id: Date.now() });
  document.getElementById('holdings-count').textContent = holdings.length;
  renderHoldings();
  closeModal();
  showToast(`${ticker} added to portfolio!`, 'success');

  // Background: persist + load sentiment
  try {
    const res = await api('/api/portfolio', {
      method: 'POST',
      body: JSON.stringify({ ticker, asset_class: assetClass, quantity, cost_basis: costBasis }),
    });
    // Update with real company name from server
    const h = holdings.find(h => h.ticker === ticker);
    if (h && res.holding) { h.company_name = res.holding.company_name; h.asset_class = res.holding.asset_class; }
    renderHoldings();
    // E4 onboarding: pop the company brief returned on add (best-effort).
    if (res.brief) showBrief(res.brief);
    // Refresh sentiment & news in parallel (non-blocking)
    loadPortfolioSentiment();
    loadNewsFeed();
  } catch (err) {
    // Rollback optimistic add
    holdings = holdings.filter(h => h.ticker !== ticker);
    document.getElementById('holdings-count').textContent = holdings.length;
    renderHoldings();
    showToast(err.message, 'error');
  }
}

async function removeStock(ticker) {
  // Optimistic: immediately remove the card
  const removed = holdings.find(h => h.ticker === ticker);
  holdings = holdings.filter(h => h.ticker !== ticker);
  document.getElementById('holdings-count').textContent = holdings.length;
  renderHoldings();
  showToast(`${ticker} removed`, 'info');

  try {
    await api(`/api/portfolio/${ticker}`, { method: 'DELETE' });
    loadPortfolioSentiment();
  } catch (err) {
    // Rollback
    if (removed) holdings.push(removed);
    document.getElementById('holdings-count').textContent = holdings.length;
    renderHoldings();
    showToast(err.message, 'error');
  }
}

// ─── News Feed ───────────────────────────────────────────────
async function loadNewsFeed() {
  try {
    const data = await api('/api/news/feed');
    cachedArticles = data.articles || [];
    cachedBuckets = data.buckets || { holdings: [], market: [], world: [] };
    renderFilteredNews();
    renderDashboardSummary();
  } catch (err) {
    console.error('News feed error:', err);
  }
}

// One news card. Shows a "+N sources" badge when several outlets covered the same
// event (de-spam: the duplicates are collapsed into this one card).
function renderNewsItem(a) {
  const time = timeAgo(new Date(a.published_at));
  const tickers = (a.matchedTickers || []).filter(t => t !== '__MARKET__').slice(0, 3);
  const sources = a.source_count > 1 ? `<span class="news-source-count">+${a.source_count - 1} more</span>` : '';
  const score = Math.round(a.sentiment.score * 100);
  const impactSign = a.sentiment.label === 'positive' ? '+' : a.sentiment.label === 'negative' ? '−' : '';
  const impactVal = a.sentiment.label === 'negative' ? 100 - score : score;
  return `
    <div class="news-item">
      <div class="news-sentiment-dot ${a.sentiment.label}"></div>
      <div class="news-content">
        <div class="news-title">${a.url
          ? `<a href="${escapeHtml(a.url)}" target="_blank" rel="noopener noreferrer" class="news-title-link">${escapeHtml(a.title)}</a>`
          : escapeHtml(a.title)}</div>
        <div class="news-meta">
          ${tickers.map(t => `<span class="news-ticker">${t}</span>`).join('')}
          <span>${escapeHtml(a.source || '')}</span>
          ${sources}
          <span>${time}</span>
        </div>
        <div class="news-impact-row">
          <span class="ni-label">Impact</span>
          <span class="ni-score ${a.sentiment.label}">${impactSign}${impactVal}</span>
          <span class="ni-sep">·</span>
          <span class="ni-conf">Confidence ${score}%</span>
        </div>
      </div>
    </div>`;
}

function renderFilteredNews() {
  const feed = document.getElementById('news-feed');
  const viewAllBtn = document.getElementById('news-view-all');

  // Search / ticker filter → flat list across all buckets (existing behavior).
  if (activeFilter || newsSearchQuery) {
    let articles = cachedArticles;
    if (activeFilter) articles = articles.filter(a => (a.matchedTickers || []).includes(activeFilter));
    if (newsSearchQuery) {
      const q = newsSearchQuery.toLowerCase();
      articles = articles.filter(a =>
        a.title.toLowerCase().includes(q) ||
        (a.source || '').toLowerCase().includes(q) ||
        (a.matchedTickers || []).some(t => t.toLowerCase().includes(q)));
    }
    document.getElementById('news-count').textContent = articles.length;
    feed.innerHTML = articles.length
      ? articles.map(renderNewsItem).join('')
      : `<div class="empty-state small"><p>${newsSearchQuery ? `No results for "${newsSearchQuery}"` : `No news for ${activeFilter}.`}</p></div>`;
    viewAllBtn.classList.add('hidden');
    return;
  }

  // Default view: three buckets — Your Holdings / Markets / World.
  const total = cachedBuckets.holdings.length + cachedBuckets.market.length + cachedBuckets.world.length;
  document.getElementById('news-count').textContent = total;

  if (total === 0) {
    feed.innerHTML = `<div class="empty-state small"><p>No relevant news yet — the next pipeline run will populate your feed.</p></div>`;
    viewAllBtn.classList.add('hidden');
    return;
  }

  const PER_BUCKET = newsExpanded ? 50 : 4;
  const section = (label, sub, items) => {
    if (!items.length) return '';
    const shown = items.slice(0, PER_BUCKET);
    const more = items.length > PER_BUCKET ? `<span class="news-bucket-more">+${items.length - PER_BUCKET}</span>` : '';
    return `
      <div class="news-bucket">
        <div class="news-bucket-header">
          <span class="news-bucket-label">${label}</span>
          <span class="news-bucket-sub">${sub}</span>
          <span class="news-bucket-count">${items.length}${more}</span>
        </div>
        ${shown.map(renderNewsItem).join('')}
      </div>`;
  };

  feed.innerHTML =
    section('Your Holdings', 'news about what you own', cachedBuckets.holdings) +
    section('Markets', 'broad market-moving news', cachedBuckets.market) +
    section('World', 'major world affairs', cachedBuckets.world);

  // View All toggles the per-bucket cap.
  const capped = !newsExpanded && [cachedBuckets.holdings, cachedBuckets.market, cachedBuckets.world].some(b => b.length > 4);
  if (capped || newsExpanded) {
    viewAllBtn.classList.remove('hidden');
    viewAllBtn.classList.toggle('expanded', newsExpanded);
    document.getElementById('news-view-all-label').textContent = newsExpanded ? 'Show Less' : `View All (${total})`;
  } else {
    viewAllBtn.classList.add('hidden');
  }
}

// ─── Alerts ──────────────────────────────────────────────────
async function loadAlerts() {
  try {
    const data = await api('/api/news/alerts');
    cachedAlerts = data.alerts || [];
    renderFilteredAlerts();
    renderDashboardSummary();
  } catch (err) {
    console.error('Alerts error:', err);
  }
}

async function markAllRead() {
  const hadUnread = cachedAlerts.some(a => !a.read);
  if (!hadUnread) return;
  // Optimistic: flip local state + re-render immediately.
  cachedAlerts = cachedAlerts.map(a => ({ ...a, read: true }));
  renderFilteredAlerts();
  try {
    await api('/api/news/alerts/read-all', { method: 'PUT' });
    showToast('All alerts marked as read', 'success');
  } catch (err) {
    loadAlerts(); // rollback to server truth
    showToast(err.message, 'error');
  }
}

function renderFilteredAlerts() {
  const feed = document.getElementById('alerts-feed');
  const viewAllBtn = document.getElementById('alerts-view-all');
  let alerts = cachedAlerts;

  if (activeFilter) {
    alerts = alerts.filter(a => a.ticker === activeFilter || a.ticker === 'MARKET');
  }

  const unread = alerts.filter(a => !a.read).length;
  document.getElementById('alerts-count').textContent = alerts.length;
  document.getElementById('alerts-unread').textContent = `${unread} unread`;
  document.getElementById('alert-badge').textContent = `${unread} new`;
  document.getElementById('mark-all-read-btn').classList.toggle('hidden', unread === 0);

  if (alerts.length === 0) {
    feed.innerHTML = `<div class="empty-state small"><p>${activeFilter ? `No alerts for ${activeFilter}.` : 'No alerts yet.'}</p></div>`;
    viewAllBtn.classList.add('hidden');
    return;
  }

  const LIMIT = 10;
  const showAll = alertsExpanded || alerts.length <= LIMIT;
  const visible = showAll ? alerts : alerts.slice(0, LIMIT);

  feed.innerHTML = visible.map(a => {
    const urgency = a.alert_type.includes('negative') ? 'high' : a.alert_type.includes('positive') ? 'medium' : 'low';
    const msg = a.article_url
      ? `<a href="${escapeHtml(a.article_url)}" target="_blank" rel="noopener noreferrer" class="alert-title-link">${escapeHtml(a.message)}</a>`
      : escapeHtml(a.message);
    return `
      <div class="alert-item ${urgency}${a.read ? ' read' : ''}">
        <div>${msg}</div>
        <div class="alert-time">${timeAgo(new Date(a.created_at))}</div>
      </div>
    `;
  }).join('');

  if (alerts.length > LIMIT) {
    viewAllBtn.classList.remove('hidden');
    viewAllBtn.classList.toggle('expanded', alertsExpanded);
    document.getElementById('alerts-view-all-label').textContent = alertsExpanded ? 'Show Less' : `View All Alerts (${alerts.length})`;
  } else {
    viewAllBtn.classList.add('hidden');
  }
}

// ─── Portfolio Sentiment ─────────────────────────────────────
async function loadPortfolioSentiment() {
  try {
    const data = await api('/api/news/portfolio-sentiment');
    cachedSentiments = data.sentiments || {};
    cachedOverallScore = data.overallScore || 50;

    // Update individual holding rows (always, regardless of filter)
    for (const [ticker, s] of Object.entries(cachedSentiments)) {
      const sentiEl = document.getElementById(`senti-label-${ticker}`);
      const scoreEl = document.getElementById(`score-${ticker}`);
      const headlineEl = document.getElementById(`headline-${ticker}`);
      if (sentiEl) {
        const lbl = s.label === 'positive' ? 'Bullish' : s.label === 'negative' ? 'Bearish' : 'Neutral';
        sentiEl.textContent = lbl;
        sentiEl.className = `ht-senti-label ${s.label}`;
      }
      if (scoreEl) {
        scoreEl.textContent = Math.round(s.score * 100);
        scoreEl.className = `ht-score ${s.label}`;
      }
      if (headlineEl) {
        headlineEl.textContent = s.recentHeadline || '—';
      }
    }

    renderFilteredSentiment();
  } catch (err) {
    console.error('Sentiment error:', err);
  }
}

// ─── Portfolio Impact (North Star) ───────────────────────────
const DIR_ICON = { positive: '▲', negative: '▼', neutral: '■' };

async function loadImpactFeed() {
  try {
    const data = await api('/api/news/impact');
    renderImpactFeed(data.topEvent, data.feed || []);
    // Append (or refresh) the gating note on the impact section.
    const sect = document.getElementById('impact-section');
    sect?.querySelector('.upgrade-note')?.remove();
    if (data.gated && sect) sect.insertAdjacentHTML('beforeend', upgradeNote('Free shows today’s top event only — see the full ranked feed on Plus.'));
  } catch (err) {
    console.error('Impact feed error:', err);
  }
}

function renderImpactFeed(top, feed) {
  const hero = document.getElementById('impact-hero');
  const list = document.getElementById('impact-list');
  if (!hero) return;

  if (!top) {
    hero.innerHTML = '<div class="empty-state"><p>No portfolio-impacting events yet. They appear after the pipeline scores recent news for your holdings.</p></div>';
    if (list) list.innerHTML = '';
    return;
  }

  const dir = top.direction || 'neutral';
  const hasUrl = (u) => u && u !== '#';
  const topTitle = hasUrl(top.url)
    ? `<a class="impact-hero-title" href="${escapeHtml(top.url)}" target="_blank" rel="noopener">${escapeHtml(top.title)}</a>`
    : `<span class="impact-hero-title no-link">${escapeHtml(top.title)}</span>`;
  hero.innerHTML = `
    <div class="impact-hero-tag">Most important event for you</div>
    ${topTitle}
    <div class="impact-hero-meta">
      <span class="impact-dir ${dir}">${DIR_ICON[dir]} ${dir}</span>
      <span class="impact-exposure">${top.exposure_pct}% of your exposure</span>
      <span class="impact-source">${escapeHtml(top.source || top.platform || '')}</span>
      <span class="impact-time">${timeAgo(new Date(top.published_at))}</span>
    </div>`;

  if (list) list.innerHTML = feed.slice(1).map(e => {
    const d = e.direction || 'neutral';
    const inner = `
        <span class="impact-dir ${d}">${DIR_ICON[d]}</span>
        <span class="impact-row-title">${escapeHtml(e.title)}</span>
        <span class="impact-row-exposure">${e.exposure_pct}%</span>`;
    return hasUrl(e.url)
      ? `<a class="impact-row glass" href="${escapeHtml(e.url)}" target="_blank" rel="noopener">${inner}</a>`
      : `<div class="impact-row glass no-link">${inner}</div>`;
  }).join('');
}  // end renderImpactFeed

function renderFilteredSentiment() {
  let score, label, sentimentsForChart;

  if (activeFilter && cachedSentiments[activeFilter]) {
    // Show single ticker's score as the KPI
    const s = cachedSentiments[activeFilter];
    score = Math.round(s.score * 100);
    sentimentsForChart = { [activeFilter]: s };
  } else {
    score = cachedOverallScore;
    sentimentsForChart = cachedSentiments;
  }

  label = score > 65 ? 'Bullish' : score < 35 ? 'Bearish' : 'Neutral';

  document.getElementById('portfolio-score').textContent = score;
  const labelEl = document.getElementById('portfolio-score-label');
  labelEl.textContent = activeFilter ? `${activeFilter} — ${label}` : label;
  labelEl.style.color = score > 65 ? 'var(--positive)' : score < 35 ? 'var(--negative)' : 'var(--neutral)';

  // Animate ring
  const circle = document.getElementById('score-circle');
  if (circle) {
    const circumference = 327;
    const offset = circumference - (score / 100) * circumference;
    circle.style.strokeDashoffset = offset;
    circle.style.transition = 'stroke-dashoffset 1.5s ease';
  }

  updateSentimentChart(sentimentsForChart);
}

// ─── Sentiment Chart ─────────────────────────────────────────
function updateSentimentChart(sentiments) {
  const ctx = document.getElementById('sentiment-chart');
  if (!ctx) return;

  const tickers = Object.keys(sentiments);
  const scores = tickers.map(t => Math.round(sentiments[t].score * 100));
  const colors = tickers.map(t => {
    const s = sentiments[t].score;
    return s > 0.6 ? 'rgba(16,185,129,0.8)' : s < 0.4 ? 'rgba(239,68,68,0.8)' : 'rgba(245,158,11,0.8)';
  });
  const borderColors = tickers.map(t => {
    const s = sentiments[t].score;
    return s > 0.6 ? '#10b981' : s < 0.4 ? '#ef4444' : '#f59e0b';
  });

  if (sentimentChart) sentimentChart.destroy();

  sentimentChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: tickers,
      datasets: [{
        label: 'Sentiment Score',
        data: scores,
        backgroundColor: colors,
        borderColor: borderColors,
        borderWidth: 2,
        borderRadius: 8,
        borderSkipped: false,
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: 'rgba(17,17,32,0.95)',
          titleColor: '#e2e2e8',
          bodyColor: '#a0a0b0',
          borderColor: 'rgba(255,45,120,0.3)',
          borderWidth: 1,
          cornerRadius: 8,
          padding: 12,
          callbacks: { label: (ctx) => `Sentiment: ${ctx.raw}%` }
        }
      },
      scales: {
        y: {
          min: 0, max: 100,
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#666677', font: { family: 'Sora' } }
        },
        x: {
          grid: { display: false },
          ticks: { color: '#a0a0b0', font: { family: 'Sora', weight: 600 } }
        }
      },
      animation: { duration: 1200, easing: 'easeOutQuart' }
    }
  });
}

// ─── Sentiment Analyzer ──────────────────────────────────────
function initAnalyzer() {
  const btn = document.getElementById('analyze-btn');

  btn.addEventListener('click', async () => {
    const text = document.getElementById('analyze-input').value.trim();
    if (!text) return showToast('Enter a headline, URL, or article text', 'error');

    btn.disabled = true;
    btn.textContent = 'Analyzing...';
    const resultEl = document.getElementById('analyze-result');
    resultEl.classList.add('hidden');

    try {
      const data = await api('/api/news/analyze', { method: 'POST', body: JSON.stringify({ text }) });
      const { sentiment, matchedTickers, summary, articleTitle, llmExplanation } = data;
      // Convert 0–1 score to a readable strength: negative maps 0→100%, positive maps 0→100%
      const strength = sentiment.label === 'negative'
        ? Math.round((1 - sentiment.score) * 100)
        : sentiment.label === 'positive'
          ? Math.round(sentiment.score * 100)
          : Math.round((1 - Math.abs(sentiment.score - 0.5) * 2) * 100);
      const visibleTickers = matchedTickers.filter(t => t !== '__MARKET__');

      resultEl.innerHTML = `
        ${articleTitle ? `<div class="result-article-title">${escapeHtml(articleTitle)}</div>` : ''}
        <div class="result-label ${sentiment.label}">${sentiment.label.toUpperCase()} — ${strength}%</div>
        <div class="result-score">Confidence: ${Math.round(sentiment.confidence * 100)}% | ${sentiment.details?.positiveWords || 0} positive, ${sentiment.details?.negativeWords || 0} negative words</div>
        ${summary ? `<div class="result-summary"><strong>Summary:</strong> ${escapeHtml(summary)}</div>` : ''}
        <div class="result-explanation">✨ <strong>AI Analysis:</strong> ${escapeHtml(llmExplanation || sentiment.explanation || '')}</div>
        ${visibleTickers.length > 0 ? `<div class="result-tickers">Matched: ${visibleTickers.map(t => `<span class="news-ticker">${escapeHtml(t)}</span>`).join(' ')}</div>` : ''}
      `;
      resultEl.classList.remove('hidden');
    } catch (err) {
      showToast(err.message, 'error');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Analyze Sentiment';
    }
  });
}

// ─── Modal ───────────────────────────────────────────────────
function initModal() {
  const modal = document.getElementById('add-stock-modal');
  const input = document.getElementById('stock-ticker');
  const autocomplete = document.getElementById('asset-autocomplete');

  document.getElementById('add-stock-btn').addEventListener('click', () => { modal.classList.remove('hidden'); input.focus(); });
  document.getElementById('modal-close').addEventListener('click', closeModal);
  document.getElementById('modal-cancel').addEventListener('click', closeModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeModal(); });

  // Commit the modal: resolve the typed value to a ticker, read class + size, add.
  function commitAdd() {
    const val = input.value.trim();
    if (!val) return;
    const exactMatch = ASSET_DB.find(a => a.ticker.toLowerCase() === val.toLowerCase() || a.name.toLowerCase() === val.toLowerCase());
    const ticker = exactMatch ? exactMatch.ticker : val.toUpperCase();

    const qtyRaw = document.getElementById('asset-quantity').value.trim();
    const costRaw = document.getElementById('asset-cost-basis').value.trim();
    addStock(ticker, {
      assetClass: document.getElementById('asset-class').value,
      quantity: qtyRaw === '' ? null : Number(qtyRaw),
      costBasis: costRaw === '' ? null : Number(costRaw),
    });
  }

  document.getElementById('modal-add').addEventListener('click', commitAdd);

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commitAdd();
    } else if (e.key === 'Escape') {
      autocomplete.classList.add('hidden');
    }
  });

  // Smart autocomplete
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    if (!q) { autocomplete.classList.add('hidden'); return; }

    const matches = ASSET_DB.filter(a =>
      a.ticker.toLowerCase().includes(q) ||
      a.name.toLowerCase().includes(q) ||
      a.market.toLowerCase().includes(q)
    ).slice(0, 8);

    if (matches.length === 0) {
      autocomplete.innerHTML = '<div class="asset-no-results">No matching assets found. Press Enter to add custom ticker.</div>';
    } else {
      autocomplete.innerHTML = matches.map(a => {
        const inPortfolio = holdings.some(h => h.ticker === a.ticker);
        return `
          <div class="asset-item${inPortfolio ? ' dimmed' : ''}" onclick="${inPortfolio ? '' : `selectAsset('${a.ticker}')`}">
            <div class="asset-item-left">
              <div class="asset-item-icon ${a.type}">${a.ticker.slice(0,2)}</div>
              <div>
                <div class="asset-item-name">${a.name}</div>
                <div class="asset-item-ticker">${a.ticker}${inPortfolio ? ' • In portfolio' : ''}</div>
              </div>
            </div>
            <span class="asset-type-badge ${a.type}">${a.market}</span>
          </div>
        `;
      }).join('');
    }
    autocomplete.classList.remove('hidden');
  });

  input.addEventListener('focus', () => {
    if (input.value.trim()) input.dispatchEvent(new Event('input'));
  });

  // Close autocomplete on outside click
  modal.addEventListener('click', (e) => {
    if (!e.target.closest('.form-group')) autocomplete.classList.add('hidden');
  });

  // Quick add chips prefill the form (so a quantity can still be entered).
  document.querySelectorAll('.chip[data-ticker]').forEach(chip => {
    chip.addEventListener('click', () => selectAsset(chip.dataset.ticker));
  });
}

// Prefill the modal from an autocomplete/chip pick; the user adds via Enter/button.
function selectAsset(ticker) {
  const t = ticker.toUpperCase();
  document.getElementById('stock-ticker').value = t;
  document.getElementById('asset-class').value = assetClassOf(t);
  document.getElementById('asset-autocomplete').classList.add('hidden');
  document.getElementById('asset-quantity').focus();
}

function closeModal() {
  document.getElementById('add-stock-modal').classList.add('hidden');
  document.getElementById('stock-ticker').value = '';
  document.getElementById('asset-quantity').value = '';
  document.getElementById('asset-cost-basis').value = '';
  document.getElementById('asset-class').value = 'equity';
  document.getElementById('asset-autocomplete').classList.add('hidden');
}

// ─── User Menu ───────────────────────────────────────────────
let previousPage = 'dashboard';

function initUserMenu() {
  const btn = document.getElementById('user-menu-btn');
  const dropdown = document.getElementById('user-dropdown');

  btn.addEventListener('click', (e) => { e.stopPropagation(); dropdown.classList.toggle('hidden'); });
  document.addEventListener('click', () => dropdown.classList.add('hidden'));

  document.getElementById('profile-btn').addEventListener('click', () => {
    // Remember where we came from so Back can return there.
    const active = document.querySelector('.main-tab.active');
    previousPage = active ? active.dataset.page : 'dashboard';
    openProfilePage();
  });

  document.getElementById('profile-back-btn').addEventListener('click', () => {
    switchToPage(previousPage);
  });

  document.getElementById('logout-btn').addEventListener('click', () => {
    token = null; currentUser = null;
    localStorage.removeItem('copilot_token');
    if (refreshInterval) clearInterval(refreshInterval);
    document.getElementById('dashboard-view').classList.add('hidden');
    document.getElementById('auth-view').classList.remove('hidden');
    showToast('Signed out', 'info');
  });

  document.getElementById('refresh-btn').addEventListener('click', async () => {
    showToast('Refreshing data...', 'info');
    await Promise.all([loadNewsFeed(), loadAlerts(), loadPortfolioSentiment()]);
    showToast('Data refreshed!', 'success');
  });

  // Password visibility toggles on profile page
  document.querySelectorAll('.pw-toggle[data-target]').forEach(toggle => {
    toggle.addEventListener('click', () => {
      const input = document.getElementById(toggle.dataset.target);
      if (!input) return;
      const isHidden = input.type === 'password';
      input.type = isHidden ? 'text' : 'password';
      toggle.querySelector('.material-symbols-outlined').textContent = isHidden ? 'visibility_off' : 'visibility';
    });
  });

  // Save name
  document.getElementById('profile-save-btn').addEventListener('click', async () => {
    const nameInput = document.getElementById('profile-name-input');
    const msgEl = document.getElementById('profile-name-msg');
    const name = nameInput.value.trim();
    if (!name) return showProfileMsg(msgEl, 'Name cannot be empty', 'error');
    try {
      document.getElementById('profile-save-btn').disabled = true;
      const { user } = await api('/api/auth/me', { method: 'PATCH', body: JSON.stringify({ name }) });
      currentUser = user;
      populateProfilePage(user);
      document.getElementById('user-name').textContent = user.name;
      document.getElementById('user-avatar').textContent = user.name[0].toUpperCase();
      showProfileMsg(msgEl, 'Name updated successfully', 'success');
    } catch (err) {
      showProfileMsg(msgEl, err.message, 'error');
    } finally {
      document.getElementById('profile-save-btn').disabled = false;
    }
  });

  // Change password
  document.getElementById('profile-pw-btn').addEventListener('click', async () => {
    const cur = document.getElementById('profile-cur-pw').value;
    const nw = document.getElementById('profile-new-pw').value;
    const conf = document.getElementById('profile-confirm-pw').value;
    const msgEl = document.getElementById('profile-pw-msg');
    if (!cur || !nw || !conf) return showProfileMsg(msgEl, 'All password fields are required', 'error');
    if (nw !== conf) return showProfileMsg(msgEl, 'New passwords do not match', 'error');
    if (nw.length < 6) return showProfileMsg(msgEl, 'New password must be at least 6 characters', 'error');
    try {
      document.getElementById('profile-pw-btn').disabled = true;
      await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ currentPassword: cur, newPassword: nw }) });
      document.getElementById('profile-cur-pw').value = '';
      document.getElementById('profile-new-pw').value = '';
      document.getElementById('profile-confirm-pw').value = '';
      showProfileMsg(msgEl, 'Password changed successfully', 'success');
    } catch (err) {
      showProfileMsg(msgEl, err.message, 'error');
    } finally {
      document.getElementById('profile-pw-btn').disabled = false;
    }
  });
}

function showProfileMsg(el, text, type) {
  el.textContent = text;
  el.className = `profile-msg ${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

function openProfilePage() {
  document.querySelectorAll('.main-tab').forEach(t => t.classList.remove('active'));
  document.querySelectorAll('.page').forEach(p => p.classList.add('hidden'));
  document.getElementById('page-profile').classList.remove('hidden');
  populateProfilePage(currentUser);
  loadPlans();
  loadApiKeys();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function populateProfilePage(user) {
  if (!user) return;
  const initial = (user.name || user.email || 'U')[0].toUpperCase();
  document.getElementById('profile-avatar-lg').textContent = initial;
  document.getElementById('profile-hero-name').textContent = user.name || '—';
  document.getElementById('profile-hero-email').textContent = user.email || '';
  document.getElementById('profile-name-input').value = user.name || '';
  document.getElementById('profile-email-display').value = user.email || '';
  if (user.created_at) {
    const d = new Date(user.created_at);
    document.getElementById('profile-since').textContent = d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
  }
}

// ─── Smart Money (Phase 3) ───────────────────────────────────
let congressScope = 'mine';
let cachedInstitutions = [];
let cachedCongress = [];
let instSearchQuery = '';
let congressSearchQuery = '';
let cachedFollows = new Set(); // `${type}:${ref}`
let openInstSlug = null;

const followKey = (type, ref) => `${type}:${ref}`;
// Normalize a politician name to the same key the server emitter uses.
const polKey = (name) => String(name).toLowerCase().replace(/[^a-z]+/g, '-').replace(/^-|-$/g, '');

function fmtMoney(v) {
  const n = Number(v) || 0;
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n}`;
}
function fmtDate(s) {
  if (!s) return '—';
  const d = new Date(s);
  return isNaN(d) ? '—' : d.toISOString().slice(0, 10);
}
function lagDays(a, b) {
  if (!a || !b) return null;
  const d = Math.round((new Date(b) - new Date(a)) / 86400000);
  return Number.isFinite(d) ? d : null;
}

async function loadSmartMoney() {
  await Promise.all([loadFollows(), loadInstitutions(), loadCongress(), loadSmartMoneyMeta()]);
}

async function loadFollows() {
  try {
    const { follows } = await api('/api/smart-money/follows');
    cachedFollows = new Set((follows || []).map(f => followKey(f.entity_type, f.entity_ref)));
  } catch (err) { console.error('Follows load error:', err); }
}

async function loadSmartMoneyMeta() {
  try {
    const meta = await api('/api/smart-money/meta');
    const badge = document.getElementById('congress-sample-badge');
    if (badge) badge.classList.toggle('hidden', !meta.congress?.usingSample);
  } catch (err) { /* non-fatal */ }
}

async function loadInstitutions() {
  try {
    const data = await api('/api/smart-money/institutions');
    cachedInstitutions = data.institutions || [];
    instTeaser = data.teaser ? { total: data.total } : null;
    renderInstitutions();
  } catch (err) { console.error('Institutions load error:', err); }
}

function renderInstitutions() {
  const grid = document.getElementById('inst-grid');
  if (!grid) return;
  if (cachedInstitutions.length === 0) {
    grid.innerHTML = '<div class="empty-state small"><p>No institutional filings ingested yet.</p></div>';
    return;
  }
  const q = instSearchQuery.toLowerCase();
  const shown = q
    ? cachedInstitutions.filter(i => `${i.name || ''} ${i.manager || ''}`.toLowerCase().includes(q))
    : cachedInstitutions;
  if (shown.length === 0) {
    grid.innerHTML = `<div class="empty-state small"><p>No fund matches “${escapeHtml(instSearchQuery)}”.</p></div>`;
    return;
  }
  grid.innerHTML = shown.map(i => {
    const following = cachedFollows.has(followKey('institution', i.slug));
    const period = i.period_of_report ? `${fmtDate(i.period_of_report)}` : 'no filing yet';
    const filed = i.filed_at ? `filed ${fmtDate(i.filed_at)}` : '';
    return `
      <div class="inst-card ${openInstSlug === i.slug ? 'active' : ''}" data-slug="${i.slug}" onclick="openInstitution('${i.slug}')">
        <div class="inst-card-top">
          <div class="inst-card-headings">
            <div class="inst-card-name">${escapeHtml(i.name)}</div>
            <div class="inst-card-manager">${escapeHtml(i.manager || '')}</div>
          </div>
          <button class="inst-follow ${following ? 'following' : ''}" data-slug="${i.slug}"
            onclick="event.stopPropagation(); toggleFollow('institution','${i.slug}', ${JSON.stringify(i.name).replace(/"/g, '&quot;')}, this)">
            ${following ? '✓ Following' : '+ Follow'}
          </button>
        </div>
        <div class="inst-card-meta">
          <span>${escapeHtml(period)}</span>
          <span>${escapeHtml(filed)}</span>
          ${i.holdings_count ? `<span><span class="val">${i.holdings_count}</span> holdings</span>` : ''}
          ${i.total_value ? `<span class="val">${fmtMoney(i.total_value)}</span>` : ''}
        </div>
      </div>`;
  }).join('');
  if (instTeaser && !instSearchQuery) {
    grid.insertAdjacentHTML('beforeend', upgradeNote(`Showing ${cachedInstitutions.length} of ${instTeaser.total} funds — unlock all on Plus.`));
  }
}

async function openInstitution(slug) {
  const detail = document.getElementById('inst-detail');
  if (openInstSlug === slug) { // toggle closed
    openInstSlug = null;
    detail.classList.add('hidden');
    renderInstitutions();
    return;
  }
  openInstSlug = slug;
  renderInstitutions();
  detail.classList.remove('hidden');
  detail.innerHTML = '<div class="loading-skeleton"><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>';
  try {
    const data = await api(`/api/smart-money/institutions/${slug}`);
    renderInstitutionDetail(data);
  } catch (err) {
    detail.innerHTML = `<div class="empty-state small"><p>${escapeHtml(err.message)}</p></div>`;
  }
}

function renderInstitutionDetail(data) {
  const detail = document.getElementById('inst-detail');
  const { institution, filing, holdings } = data;
  if (!filing) {
    detail.innerHTML = `<div class="empty-state small"><p>No 13F filing ingested yet for ${escapeHtml(institution.name)}.</p></div>`;
    return;
  }
  const rows = holdings.map(h => `
    <div class="holding-row">
      <span class="h-ticker">${escapeHtml(h.ticker || '—')}</span>
      <span class="h-issuer">${escapeHtml(h.issuer_name || '')}</span>
      <span class="h-pct">${(h.pct_of_portfolio || 0).toFixed(1)}%</span>
      <span class="change-badge ${h.change_type}">${h.change_type}</span>
    </div>`).join('');
  detail.innerHTML = `
    <div class="inst-detail-head">
      <h3>${escapeHtml(institution.name)} · ${escapeHtml(institution.manager || '')}</h3>
      <div class="inst-detail-dates">
        Quarter end <b>${fmtDate(filing.period_of_report)}</b> · Filed <b>${fmtDate(filing.filed_at)}</b>
        · ${filing.holdings_count} positions · ${fmtMoney(filing.total_value)}
      </div>
    </div>
    <div class="holdings-table">${rows || '<p class="empty-state small">No holdings parsed.</p>'}</div>`;
}

async function loadCongress() {
  try {
    const data = await api(`/api/smart-money/congress?scope=${congressScope}&limit=60`);
    cachedCongress = data.trades || [];
    congressTeaser = data.teaser ? { total: data.total } : null;
    renderCongress();
  } catch (err) { console.error('Congress load error:', err); }
}

function renderCongress() {
  const list = document.getElementById('congress-list');
  if (!list) return;
  if (cachedCongress.length === 0) {
    list.innerHTML = `<div class="empty-state small"><p>${congressScope === 'mine' ? 'No disclosures touching your holdings or followed politicians yet. Switch to "All" or follow someone.' : 'No congressional disclosures ingested yet.'}</p></div>`;
    return;
  }
  const q = congressSearchQuery.toLowerCase();
  const trades = q
    ? cachedCongress.filter(t => `${t.politician || ''} ${t.ticker || ''} ${t.asset_description || ''}`.toLowerCase().includes(q))
    : cachedCongress;
  if (trades.length === 0) {
    list.innerHTML = `<div class="empty-state small"><p>No disclosures match “${escapeHtml(congressSearchQuery)}”.</p></div>`;
    return;
  }
  list.innerHTML = trades.map(t => {
    const lag = lagDays(t.transaction_date, t.disclosure_date);
    const following = cachedFollows.has(followKey('politician', polKey(t.politician)));
    const where = [t.party, t.state].filter(Boolean).join('-');
    const side = t.transaction_type === 'sell' ? 'sell' : t.transaction_type === 'exchange' ? 'exchange' : 'buy';
    return `
      <div class="congress-item">
        <span class="trade-side ${side}">${side}</span>
        <div class="congress-main">
          <div class="congress-pol">${escapeHtml(t.politician)} <span class="pol-meta">${where ? `(${escapeHtml(where)})` : ''} · ${t.chamber}</span></div>
          <div class="congress-sub">
            ${t.ticker ? `<span class="ct-ticker">${escapeHtml(t.ticker)}</span> — ` : ''}${escapeHtml(t.asset_description || '')}${t.amount_range ? ` · ${escapeHtml(t.amount_range)}` : ''}
          </div>
        </div>
        <div class="congress-dates">
          traded ${fmtDate(t.transaction_date)}<br>
          disclosed ${fmtDate(t.disclosure_date)}${lag != null ? ` <span class="lag">(+${lag}d)</span>` : ''}
        </div>
        <button class="congress-follow ${following ? 'following' : ''}"
          onclick="toggleFollow('politician', '${polKey(t.politician)}', ${JSON.stringify(t.politician).replace(/"/g, '&quot;')}, this)">
          ${following ? '✓' : '+'}
        </button>
      </div>`;
  }).join('');
  if (congressTeaser && !congressSearchQuery) {
    list.insertAdjacentHTML('beforeend', upgradeNote(`Showing ${cachedCongress.length} of ${congressTeaser.total} disclosures — unlock the full feed on Plus.`));
  }
}

async function toggleFollow(type, ref, label, btnEl) {
  const key = followKey(type, ref);
  const isFollowing = cachedFollows.has(key);
  try {
    if (isFollowing) {
      await api(`/api/smart-money/follow/${type}/${encodeURIComponent(ref)}`, { method: 'DELETE' });
      cachedFollows.delete(key);
      showToast(`Unfollowed ${label}`, 'info');
    } else {
      await api('/api/smart-money/follow', { method: 'POST', body: JSON.stringify({ entity_type: type, entity_ref: type === 'institution' ? ref : label, label }) });
      cachedFollows.add(key);
      showToast(`Following ${label}`, 'success');
    }
    renderInstitutions();
    // A follow change affects the congress "mine" scope — refresh it if visible.
    if (!document.getElementById('page-congress')?.classList.contains('hidden')) loadCongress();
  } catch (err) { showToast(err.message, 'error'); }
}

// Webhooks
async function loadWebhooks() {
  try {
    const { webhooks } = await api('/api/smart-money/webhooks');
    const list = document.getElementById('webhook-list');
    list.innerHTML = (webhooks || []).map(w => `
      <div class="webhook-row">
        <span class="wh-url">${escapeHtml(w.url)}</span>
        <span class="wh-status">${w.active ? (w.last_status ? `last ${w.last_status}` : 'active') : 'disabled'}</span>
        <button class="webhook-del" onclick="deleteWebhook(${w.id})" title="Delete">&times;</button>
      </div>`).join('') || '<p class="form-hint">No webhooks yet.</p>';
  } catch (err) { console.error('Webhooks load error:', err); }
}

async function addWebhook() {
  const input = document.getElementById('webhook-url');
  const url = input.value.trim();
  if (!url) return showToast('Enter a webhook URL', 'error');
  try {
    const { webhook } = await api('/api/smart-money/webhooks', { method: 'POST', body: JSON.stringify({ url }) });
    input.value = '';
    showToast('Webhook added', 'success');
    await loadWebhooks();
    // Show the signing secret once (it isn't retrievable later).
    const list = document.getElementById('webhook-list');
    const note = document.createElement('div');
    note.className = 'webhook-secret';
    note.textContent = `Signing secret (shown once): ${webhook.secret}`;
    list.prepend(note);
  } catch (err) { showToast(err.message, 'error'); }
}

async function deleteWebhook(id) {
  try {
    await api(`/api/smart-money/webhooks/${id}`, { method: 'DELETE' });
    showToast('Webhook removed', 'info');
    loadWebhooks();
  } catch (err) { showToast(err.message, 'error'); }
}

// Top-level page switcher (called from nav tabs and inline onclick).
function switchToPage(page) {
  document.querySelectorAll('.main-tab').forEach(t => t.classList.toggle('active', t.dataset.page === page));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('hidden', p.id !== `page-${page}`));
  if (page === 'analytics') updateSentimentChart(activeFilter && cachedSentiments[activeFilter] ? { [activeFilter]: cachedSentiments[activeFilter] } : cachedSentiments);
  if (page === 'ai') loadDailyBrief();
  if (page === 'profile') { populateProfilePage(currentUser); loadPlans(); loadApiKeys(); }
  if (page === 'backtest') initBacktestPage();
  if (page === 'strategy-builder') initBuilderPage();
  if (page === 'strategies') initStrategiesPage();
  if (page === 'paper-trade') initPaperPage();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function initMainTabs() {
  document.querySelectorAll('.main-tab').forEach(tab => {
    tab.addEventListener('click', () => switchToPage(tab.dataset.page));
  });
}

// ─── Backtest page (Phase 7 — strategy engine) ───────────────
let btCatalog = null;       // strategy list from the engine, loaded once per session
let btChart = null;         // Chart.js instance for the equity curve
let btInitDone = false;

async function initBacktestPage() {
  if (!btInitDone) {
    btInitDone = true;
    document.getElementById('bt-form').addEventListener('submit', runBacktest);
    document.getElementById('bt-strategy').addEventListener('change', renderBtParams);
    document.getElementById('bt-save').addEventListener('click', () => {
      const sel = document.getElementById('bt-strategy');
      if (sel.value === '__custom__') {
        let spec = null;
        try { spec = JSON.parse(localStorage.getItem(SB_SPEC_KEY)); } catch { /* ignore */ }
        if (!spec) { showToast('No Builder strategy to save', 'error'); return; }
        openSaveModal({ custom: spec }, spec.name);
      } else {
        const entry = btSelectedStrategy();
        if (!entry) return;
        const params = {};
        document.querySelectorAll('#bt-params input[data-param]').forEach(inp => {
          if (inp.value !== '') params[inp.dataset.param] = Number(inp.value);
        });
        openSaveModal({ strategy: entry.name, params }, entry.label);
      }
    });
    // Default range: last 2 years, ending today.
    const end = new Date(), start = new Date();
    start.setFullYear(end.getFullYear() - 2);
    document.getElementById('bt-end').value = end.toISOString().slice(0, 10);
    document.getElementById('bt-start').value = start.toISOString().slice(0, 10);
  }
  if (!btCatalog) await loadBtCatalog();
}

function btStatus(html) {
  const el = document.getElementById('bt-status');
  el.classList.toggle('hidden', !html);
  el.innerHTML = html || '';
}

async function loadBtCatalog() {
  btStatus('<div class="empty-state small"><p>Connecting to the strategy engine…</p></div>');
  try {
    const data = await api('/api/strategies/catalog');
    btCatalog = data.strategies || [];
    const sel = document.getElementById('bt-strategy');
    sel.innerHTML = btCatalog.map(s => `<option value="${escapeHtml(s.name)}">${escapeHtml(s.label)}</option>`).join('');
    btAddCustomOption();
    renderBtParams();
    btStatus('');
    document.getElementById('bt-form').classList.remove('hidden');
  } catch (err) {
    btCatalog = null;
    document.getElementById('bt-form').classList.add('hidden');
    const msg = err.status === 503
      ? 'The strategy engine is offline. Start it and revisit this page.'
      : (err.message || 'Could not load the strategy catalog.');
    btStatus(`<div class="empty-state"><span class="material-symbols-outlined strat-ph-icon">cloud_off</span><p>${escapeHtml(msg)}</p></div>`);
  }
}

function btSelectedStrategy() {
  const name = document.getElementById('bt-strategy').value;
  return (btCatalog || []).find(s => s.name === name);
}

// Param inputs are generated from the engine's ParamSpec schema, so new
// strategies/params appear here with zero frontend changes. The Builder's
// custom strategy has no params — it shows a rule summary instead.
function renderBtParams() {
  const wrap = document.getElementById('bt-params');
  const descEl = document.getElementById('bt-strategy-desc');
  if (document.getElementById('bt-strategy').value === '__custom__') {
    let spec = null;
    try { spec = JSON.parse(localStorage.getItem(SB_SPEC_KEY)); } catch { /* ignore */ }
    const nf = spec ? spec.factors.length : 0;
    const ne = spec && spec.entry && spec.entry.all ? spec.entry.all.length : 0;
    descEl.textContent = spec
      ? `Built in the Strategy Builder — ${nf} indicator${nf === 1 ? '' : 's'}, ${ne} entry condition${ne === 1 ? '' : 's'}. Edit it on the Builder page.`
      : '';
    wrap.innerHTML = '';
    return;
  }
  const entry = btSelectedStrategy();
  descEl.textContent = entry ? entry.description : '';
  wrap.innerHTML = (entry ? entry.params : []).map(p => `
    <label class="bt-field">
      <span>${escapeHtml(p.description || p.name)}</span>
      <input type="number" data-param="${escapeHtml(p.name)}" value="${p.default}"
             ${p.min != null ? `min="${p.min}"` : ''} ${p.max != null ? `max="${p.max}"` : ''}
             ${p.type === 'float' ? 'step="any"' : 'step="1"'} />
    </label>`).join('');
}

async function runBacktest(e) {
  e.preventDefault();
  const isCustom = document.getElementById('bt-strategy').value === '__custom__';
  let strategyPart;
  if (isCustom) {
    let spec = null;
    try { spec = JSON.parse(localStorage.getItem(SB_SPEC_KEY)); } catch { /* ignore */ }
    if (!spec) { showToast('No Builder strategy found — create one on the Strategy Builder page', 'error'); return; }
    strategyPart = { custom: spec };
  } else {
    const entry = btSelectedStrategy();
    if (!entry) return;
    const params = {};
    document.querySelectorAll('#bt-params input[data-param]').forEach(inp => {
      if (inp.value !== '') params[inp.dataset.param] = Number(inp.value);
    });
    strategyPart = { strategy: entry.name, params };
  }

  const body = {
    ...strategyPart,
    symbol: document.getElementById('bt-symbol').value.trim().toUpperCase(),
    exchange: document.getElementById('bt-exchange').value,
    start_date: document.getElementById('bt-start').value,
    end_date: document.getElementById('bt-end').value,
    initial_cash: document.getElementById('bt-cash').value || '100000',
  };
  if (!body.symbol) { showToast('Enter a symbol to backtest', 'error'); return; }

  const btn = document.getElementById('bt-run');
  btn.disabled = true;
  btn.innerHTML = '<span class="material-symbols-outlined spin">progress_activity</span> Running…';
  btStatus('');
  try {
    const data = await api('/api/strategies/backtest', { method: 'POST', body: JSON.stringify(body) });
    renderBtResults(data);
  } catch (err) {
    document.getElementById('bt-results').classList.add('hidden');
    if (err.status === 402) {
      const need = err.data && err.data.upgrade ? err.data.upgrade.requiredLabel : 'Plus';
      btStatus(`<div class="empty-state"><span class="material-symbols-outlined strat-ph-icon">lock</span><p>Backtesting is a ${escapeHtml(need)} feature. <a href="#" onclick="switchToPage('profile');return false;">Upgrade your plan</a> to run strategies over history.</p></div>`);
    } else if (err.status === 503) {
      btStatus('<div class="empty-state"><span class="material-symbols-outlined strat-ph-icon">cloud_off</span><p>The strategy engine is offline. Start it and try again.</p></div>');
    } else {
      showToast(err.message || 'Backtest failed', 'error');
    }
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="material-symbols-outlined">play_arrow</span> Run backtest';
  }
}

const btPct = v => v == null ? '—' : `${(Number(v) * 100).toFixed(1)}%`;
const btNum = (v, d = 2) => v == null ? '—' : Number(v).toFixed(d);

function renderBtResults(data) {
  const m = data.report.metrics;
  const req = data.request;
  const positive = Number(m.total_return_pct) >= 0;

  document.getElementById('bt-results-title').textContent = `${req.symbol} · ${req.strategy}`;
  document.getElementById('bt-results-sub').textContent =
    `${req.start_date} → ${req.end_date} · ${data.n_bars} bars · ${data.provider.name}`;

  // Backtest-depth honesty: SenIQ signal history only reaches back as far as
  // SenIQ has been recording — show how much of this run the factors covered.
  const covEl = document.getElementById('bt-coverage');
  const cov = data.seniq_coverage;
  if (cov) {
    const thin = cov.pct < 60;
    covEl.className = `bt-coverage ${thin ? 'bt-coverage-warn' : 'bt-coverage-ok'}`;
    covEl.innerHTML = `<span class="material-symbols-outlined">${thin ? 'warning' : 'insights'}</span>
      SenIQ signal data covers <strong>${cov.bars_covered} of ${cov.bars_total} bars (${cov.pct}%)</strong>
      ${cov.first_signal_date ? ` — from ${escapeHtml(cov.first_signal_date)} to ${escapeHtml(cov.last_signal_date)}` : ''}.
      Signal conditions are false outside coverage${thin ? ' — consider narrowing the date range to the covered window; history grows as SenIQ keeps recording' : ''}.`;
    covEl.classList.remove('hidden');
  } else {
    covEl.classList.add('hidden');
  }

  const cards = [
    { label: 'Total return', value: btPct(m.total_return_pct), cls: positive ? 'pos' : 'neg' },
    { label: 'Final equity', value: Number(m.final_equity).toLocaleString(undefined, { maximumFractionDigits: 0 }) },
    { label: 'Max drawdown', value: btPct(m.max_drawdown_pct), cls: 'neg' },
    { label: 'CAGR', value: btPct(m.cagr) },
    { label: 'Sharpe', value: btNum(m.sharpe) },
    { label: 'Win rate', value: btPct(m.win_rate) },
    { label: 'Trades', value: m.n_trades },
    { label: 'Exposure', value: btPct(m.exposure_pct) },
  ];
  document.getElementById('bt-metrics').innerHTML = cards.map(c =>
    `<div class="bt-metric ${c.cls || ''}"><span class="bt-metric-value">${c.value}</span><span class="bt-metric-label">${c.label}</span></div>`
  ).join('');

  // Equity curve
  const curve = data.report.equity_curve || [];
  const labels = curve.map(p => p.timestamp.slice(0, 10));
  const equity = curve.map(p => Number(p.equity));
  if (btChart) btChart.destroy();
  btChart = new Chart(document.getElementById('bt-equity-chart'), {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Equity',
        data: equity,
        borderColor: positive ? '#34d399' : '#f87171',
        backgroundColor: positive ? 'rgba(52,211,153,0.08)' : 'rgba(248,113,113,0.08)',
        fill: true, pointRadius: 0, borderWidth: 2, tension: 0.1,
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ticks: { maxTicksLimit: 8, color: '#8b93a7' }, grid: { display: false } },
        y: { ticks: { color: '#8b93a7' }, grid: { color: 'rgba(139,147,167,0.1)' } },
      },
    },
  });

  // Trades table
  const trades = data.report.trades || [];
  document.getElementById('bt-trade-count').textContent = trades.length;
  document.querySelector('#bt-trades-table tbody').innerHTML = trades.length
    ? trades.map(t => {
        const ret = Number(t.return_pct);
        return `<tr>
          <td><span class="bt-side ${t.side === 'LONG' ? 'pos' : 'neg'}">${escapeHtml(t.side)}</span></td>
          <td>${t.entry_ts.slice(0, 10)}</td>
          <td>${t.exit_ts.slice(0, 10)}</td>
          <td>${t.quantity}</td>
          <td>${btNum(t.entry_price)}</td>
          <td>${btNum(t.exit_price)}</td>
          <td class="${Number(t.net_pnl) >= 0 ? 'pos' : 'neg'}">${Number(t.net_pnl).toLocaleString(undefined, { maximumFractionDigits: 0 })}</td>
          <td class="${ret >= 0 ? 'pos' : 'neg'}">${btPct(ret)}</td>
          <td>${t.holding_days}</td>
        </tr>`;
      }).join('')
    : '<tr><td colspan="9" class="bt-no-trades">No completed trades in this window — the strategy never triggered (or a position is still open).</td></tr>';

  document.getElementById('bt-results').classList.remove('hidden');
  document.getElementById('bt-results').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ─── Strategy Builder (Phase 7) ──────────────────────────────
// Rule-row editor that emits the engine's strategy spec (factors + entry/exit
// trees). The UI model lives in localStorage; the emitted spec is handed to the
// Backtest page as a "Custom — from Builder" strategy.
const SB_UI_KEY = 'seniq_builder_ui';
const SB_SPEC_KEY = 'seniq_custom_strategy';
let sbInitDone = false;
let sbVocab = null;   // builder vocabulary from the catalog (indicators, operators)

// Param fields per factor fn (engine contract). SenIQ signal factors are
// namespaced "seniq:<metric>" in the UI model and emitted as
// {source:"seniq", metric} in the spec.
const SB_PARAMS = {
  sma: { period: 20 }, ema: { period: 20 }, rsi: { period: 14 },
  highest: { period: 20 }, lowest: { period: 20 }, roc: { period: 20 },
  macd: { fast: 12, slow: 26 }, macd_signal: { fast: 12, slow: 26, signal: 9 },
  'seniq:sentiment_avg': {}, 'seniq:sentiment_zscore': {}, 'seniq:news_volume': {},
  'seniq:congress_net_buys': { window_days: 30 },
};
const SB_SENIQ_LABELS = {
  'seniq:sentiment_avg': 'Sentiment (daily avg)',
  'seniq:sentiment_zscore': 'Sentiment z-score',
  'seniq:news_volume': 'News volume',
  'seniq:congress_net_buys': 'Congress net buys',
};
const sbIsSeniq = (fn) => fn.startsWith('seniq:');
const sbFnLabel = (fn) => SB_SENIQ_LABELS[fn] || fn.toUpperCase();
const SB_OPS = [
  { v: 'crossover', label: 'crosses above' },
  { v: 'crossunder', label: 'crosses below' },
  { v: 'gt', label: '>' }, { v: 'lt', label: '<' },
  { v: 'gte', label: '≥' }, { v: 'lte', label: '≤' },
];

function sbDefaultUi() {
  return {
    name: 'My strategy',
    factors: [{ fn: 'ema', params: { period: 20 } }, { fn: 'ema', params: { period: 50 } }],
    entry: [{ left: 'f1', op: 'crossover', right: 'f2', num: '' }],
    exit: [{ left: 'f1', op: 'crossunder', right: 'f2', num: '' }],
    stop: '', target: '', sizingType: 'percent_equity', sizingValue: 25,
  };
}

function sbLoadUi() {
  try { return JSON.parse(localStorage.getItem(SB_UI_KEY)) || sbDefaultUi(); }
  catch { return sbDefaultUi(); }
}

function sbSaveUi(ui) { localStorage.setItem(SB_UI_KEY, JSON.stringify(ui)); }

function sbFactorLabel(f, i) {
  const ps = Object.values(f.params).join(',');
  const base = sbIsSeniq(f.fn) ? sbFnLabel(f.fn) : f.fn.toUpperCase();
  return `${base}${ps ? `(${ps})` : ''}  ·  f${i + 1}`;
}

// Reads the current DOM rows back into the UI model.
function sbReadUi() {
  const ui = { name: document.getElementById('sb-name').value.trim() || 'My strategy', factors: [], entry: [], exit: [] };
  document.querySelectorAll('#sb-factors .sb-row').forEach(row => {
    const fn = row.querySelector('.sb-fn').value;
    const params = {};
    row.querySelectorAll('.sb-param').forEach(inp => { params[inp.dataset.p] = Number(inp.value) || 1; });
    ui.factors.push({ fn, params });
  });
  ['entry', 'exit'].forEach(kind => {
    document.querySelectorAll(`#sb-${kind} .sb-row`).forEach(row => {
      ui[kind].push({
        left: row.querySelector('.sb-left').value,
        op: row.querySelector('.sb-op').value,
        right: row.querySelector('.sb-right').value,
        num: row.querySelector('.sb-num').value,
      });
    });
  });
  ui.stop = document.getElementById('sb-stop').value;
  ui.target = document.getElementById('sb-target').value;
  ui.sizingType = document.getElementById('sb-sizing-type').value;
  ui.sizingValue = Number(document.getElementById('sb-sizing-value').value) || 25;
  return ui;
}

// Builds the engine spec from the UI model.
function sbEmitSpec(ui) {
  const factors = ui.factors.map((f, i) => sbIsSeniq(f.fn)
    ? { id: `f${i + 1}`, source: 'seniq', metric: f.fn.slice(6), params: f.params }
    : { id: `f${i + 1}`, fn: f.fn, params: f.params });
  const cond = (r) => ({ [r.op]: [r.left, r.right === '__num__' ? Number(r.num) : r.right] });
  const exitList = ui.exit.map(cond);
  if (ui.stop) exitList.push({ stop_loss_pct: Number(ui.stop) });
  if (ui.target) exitList.push({ take_profit_pct: Number(ui.target) });
  return {
    name: ui.name,
    factors,
    entry: { all: ui.entry.map(cond) },
    exit: exitList.length ? { any: exitList } : undefined,
    sizing: { type: ui.sizingType, value: ui.sizingValue },
  };
}

function sbOperandOptions(ui, selected) {
  const opts = ui.factors.map((f, i) => `<option value="f${i + 1}" ${selected === `f${i + 1}` ? 'selected' : ''}>${escapeHtml(sbFactorLabel(f, i).split('·')[0].trim())}</option>`);
  ['price', 'volume'].forEach(b => opts.push(`<option value="${b}" ${selected === b ? 'selected' : ''}>${b}</option>`));
  opts.push(`<option value="__num__" ${selected === '__num__' ? 'selected' : ''}>number…</option>`);
  return opts.join('');
}

function sbRender() {
  const ui = sbLoadUi();
  document.getElementById('sb-name').value = ui.name;

  const techOpts = Object.keys(SB_PARAMS).filter(fn => !sbIsSeniq(fn));
  const seniqOpts = Object.keys(SB_PARAMS).filter(sbIsSeniq);
  const fnSelect = (cur) =>
    `<optgroup label="Technical">${techOpts.map(fn => `<option value="${fn}" ${cur === fn ? 'selected' : ''}>${fn.toUpperCase()}</option>`).join('')}</optgroup>` +
    `<optgroup label="SenIQ Signals">${seniqOpts.map(fn => `<option value="${fn}" ${cur === fn ? 'selected' : ''}>${sbFnLabel(fn)}</option>`).join('')}</optgroup>`;
  document.getElementById('sb-factors').innerHTML = ui.factors.map((f, i) => `
    <div class="sb-row" data-i="${i}">
      <span class="sb-fid">f${i + 1}</span>
      <select class="sb-fn">${fnSelect(f.fn)}</select>
      ${Object.entries(f.params).map(([k, v]) => `<label class="sb-plabel">${k}<input class="sb-param" data-p="${k}" type="number" value="${v}" min="1" max="500" /></label>`).join('')}
      ${sbIsSeniq(f.fn) ? '<span class="sb-seniq-tag">SenIQ</span>' : ''}
      <button type="button" class="sb-del" data-kind="factors" data-i="${i}">×</button>
    </div>`).join('');

  ['entry', 'exit'].forEach(kind => {
    document.getElementById(`sb-${kind}`).innerHTML = ui[kind].map((r, i) => `
      <div class="sb-row" data-i="${i}">
        <select class="sb-left">${sbOperandOptions(ui, r.left)}</select>
        <select class="sb-op">${SB_OPS.map(o => `<option value="${o.v}" ${r.op === o.v ? 'selected' : ''}>${o.label}</option>`).join('')}</select>
        <select class="sb-right">${sbOperandOptions(ui, r.right)}</select>
        <input class="sb-num ${r.right === '__num__' ? '' : 'hidden'}" type="number" step="any" value="${escapeHtml(String(r.num ?? ''))}" placeholder="value" />
        <button type="button" class="sb-del" data-kind="${kind}" data-i="${i}">×</button>
      </div>`).join('');
  });

  document.getElementById('sb-stop').value = ui.stop || '';
  document.getElementById('sb-target').value = ui.target || '';
  document.getElementById('sb-sizing-type').value = ui.sizingType;
  document.getElementById('sb-sizing-value').value = ui.sizingValue;
  document.getElementById('sb-sizing-label').textContent =
    ui.sizingType === 'fixed_cash' ? 'Cash per trade' : 'Percent (1–100)';
}

function sbPersistAndRender() {
  sbSaveUi(sbReadUi());
  sbRender();
}

async function initBuilderPage() {
  if (sbInitDone) return;
  sbInitDone = true;

  // Vocabulary check — also proves the engine is reachable.
  const statusEl = document.getElementById('sb-status');
  try {
    const data = await api('/api/strategies/catalog');
    sbVocab = data.builder || null;
    statusEl.classList.add('hidden');
    document.getElementById('sb-editor').classList.remove('hidden');
  } catch (err) {
    sbInitDone = false; // retry on next visit
    statusEl.classList.remove('hidden');
    statusEl.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined strat-ph-icon">cloud_off</span><p>The strategy engine is offline. Start it and revisit this page.</p></div>';
    return;
  }

  sbRender();

  // One delegated listener per section keeps rows simple.
  const editor = document.getElementById('sb-editor');
  editor.addEventListener('change', (e) => {
    if (e.target.classList.contains('sb-fn')) {
      // Indicator changed → reset its params to defaults, re-render.
      const ui = sbReadUi();
      const i = Number(e.target.closest('.sb-row').dataset.i);
      ui.factors[i] = { fn: e.target.value, params: { ...SB_PARAMS[e.target.value] } };
      sbSaveUi(ui); sbRender();
    } else if (e.target.classList.contains('sb-right')) {
      e.target.closest('.sb-row').querySelector('.sb-num').classList.toggle('hidden', e.target.value !== '__num__');
      sbSaveUi(sbReadUi());
    } else {
      sbSaveUi(sbReadUi());
    }
    if (e.target.id === 'sb-sizing-type') sbRender();
  });
  editor.addEventListener('click', (e) => {
    if (!e.target.classList.contains('sb-del')) return;
    const ui = sbReadUi();
    const kind = e.target.dataset.kind, i = Number(e.target.dataset.i);
    ui[kind].splice(i, 1);
    if (kind === 'factors') {
      // Rebase condition references: drop rows pointing at the removed factor,
      // shift ids above it down by one.
      ['entry', 'exit'].forEach(k => {
        ui[k] = ui[k].filter(r => r.left !== `f${i + 1}` && r.right !== `f${i + 1}`)
          .map(r => {
            const shift = (x) => {
              const m = /^f(\d+)$/.exec(x);
              return (m && Number(m[1]) > i + 1) ? `f${Number(m[1]) - 1}` : x;
            };
            return { ...r, left: shift(r.left), right: shift(r.right) };
          });
      });
    }
    sbSaveUi(ui); sbRender();
  });

  document.getElementById('sb-add-factor').addEventListener('click', () => {
    const ui = sbReadUi();
    ui.factors.push({ fn: 'sma', params: { period: 20 } });
    sbSaveUi(ui); sbRender();
  });
  document.getElementById('sb-add-entry').addEventListener('click', () => {
    const ui = sbReadUi();
    ui.entry.push({ left: 'f1', op: 'gt', right: '__num__', num: '' });
    sbSaveUi(ui); sbRender();
  });
  document.getElementById('sb-add-exit').addEventListener('click', () => {
    const ui = sbReadUi();
    ui.exit.push({ left: 'f1', op: 'lt', right: '__num__', num: '' });
    sbSaveUi(ui); sbRender();
  });
  document.getElementById('sb-reset').addEventListener('click', () => {
    localStorage.removeItem(SB_UI_KEY);
    sbRender();
  });

  document.getElementById('sb-backtest').addEventListener('click', sbBacktest);
  document.getElementById('sb-save').addEventListener('click', async () => {
    const ui = sbReadUi();
    sbSaveUi(ui);
    const spec = sbEmitSpec(ui);
    const errEl = document.getElementById('sb-errors');
    errEl.classList.add('hidden');
    try {
      const check = await api('/api/strategies/validate', { method: 'POST', body: JSON.stringify(spec) });
      if (!check.valid) {
        errEl.classList.remove('hidden');
        errEl.innerHTML = '<strong>Fix these before saving:</strong><ul>' +
          check.errors.map(e => `<li>${escapeHtml(e)}</li>`).join('') + '</ul>';
        return;
      }
    } catch (err) {
      showToast(err.status === 503 ? 'Strategy engine is offline' : (err.message || 'Validation failed'), 'error');
      return;
    }
    openSaveModal({ custom: spec }, spec.name);
  });
}

async function sbBacktest() {
  const ui = sbReadUi();
  sbSaveUi(ui);
  const spec = sbEmitSpec(ui);
  const errEl = document.getElementById('sb-errors');
  errEl.classList.add('hidden');
  try {
    const check = await api('/api/strategies/validate', { method: 'POST', body: JSON.stringify(spec) });
    if (!check.valid) {
      errEl.classList.remove('hidden');
      errEl.innerHTML = '<strong>Fix these before running:</strong><ul>' +
        check.errors.map(e => `<li>${escapeHtml(e)}</li>`).join('') + '</ul>';
      return;
    }
  } catch (err) {
    showToast(err.status === 503 ? 'Strategy engine is offline' : (err.message || 'Validation failed'), 'error');
    return;
  }
  localStorage.setItem(SB_SPEC_KEY, JSON.stringify(spec));
  showToast(`“${spec.name}” sent to Backtest`, 'success');
  switchToPage('backtest');
  // Ensure the custom option exists + is selected once the catalog is in.
  setTimeout(() => {
    btAddCustomOption();
    const sel = document.getElementById('bt-strategy');
    if (sel.querySelector('option[value="__custom__"]')) {
      sel.value = '__custom__';
      sel.dispatchEvent(new Event('change'));
    }
  }, 400);
}

// Adds/refreshes the "Custom — from Builder" entry in the Backtest dropdown.
function btAddCustomOption() {
  const sel = document.getElementById('bt-strategy');
  if (!sel || !sel.options.length) return;
  let spec = null;
  try { spec = JSON.parse(localStorage.getItem(SB_SPEC_KEY)); } catch { /* ignore */ }
  let opt = sel.querySelector('option[value="__custom__"]');
  if (!spec) { if (opt) opt.remove(); return; }
  if (!opt) {
    opt = document.createElement('option');
    opt.value = '__custom__';
    sel.prepend(opt);
  }
  opt.textContent = `⚙ ${spec.name} (from Builder)`;
}

// ─── Your Strategies (Phase 7 — save + live signals) ─────────
let ysInitDone = false;

// "NVDA, BTC:CRYPTO, RELIANCE:NSE" → [{symbol, exchange}] (default US).
function ysParseSymbols(text) {
  return String(text || '').split(',')
    .map(t => t.trim()).filter(Boolean).slice(0, 5)
    .map(t => {
      const [symbol, exchange] = t.split(':').map(x => x.trim().toUpperCase());
      return { symbol, exchange: exchange || 'US' };
    })
    .filter(s => s.symbol);
}

function ysSymbolLabel(s) {
  return s.exchange === 'US' ? s.symbol : `${s.symbol}:${s.exchange}`;
}

// ── Save modal (shared by Builder + Backtest) ──
let ssPayload = null;  // {custom} or {strategy, params}

function openSaveModal(payload, defaultName) {
  ssPayload = payload;
  document.getElementById('ss-name').value = defaultName || '';
  document.getElementById('ss-symbols').value = '';
  document.getElementById('ss-error').classList.add('hidden');
  document.getElementById('save-strategy-modal').classList.remove('hidden');
  document.getElementById('ss-name').focus();
}

function initSaveModal() {
  const modal = document.getElementById('save-strategy-modal');
  document.getElementById('ss-close').addEventListener('click', () => modal.classList.add('hidden'));
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.classList.add('hidden'); });
  document.getElementById('ss-save').addEventListener('click', async () => {
    const errEl = document.getElementById('ss-error');
    errEl.classList.add('hidden');
    const body = {
      ...ssPayload,
      name: document.getElementById('ss-name').value.trim(),
      symbols: ysParseSymbols(document.getElementById('ss-symbols').value),
    };
    if (!body.name) { errEl.textContent = 'Give it a name.'; errEl.classList.remove('hidden'); return; }
    try {
      await api('/api/strategies/saved', { method: 'POST', body: JSON.stringify(body) });
      modal.classList.add('hidden');
      showToast(`“${body.name}” saved to Your Strategies`, 'success');
      ysInitDone = false; // refresh the list on next visit
    } catch (err) {
      if (err.status === 402) {
        errEl.textContent = 'Saving strategies is a Plus feature — upgrade to save.';
      } else {
        errEl.textContent = err.message || 'Save failed';
      }
      errEl.classList.remove('hidden');
    }
  });
}

// ── The page ──
async function initStrategiesPage() {
  if (ysInitDone) return;
  ysInitDone = true;
  const statusEl = document.getElementById('ys-status');
  const listEl = document.getElementById('ys-list');
  listEl.innerHTML = '';
  statusEl.classList.remove('hidden');
  statusEl.innerHTML = '<div class="empty-state small"><p>Loading your strategies…</p></div>';
  let data;
  try {
    data = await api('/api/strategies/saved');
  } catch (err) {
    ysInitDone = false;
    if (err.status === 402) {
      statusEl.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined strat-ph-icon">lock</span><p>Your Strategies is a Plus feature. <a href="#" onclick="switchToPage(\'profile\');return false;">Upgrade your plan</a> to save strategies and watch their live signals.</p></div>';
    } else {
      statusEl.innerHTML = `<div class="empty-state"><p>${escapeHtml(err.message || 'Could not load strategies')}</p></div>`;
    }
    return;
  }
  statusEl.classList.add('hidden');
  const list = data.strategies || [];
  if (!list.length) {
    statusEl.classList.remove('hidden');
    statusEl.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined strat-ph-icon">bookmarks</span><p>Nothing saved yet. Build one in the <a href="#" onclick="switchToPage(\'strategy-builder\');return false;">Strategy Builder</a>, or save a preset from the <a href="#" onclick="switchToPage(\'backtest\');return false;">Backtest page</a>.</p></div>';
    return;
  }
  listEl.innerHTML = list.map(ysCardHtml).join('');
  // Live signals load per card, in parallel — one slow symbol doesn't block the page.
  list.forEach(s => ysLoadSignal(s.id, (s.symbols || []).length));
}

function ysSummary(s) {
  if (s.kind === 'custom' && s.spec) {
    const nf = (s.spec.factors || []).length;
    const ne = s.spec.entry && s.spec.entry.all ? s.spec.entry.all.length : 0;
    return `Builder — ${nf} indicator${nf === 1 ? '' : 's'}, ${ne} entry rule${ne === 1 ? '' : 's'}`;
  }
  const params = Object.entries(s.params || {}).map(([k, v]) => `${k}=${v}`).join(', ');
  return `Preset — ${s.strategy_name}${params ? ` (${params})` : ''}`;
}

function ysCardHtml(s) {
  const watch = (s.symbols || []).map(x => `<span class="ys-chip">${escapeHtml(ysSymbolLabel(x))}</span>`).join('') ||
    '<span class="ys-chip ys-chip-empty">no symbols watched</span>';
  return `
    <div class="ys-card" data-id="${s.id}">
      <div class="ys-card-head">
        <div>
          <span class="ys-name">${escapeHtml(s.name)}</span>
          <span class="badge ys-kind">${s.kind === 'custom' ? 'Builder' : 'Preset'}</span>
        </div>
        <div class="ys-actions">
          <button type="button" class="ys-btn" onclick="ysBacktest(${s.id})" title="Load in Backtest"><span class="material-symbols-outlined">query_stats</span></button>
          <button type="button" class="ys-btn ys-btn-del" onclick="ysDelete(${s.id})" title="Delete"><span class="material-symbols-outlined">delete</span></button>
        </div>
      </div>
      <div class="ys-summary">${escapeHtml(ysSummary(s))}</div>
      <div class="ys-watch">${watch}</div>
      <div class="ys-signals" id="ys-signals-${s.id}"></div>
    </div>`;
}

async function ysLoadSignal(id, nSymbols) {
  const el = document.getElementById(`ys-signals-${id}`);
  if (!el) return;
  if (!nSymbols) { el.innerHTML = ''; return; }
  el.innerHTML = '<span class="ys-loading">evaluating signals…</span>';
  try {
    const data = await api(`/api/strategies/saved/${id}/signal`, { method: 'POST' });
    const chips = (data.signals || []).map(sig => {
      if (sig.error) return `<span class="ys-sig ys-sig-err" title="${escapeHtml(sig.error)}">${escapeHtml(sig.symbol)} — no data</span>`;
      const cls = sig.state === 'long' ? 'ys-sig-long' : 'ys-sig-flat';
      const fresh = sig.fired_on_latest_bar ? ' <span class="ys-new">NEW</span>' : '';
      const last = sig.last_signal ? ` · ${sig.last_signal.side} ${sig.last_signal.date}` : ' · no signal yet';
      return `<span class="ys-sig ${cls}" title="as of ${escapeHtml(sig.as_of || '')} · close ${escapeHtml(String(Number(sig.last_close || 0).toFixed(2)))}">${escapeHtml(sig.symbol)}: ${sig.state.toUpperCase()}${fresh}<small>${escapeHtml(last)}</small></span>`;
    }).join('');
    const note = data.has_protective_exits
      ? '<div class="ys-note">Stop-loss / take-profit exits are order-level and not reflected in rule state.</div>' : '';
    el.innerHTML = (chips || '<span class="ys-loading">no signals</span>') + note;
  } catch (err) {
    el.innerHTML = `<span class="ys-sig ys-sig-err">${escapeHtml(err.status === 503 ? 'engine offline' : (err.message || 'signal failed'))}</span>`;
  }
}

async function ysDelete(id) {
  if (!confirm('Delete this strategy?')) return;
  try {
    await api(`/api/strategies/saved/${id}`, { method: 'DELETE' });
    ysInitDone = false;
    initStrategiesPage();
  } catch (err) {
    showToast(err.message || 'Delete failed', 'error');
  }
}

// Load a saved strategy into the Backtest page.
async function ysBacktest(id) {
  try {
    const data = await api('/api/strategies/saved');
    const s = (data.strategies || []).find(x => x.id === id);
    if (!s) return;
    if (s.kind === 'custom') {
      localStorage.setItem(SB_SPEC_KEY, JSON.stringify(s.spec));
      switchToPage('backtest');
      setTimeout(() => {
        btAddCustomOption();
        const sel = document.getElementById('bt-strategy');
        if (sel.querySelector('option[value="__custom__"]')) {
          sel.value = '__custom__';
          sel.dispatchEvent(new Event('change'));
        }
      }, 400);
    } else {
      switchToPage('backtest');
      setTimeout(() => {
        const sel = document.getElementById('bt-strategy');
        if (sel.querySelector(`option[value="${s.strategy_name}"]`)) {
          sel.value = s.strategy_name;
          sel.dispatchEvent(new Event('change'));
          setTimeout(() => {
            Object.entries(s.params || {}).forEach(([k, v]) => {
              const inp = document.querySelector(`#bt-params input[data-param="${k}"]`);
              if (inp) inp.value = v;
            });
          }, 100);
        }
      }, 400);
    }
    const first = (s.symbols || [])[0];
    if (first) setTimeout(() => {
      document.getElementById('bt-symbol').value = first.symbol;
      document.getElementById('bt-exchange').value = first.exchange;
    }, 450);
  } catch (err) {
    showToast(err.message || 'Could not load strategy', 'error');
  }
}

// ─── Paper Trade (Phase 7 — Pro) ─────────────────────────────
// A deployment = {saved strategy snapshot, symbol, cash, deploy date}. State
// is a deterministic replay deploy→today through the sim engine, computed on
// read — nothing stored, nothing to drift.
let ptInitDone = false;

async function initPaperPage() {
  if (ptInitDone) return;
  ptInitDone = true;
  const statusEl = document.getElementById('pt-status');
  const listEl = document.getElementById('pt-list');
  statusEl.classList.remove('hidden');
  statusEl.innerHTML = '<div class="empty-state small"><p>Loading…</p></div>';
  listEl.innerHTML = '';

  let saved, deployments;
  try {
    [saved, deployments] = await Promise.all([
      api('/api/strategies/saved'),
      api('/api/paper'),
    ]);
  } catch (err) {
    ptInitDone = false;
    if (err.status === 402) {
      statusEl.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined strat-ph-icon">lock</span><p>Paper trading is a Pro feature. <a href="#" onclick="switchToPage(\'profile\');return false;">Upgrade your plan</a> to deploy strategies on virtual money.</p></div>';
    } else {
      statusEl.innerHTML = `<div class="empty-state"><p>${escapeHtml(err.message || 'Could not load paper trading')}</p></div>`;
    }
    return;
  }

  const strategies = saved.strategies || [];
  const sel = document.getElementById('pt-strategy');
  if (!strategies.length) {
    statusEl.innerHTML = '<div class="empty-state"><span class="material-symbols-outlined strat-ph-icon">candlestick_chart</span><p>Save a strategy first — build one in the <a href="#" onclick="switchToPage(\'strategy-builder\');return false;">Strategy Builder</a> or save a preset from the <a href="#" onclick="switchToPage(\'backtest\');return false;">Backtest page</a>, then deploy it here.</p></div>';
  } else {
    sel.innerHTML = strategies.map(s => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
    statusEl.classList.add('hidden');
    document.getElementById('pt-deploy-form').classList.remove('hidden');
    // Prefill symbol from the selected strategy's first watched symbol.
    const prefill = () => {
      const s = strategies.find(x => String(x.id) === sel.value);
      const first = s && (s.symbols || [])[0];
      if (first) {
        document.getElementById('pt-symbol').value = first.symbol;
        document.getElementById('pt-exchange').value = first.exchange;
      }
    };
    sel.onchange = prefill;
    prefill();
  }

  ptRenderList(deployments.deployments || []);

  const form = document.getElementById('pt-deploy-form');
  if (!form.dataset.wired) {
    form.dataset.wired = '1';
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const btn = document.getElementById('pt-deploy');
      btn.disabled = true;
      try {
        await api('/api/paper', {
          method: 'POST',
          body: JSON.stringify({
            strategy_id: Number(document.getElementById('pt-strategy').value),
            symbol: document.getElementById('pt-symbol').value.trim().toUpperCase(),
            exchange: document.getElementById('pt-exchange').value,
            initial_cash: document.getElementById('pt-cash').value || '100000',
          }),
        });
        showToast('Deployed — trading starts with the next fresh signal', 'success');
        ptInitDone = false;
        initPaperPage();
      } catch (err) {
        showToast(err.message || 'Deploy failed', 'error');
      } finally {
        btn.disabled = false;
      }
    });
  }
}

function ptRenderList(list) {
  const listEl = document.getElementById('pt-list');
  if (!list.length) {
    listEl.innerHTML = '<div class="empty-state small"><p>No deployments yet — deploy a saved strategy above.</p></div>';
    return;
  }
  listEl.innerHTML = list.map(d => `
    <div class="pt-card ${d.status === 'stopped' ? 'pt-stopped' : ''}" data-id="${d.id}">
      <div class="ys-card-head">
        <div>
          <span class="ys-name">${escapeHtml(d.name)}</span>
          <span class="ys-chip">${escapeHtml(d.exchange === 'US' ? d.symbol : `${d.symbol}:${d.exchange}`)}</span>
          <span class="badge ${d.status === 'active' ? 'pt-live' : ''}">${d.status === 'active' ? '● live' : 'stopped'}</span>
        </div>
        <div class="ys-actions">
          ${d.status === 'active' ? `<button type="button" class="ys-btn" onclick="ptStop(${d.id})" title="Stop"><span class="material-symbols-outlined">stop_circle</span></button>` : ''}
          <button type="button" class="ys-btn ys-btn-del" onclick="ptDelete(${d.id})" title="Delete"><span class="material-symbols-outlined">delete</span></button>
        </div>
      </div>
      <div class="ys-summary">deployed ${escapeHtml(d.deployed_at)}${d.stopped_at ? ` · stopped ${escapeHtml(d.stopped_at)}` : ''} · paper cash ${Number(d.initial_cash).toLocaleString()}</div>
      <div class="pt-state" id="pt-state-${d.id}"><span class="ys-loading">replaying…</span></div>
    </div>`).join('');
  list.forEach(d => ptLoadState(d.id));
}

async function ptLoadState(id) {
  const el = document.getElementById(`pt-state-${id}`);
  if (!el) return;
  try {
    const data = await api(`/api/paper/${id}/state`, { method: 'POST' });
    const m = data.report.metrics;
    const initial = Number(data.deployment.initial_cash);
    if (!data.n_bars) {
      el.innerHTML = '<span class="ys-loading">warming up — no completed bars since deploy yet</span>';
      return;
    }
    const equity = Number(m.final_equity);
    const pnl = equity - initial;
    const pnlPct = (pnl / initial) * 100;
    const cls = pnl >= 0 ? 'pos' : 'neg';
    const pos = (data.open_positions || [])[0];
    const posHtml = pos
      ? `<span class="pt-pos">holding <strong>${pos.qty}</strong> ${escapeHtml(pos.symbol)} @ ${Number(pos.avg_cost).toFixed(2)} (now ${Number(pos.mark_price).toFixed(2)})</span>`
      : '<span class="pt-pos pt-flat">no open position</span>';
    el.innerHTML = `
      <div class="pt-metrics">
        <div class="bt-metric"><span class="bt-metric-value">${equity.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span><span class="bt-metric-label">Equity</span></div>
        <div class="bt-metric ${cls}"><span class="bt-metric-value">${pnl >= 0 ? '+' : ''}${pnl.toLocaleString(undefined, { maximumFractionDigits: 0 })} (${pnlPct.toFixed(2)}%)</span><span class="bt-metric-label">P&amp;L since deploy</span></div>
        <div class="bt-metric"><span class="bt-metric-value">${m.n_trades}</span><span class="bt-metric-label">Closed trades</span></div>
        <div class="bt-metric"><span class="bt-metric-value">${data.n_bars}</span><span class="bt-metric-label">Bars traded</span></div>
      </div>
      ${posHtml}`;
  } catch (err) {
    el.innerHTML = `<span class="ys-sig ys-sig-err">${escapeHtml(err.status === 503 ? 'engine offline' : (err.message || 'replay failed'))}</span>`;
  }
}

async function ptStop(id) {
  if (!confirm('Stop this deployment? Its track record freezes as of today.')) return;
  try {
    await api(`/api/paper/${id}/stop`, { method: 'POST' });
    ptInitDone = false;
    initPaperPage();
  } catch (err) {
    showToast(err.message || 'Stop failed', 'error');
  }
}

async function ptDelete(id) {
  if (!confirm('Delete this deployment and its paper history?')) return;
  try {
    await api(`/api/paper/${id}`, { method: 'DELETE' });
    ptInitDone = false;
    initPaperPage();
  } catch (err) {
    showToast(err.message || 'Delete failed', 'error');
  }
}

function initIntelTabs() {
  document.querySelectorAll('.intel-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      const panel = tab.dataset.intel;
      document.querySelectorAll('.intel-tab').forEach(t => t.classList.toggle('active', t === tab));
      document.querySelectorAll('.intel-panel').forEach(p => p.classList.toggle('hidden', p.id !== `intel-panel-${panel}`));
      if (panel === 'institutions') loadInstitutions();
      if (panel === 'congress') loadCongress();
    });
  });
}

// Renders top 3 news + top 5 alerts into the dashboard preview areas.
function renderDashboardSummary() {
  const newsEl = document.getElementById('dash-news-preview');
  if (newsEl) {
    const allNews = [...(cachedBuckets.holdings || []), ...(cachedBuckets.market || []), ...(cachedBuckets.world || [])];
    const filtered = activeFilter ? allNews.filter(a => (a.matchedTickers || []).includes(activeFilter)) : allNews;
    const top3 = filtered.slice(0, 3);
    newsEl.innerHTML = top3.length
      ? top3.map(a => renderNewsItem(a)).join('')
      : '<div class="empty-state small"><p>No news yet — the pipeline will populate your feed shortly.</p></div>';
  }

  const alertsEl = document.getElementById('dash-alerts-preview');
  if (alertsEl) {
    let alerts = activeFilter ? cachedAlerts.filter(a => a.ticker === activeFilter || a.ticker === 'MARKET') : cachedAlerts;
    const top5 = alerts.slice(0, 5);
    alertsEl.innerHTML = top5.length
      ? top5.map(a => {
          const urgency = a.alert_type.includes('negative') ? 'high' : a.alert_type.includes('positive') ? 'medium' : 'low';
          const msg = a.article_url
            ? `<a href="${escapeHtml(a.article_url)}" target="_blank" rel="noopener noreferrer" class="alert-title-link">${escapeHtml(a.message)}</a>`
            : escapeHtml(a.message);
          return `<div class="alert-item ${urgency}${a.read ? ' read' : ''}"><div>${msg}</div><div class="alert-time">${timeAgo(new Date(a.created_at))}</div></div>`;
        }).join('')
      : '<div class="empty-state small"><p>No alerts yet. We\'ll notify you when something important happens.</p></div>';
  }
}

function initSmartMoney() {
  document.querySelectorAll('.scope-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      congressScope = btn.dataset.scope;
      document.querySelectorAll('.scope-btn').forEach(b => b.classList.toggle('active', b === btn));
      loadCongress();
    });
  });
  const whBtn = document.getElementById('webhook-add-btn');
  if (whBtn) whBtn.addEventListener('click', addWebhook);
  const wh = document.getElementById('sm-webhooks');
  if (wh) wh.addEventListener('toggle', () => { if (wh.open) loadWebhooks(); });

  // Client-side search filters (no refetch — filters the already-loaded list).
  wireSmartMoneySearch('inst-search', 'inst-search-clear', (v) => { instSearchQuery = v; renderInstitutions(); });
  wireSmartMoneySearch('congress-search', 'congress-search-clear', (v) => { congressSearchQuery = v; renderCongress(); });
}

// Wire a search input + its clear button to a setter, debounced.
function wireSmartMoneySearch(inputId, clearId, apply) {
  const input = document.getElementById(inputId);
  const clear = document.getElementById(clearId);
  if (!input) return;
  let timer = null;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      const v = input.value.trim();
      if (clear) clear.classList.toggle('hidden', !v);
      apply(v);
    }, 150);
  });
  if (clear) clear.addEventListener('click', () => {
    input.value = '';
    clear.classList.add('hidden');
    apply('');
  });
}

// ─── Utilities ───────────────────────────────────────────────
function timeAgo(date) {
  const seconds = Math.floor((new Date() - date) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

// Format a USD price: 2 decimals for ≥$1, up to 6 for sub-dollar (small-cap crypto).
function fmtUsd(n) {
  if (n == null || isNaN(n)) return '—';
  const d = Number(n) >= 1 ? 2 : 6;
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

// ─── Company Brief (E4 onboarding) ───────────────────────────
const BRIEF_TYPE_LABEL = {
  ma: 'M&A', legal: 'Legal', disruption: 'Disruption', executive: 'Exec change',
  earnings: 'Earnings', guidance: 'Guidance', rating: 'Analyst', insider: 'Insider',
  product: 'Product', macro: 'Macro', other: 'News', unknown: 'News',
};

function briefScoreClass(score) {
  if (score == null) return 'neutral';
  return score > 0.55 ? 'positive' : score < 0.45 ? 'negative' : 'neutral';
}

function renderBrief(b) {
  const c = b.company || {};
  const meta = [c.sector, c.exchange, c.country].filter(Boolean).join(' · ');
  const execs = (c.executives || []).map(e => `${escapeHtml(e.name)}${e.role ? ` (${escapeHtml(e.role)})` : ''}`).join(', ');

  const s = b.sentiment;
  const TT = {
    sentiment: 'Overall current mood from recent news — positive, neutral, or negative.',
    acute: 'Headline sentiment right now (0–1), from the last 24–72h and weighted toward fresher, more credible sources. Above 0.5 leans positive, below 0.5 negative.',
    momentum: 'Which way sentiment is trending — recent 7 days vs the prior week. Improving, declining, or flat.',
    z: "How unusual today's sentiment is versus this asset's own 90-day normal. Around ±2 is a real surprise; near 0 is business-as-usual. Shows n/a until ~5 data points build up.",
  };
  const sentimentBlock = s ? `
    <div class="brief-stats">
      <div class="brief-stat" data-tip="${escapeHtml(TT.sentiment)}" aria-label="${escapeHtml(TT.sentiment)}"><span class="brief-stat-label">Sentiment</span><span class="brief-stat-val ${briefScoreClass(s.acute)}">${escapeHtml(s.label)}</span></div>
      <div class="brief-stat" data-tip="${escapeHtml(TT.acute)}" aria-label="${escapeHtml(TT.acute)}"><span class="brief-stat-label">Acute</span><span class="brief-stat-val">${s.acute ?? '—'}</span></div>
      <div class="brief-stat" data-tip="${escapeHtml(TT.momentum)}" aria-label="${escapeHtml(TT.momentum)}"><span class="brief-stat-label">Momentum</span><span class="brief-stat-val">${escapeHtml(s.momentum || 'flat')}</span></div>
      <div class="brief-stat" data-tip="${escapeHtml(TT.z)}" aria-label="${escapeHtml(TT.z)}"><span class="brief-stat-label">90d z-score</span><span class="brief-stat-val">${s.baseline_z != null ? s.baseline_z : 'n/a'}</span></div>
    </div>` : `<p class="brief-empty">No sentiment history yet — it fills in as news accumulates.</p>`;

  const impactBlock = b.impact ? `
    <div class="brief-impact">
      <span class="impact-dir ${b.impact.direction}">${DIR_ICON[b.impact.direction] || ''}</span>
      <span class="brief-impact-text">Top impact: <strong>${escapeHtml(b.impact.top_event)}</strong></span>
      <span class="brief-impact-exp">${b.impact.exposure_pct}% exposure</span>
    </div>` : '';

  const events = (b.recent_events || []);
  const eventsBlock = events.length ? `
    <ul class="brief-events">
      ${events.map(e => `
        <li class="brief-event">
          <span class="brief-event-type">${escapeHtml(BRIEF_TYPE_LABEL[e.type] || 'News')}</span>
          <span class="brief-event-title">${escapeHtml(e.title)}</span>
          <span class="brief-event-meta">${e.source_count > 1 ? `${e.source_count} sources · ` : ''}${e.last_seen ? timeAgo(new Date(e.last_seen)) : ''}</span>
        </li>`).join('')}
    </ul>` : `<p class="brief-empty">No recent events for this holding yet.</p>`;

  const sm = b.smart_money || { institutions: [], congress: [] };
  const smBits = [];
  if (sm.institutions && sm.institutions.length) smBits.push(`${sm.institutions.length} fund${sm.institutions.length > 1 ? 's' : ''} hold it (${escapeHtml(sm.institutions[0].name)}…)`);
  if (sm.congress && sm.congress.length) smBits.push(`${sm.congress.length} recent congress trade${sm.congress.length > 1 ? 's' : ''}`);
  const smBlock = smBits.length ? `<p class="brief-smartmoney">🏛️ ${smBits.join(' · ')}</p>` : '';

  return `
    <div class="brief-head">
      <div class="brief-name">${escapeHtml(c.name || b.ticker)} <span class="brief-ticker">${escapeHtml(b.ticker)}</span></div>
      ${meta ? `<div class="brief-meta">${escapeHtml(meta)}</div>` : ''}
      ${!b.in_universe ? `<div class="brief-meta brief-muted">Outside the curated universe — basic coverage only.</div>` : ''}
      ${execs ? `<div class="brief-execs">Key people: ${execs}</div>` : ''}
    </div>
    ${sentimentBlock}
    ${impactBlock}
    <h4 class="brief-section-title">Recent context</h4>
    ${eventsBlock}
    ${smBlock}
    <p class="brief-note">${escapeHtml(b.note || '')}</p>`;
}

function showBrief(brief) {
  document.getElementById('brief-title').textContent = `${brief.ticker} — Company Brief`;
  document.getElementById('brief-body').innerHTML = renderBrief(brief);
  document.getElementById('brief-modal').classList.remove('hidden');
}

async function openBriefFor(ticker) {
  try {
    const { brief } = await api(`/api/portfolio/${ticker}/brief`);
    showBrief(brief);
  } catch (err) {
    showToast(err.message, 'error');
  }
}

function initBriefModal() {
  const modal = document.getElementById('brief-modal');
  if (!modal) return;
  const close = () => modal.classList.add('hidden');
  document.getElementById('brief-close')?.addEventListener('click', close);
  document.getElementById('brief-done')?.addEventListener('click', close);
  modal.addEventListener('click', (e) => { if (e.target === modal) close(); });
}

// ─── Daily Brief (E5 — the analyst voice) ────────────────────
async function loadDailyBrief() {
  const el = document.getElementById('daily-brief');
  try {
    const data = await api('/api/reports/daily');
    renderDailyBrief(data.brief);
  } catch (err) {
    if (err.status === 402 && el) {
      el.innerHTML = `<div class="empty-state"><p>The AI Workspace — daily brief + Ask — is a <strong>Plus</strong> feature.</p>${upgradeNote('Unlock your personalized daily brief and portfolio Q&A.')}</div>`;
      return;
    }
    console.error('Daily brief error:', err);
  }
}

const WRITER_LABEL = { claude: 'Written by Claude', ollama: 'Local model', deterministic: 'Auto-generated' };

function renderDailyBrief(brief) {
  const el = document.getElementById('daily-brief');
  if (!el) return;
  if (!brief || !brief.narrative) {
    el.innerHTML = '<div class="empty-state"><p>Your personalized brief appears here once your holdings have recent context.</p></div>';
    return;
  }
  const ch = (brief.packet && brief.packet.changed) || {};
  const chips = [];
  if (ch.has_prior) {
    if (ch.new_events && ch.new_events.length) chips.push(`<span class="brief-chip new">${ch.new_events.length} new since yesterday</span>`);
    if (ch.sentiment_swings && ch.sentiment_swings.length) chips.push(`<span class="brief-chip swing">${ch.sentiment_swings.length} sentiment shift${ch.sentiment_swings.length > 1 ? 's' : ''}</span>`);
    if (ch.rank_changes && ch.rank_changes.length) chips.push(`<span class="brief-chip rank">${ch.rank_changes.length} rank change${ch.rank_changes.length > 1 ? 's' : ''}</span>`);
    if (!chips.length) chips.push('<span class="brief-chip quiet">Little changed since yesterday</span>');
  } else {
    chips.push('<span class="brief-chip quiet">First brief</span>');
  }
  const dateStr = brief.brief_date ? new Date(brief.brief_date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) : '';
  el.innerHTML = `
    <div class="brief-top">
      <span class="brief-date">${escapeHtml(dateStr)}</span>
      <span class="brief-writer" title="${escapeHtml(brief.model || '')}">${WRITER_LABEL[brief.writer] || 'Brief'}</span>
    </div>
    <div class="brief-headline">${escapeHtml(brief.headline || '')}</div>
    <div class="brief-changes">${chips.join('')}</div>
    <p class="brief-narrative">${escapeHtml(brief.narrative)}</p>`;
}

async function refreshDailyBrief() {
  const btn = document.getElementById('brief-refresh');
  if (btn) { btn.disabled = true; btn.textContent = '↻ …'; }
  try {
    const data = await api('/api/reports/daily/generate', { method: 'POST' });
    renderDailyBrief(data.brief);
    showToast('Brief refreshed', 'success');
  } catch (err) {
    showToast(err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↻ Refresh'; }
  }
}

// ─── Ask it anything (E6) ────────────────────────────────────
async function askPortfolio(question) {
  const input = document.getElementById('ask-input');
  const answerEl = document.getElementById('ask-answer');
  const btn = document.getElementById('ask-btn');
  const q = (question || input.value || '').trim();
  if (!q) return showToast('Type a question first', 'error');
  input.value = q;
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  answerEl.classList.remove('hidden');
  answerEl.innerHTML = '<div class="ask-thinking">Thinking…</div>';
  try {
    const data = await api('/api/reports/ask', { method: 'POST', body: JSON.stringify({ question: q }) });
    const writerTag = data.writer === 'claude' ? 'AI answer' : 'Auto-generated from your data';
    answerEl.innerHTML = `
      <div class="ask-answer-text">${escapeHtml(data.answer)}</div>
      <div class="ask-answer-meta"><span class="ask-writer">${writerTag}</span><span class="ask-disclaimer">Informational only — not advice.</span></div>`;
    renderAskQuota(data.quota);
  } catch (err) {
    answerEl.innerHTML = err.status === 402
      ? `<div class="ask-answer-text">Portfolio Q&A is a Plus feature.</div>${upgradeNote('Upgrade to ask anything about your portfolio.')}`
      : `<div class="ask-answer-text">${escapeHtml(err.message)}</div>`;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Ask'; }
  }
}

function renderAskQuota(quota) {
  const el = document.getElementById('ask-quota');
  if (el && quota) el.textContent = `${quota.remaining}/${quota.limit} questions left today`;
}

function initAsk() {
  document.getElementById('ask-btn')?.addEventListener('click', () => askPortfolio());
  document.getElementById('ask-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') askPortfolio(); });
  document.querySelectorAll('.ask-chip').forEach((c) => c.addEventListener('click', () => askPortfolio(c.dataset.q)));
}

// ─── Tiers & billing (Phase 6) ───────────────────────────────
const TIER_LABEL = { free: 'Free', plus: 'Plus', pro: 'Pro' };
let instTeaser = null;     // {total} when the smart-money list is teaser-limited (Free)
let congressTeaser = null;

function currentTier() { return (currentUser && currentUser.subscription_tier) || 'free'; }

function upgradeNote(text, tier = 'plus') {
  return `<div class="upgrade-note"><span>${escapeHtml(text)}</span>
    <button class="btn btn-primary btn-xs" onclick="goToPlans()">Upgrade to ${TIER_LABEL[tier]}</button></div>`;
}

function renderTierControl() {
  const badge = document.getElementById('tier-badge');
  const adminWrap = document.getElementById('admin-tier');
  const sel = document.getElementById('admin-tier-select');
  const tier = currentTier();
  if (badge) { badge.textContent = TIER_LABEL[tier] || 'Free'; badge.className = `tier-badge ${tier}`; }
  const profBadge = document.getElementById('profile-plan-badge');
  if (profBadge) { profBadge.textContent = `${TIER_LABEL[tier] || 'Free'} Plan`; profBadge.className = `plan-badge ${tier}`; }
  if (currentUser && currentUser.is_admin) {
    adminWrap?.classList.remove('hidden');
    if (sel) sel.value = tier;
  } else {
    adminWrap?.classList.add('hidden');
  }
}

// Admin-only: flip the account's tier and refresh every tier-gated view in place.
async function onAdminTierChange(tier) {
  try {
    await api('/api/admin/tier', { method: 'PUT', body: JSON.stringify({ tier }) });
    currentUser.subscription_tier = tier;
    renderTierControl();
    showToast(`Now viewing as ${TIER_LABEL[tier]}`, 'success');
    reloadTierViews();
  } catch (err) { showToast(err.message, 'error'); }
}

// Re-pull everything whose output depends on tier (after a switch or an upgrade).
function reloadTierViews() {
  loadPortfolio();
  loadImpactFeed();
  loadDailyBrief();
  loadInstitutions();
  loadCongress();
}

function initTierControl() {
  const sel = document.getElementById('admin-tier-select');
  if (sel) sel.addEventListener('change', () => onAdminTierChange(sel.value));
}

function goToPlans() {
  switchToPage('profile');
  setTimeout(() => document.getElementById('plans-section')?.scrollIntoView({ behavior: 'smooth' }), 60);
}

// Plans / upgrade UI (profile page). Checkout is a dev stub (see routes/billing.js).
async function loadPlans() {
  const wrap = document.getElementById('plans-grid');
  if (!wrap) return;
  try {
    const { plans, currentTier: cur } = await api('/api/billing/plans');
    wrap.innerHTML = plans.map(p => {
      const isCur = p.id === cur;
      const price = p.price.usd === 0 ? 'Free' : `$${p.price.usd}<span class="plan-per">/mo</span>`;
      const feats = [
        p.maxHoldings === null || p.maxHoldings > 999 ? 'Unlimited holdings' : `${p.maxHoldings} holdings`,
        p.impactFeed === 'full' ? 'Full impact feed' : 'Top event only',
        p.smartMoney === 'full' ? 'Full smart money' : 'Smart-money teaser',
        p.claudeReportsPerDay > 0 ? `Daily brief + Q&A` : 'No AI workspace',
        p.webhooks ? 'Outbound webhooks' : null,
        p.apiAccess ? 'API / MCP access' : null,
      ].filter(Boolean);
      return `<div class="plan-card ${isCur ? 'current' : ''} ${p.id}">
        <div class="plan-name">${escapeHtml(p.label)}</div>
        <div class="plan-price">${price}</div>
        <ul class="plan-feats">${feats.map(f => `<li>${escapeHtml(f)}</li>`).join('')}</ul>
        ${isCur ? '<div class="plan-current-badge">Current plan</div>'
          : `<button class="btn ${p.id === 'free' ? 'btn-ghost' : 'btn-primary'} btn-sm" onclick="checkout('${p.id}')">${p.id === 'free' ? 'Downgrade' : 'Choose ' + escapeHtml(p.label)}</button>`}
      </div>`;
    }).join('');
  } catch (err) { wrap.innerHTML = `<p class="empty-state small">${escapeHtml(err.message)}</p>`; }
}

async function checkout(tier) {
  try {
    const res = await api('/api/billing/checkout', { method: 'POST', body: JSON.stringify({ tier, period: 'monthly' }) });
    currentUser.subscription_tier = tier;
    renderTierControl();
    showToast(res.message || `Switched to ${TIER_LABEL[tier]}`, 'success');
    loadPlans();
    reloadTierViews();
  } catch (err) { showToast(err.message, 'error'); }
}

// ─── API keys — MCP access (Phase 8) ─────────────────────────

function initApiKeys() {
  const url = document.getElementById('mcp-endpoint-url');
  if (url) url.textContent = `${location.origin}/mcp`;
  const v1 = document.getElementById('v1-endpoint-url');
  if (v1) v1.textContent = `${location.origin}/v1`;
  document.getElementById('api-key-create-btn')?.addEventListener('click', createApiKey);
  document.getElementById('api-key-name')?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') createApiKey();
  });
}

async function loadApiKeys() {
  const wrap = document.getElementById('api-keys-list');
  if (!wrap) return;
  try {
    const { keys } = await api('/api/keys');
    if (!keys.length) {
      wrap.innerHTML = '<p class="empty-state small">No API keys yet — create one to connect an agent.</p>';
      return;
    }
    wrap.innerHTML = keys.map(k => `
      <div class="api-key-row ${k.revoked ? 'revoked' : ''}">
        <span class="ak-prefix">${escapeHtml(k.key_prefix)}…</span>
        <span class="ak-name">${escapeHtml(k.name)}</span>
        <span class="ak-meta">${k.revoked
          ? 'revoked'
          : (k.last_used_at ? `last used ${new Date(k.last_used_at).toLocaleDateString()}` : 'never used')}</span>
        ${k.revoked ? '' : `<button class="btn btn-ghost btn-xs" onclick="revokeApiKey(${k.id})">Revoke</button>`}
      </div>`).join('');
  } catch (err) {
    wrap.innerHTML = `<p class="empty-state small">${escapeHtml(err.message)}</p>`;
  }
}

async function createApiKey() {
  const nameInput = document.getElementById('api-key-name');
  const msgEl = document.getElementById('api-key-msg');
  const btn = document.getElementById('api-key-create-btn');
  try {
    btn.disabled = true;
    const created = await api('/api/keys', {
      method: 'POST',
      body: JSON.stringify({ name: nameInput.value.trim() }),
    });
    nameInput.value = '';
    // The full key exists only in this response — show it once with a copy button.
    const box = document.getElementById('api-key-new');
    box.innerHTML = `
      <div class="ak-new-label">Key created — copy it now, it won't be shown again:</div>
      <div class="ak-new-row">
        <code class="ak-new-key" id="ak-new-key-value">${escapeHtml(created.key)}</code>
        <button class="btn btn-primary btn-xs" id="ak-copy-btn">Copy</button>
      </div>`;
    box.classList.remove('hidden');
    document.getElementById('ak-copy-btn').addEventListener('click', async () => {
      await navigator.clipboard.writeText(created.key);
      showToast('Key copied to clipboard', 'success');
    });
    loadApiKeys();
  } catch (err) {
    if (err.status === 402) {
      showProfileMsg(msgEl, err.message || 'API keys require the Pro plan.', 'error');
      goToPlans();
    } else {
      showProfileMsg(msgEl, err.message, 'error');
    }
  } finally {
    btn.disabled = false;
  }
}

async function revokeApiKey(id) {
  if (!confirm('Revoke this key? Agents using it will stop working immediately.')) return;
  try {
    await api(`/api/keys/${id}`, { method: 'DELETE' });
    showToast('Key revoked', 'info');
    loadApiKeys();
  } catch (err) { showToast(err.message, 'error'); }
}

// ─── Init ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  initAuth();
  initModal();
  initUserMenu();
  initAnalyzer();
  initMainTabs();
  initIntelTabs();
  initSmartMoney();
  initAsk();
  initBriefModal();
  initTierControl();
  initSaveModal();
  initApiKeys();
  document.getElementById('brief-refresh')?.addEventListener('click', refreshDailyBrief);

  // Filter clear button
  document.getElementById('clear-filter-btn').addEventListener('click', clearFilter);

  // Ticker search filter
  initTickerSearch();

  // News search bar
  const newsSearchInput = document.getElementById('news-search');
  const newsSearchClear = document.getElementById('news-search-clear');
  let newsSearchTimer = null;
  newsSearchInput.addEventListener('input', () => {
    clearTimeout(newsSearchTimer);
    newsSearchTimer = setTimeout(() => {
      newsSearchQuery = newsSearchInput.value.trim();
      newsSearchClear.classList.toggle('hidden', !newsSearchQuery);
      newsExpanded = false; // Reset to top 10 on new search
      renderFilteredNews();
    }, 200); // Debounce 200ms
  });
  newsSearchClear.addEventListener('click', () => {
    newsSearchInput.value = '';
    newsSearchQuery = '';
    newsSearchClear.classList.add('hidden');
    renderFilteredNews();
  });

  // View All buttons
  document.getElementById('news-view-all').addEventListener('click', () => {
    newsExpanded = !newsExpanded;
    renderFilteredNews();
  });
  document.getElementById('alerts-view-all').addEventListener('click', () => {
    alertsExpanded = !alertsExpanded;
    renderFilteredAlerts();
  });

  // Mark all alerts as read
  document.getElementById('mark-all-read-btn').addEventListener('click', markAllRead);

  // Check for existing session
  if (token) {
    try {
      const data = await api('/api/auth/me');
      currentUser = data.user;
      showDashboard();
    } catch (err) {
      token = null;
      localStorage.removeItem('copilot_token');
    }
  }
});
