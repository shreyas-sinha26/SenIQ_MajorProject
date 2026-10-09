/* ═══ AI Portfolio Copilot — Frontend Application ═══ */
const API = '';
// Sign-in lives in an HttpOnly cookie the server sets; scripts never see it. This flag is
// only a hint for the landing page ("Go to Dashboard") — /api/auth/me is what decides.
const SIGNED_IN_HINT = 'seniq_signed_in';
localStorage.removeItem('copilot_token'); // the old sign-in token, no longer used
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
let cachedOverallLabel = 'neutral';
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
  const res = await fetch(`${API}${path}`, { ...opts, headers, credentials: 'same-origin' });
  const data = await res.json().catch(() => ({}));
  // The session ended on the server (idle, expired, or signed out elsewhere).
  if (res.status === 401 && currentUser && !path.startsWith('/api/auth/')) sessionEnded();
  if (!res.ok) {
    const err = new Error(data.error || 'Request failed');
    err.status = res.status;
    err.data = data; // carries { upgrade: { requiredTier, requiredLabel } } on 402
    throw err;
  }
  return data;
}

function showSignedOut() {
  currentUser = null;
  localStorage.removeItem(SIGNED_IN_HINT);
  if (refreshInterval) clearInterval(refreshInterval);
  document.getElementById('dashboard-view').classList.add('hidden');
  document.getElementById('auth-view').classList.remove('hidden');
}
function sessionEnded() {
  showSignedOut();
  const errEl = document.getElementById('auth-error');
  errEl.textContent = 'Your session has ended — please sign in again.';
  errEl.classList.remove('hidden');
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

// ─── Confirm dialog ──────────────────────────────────────────
// An in-page "are you sure?" that resolves true or false. The browser's own confirm() is
// not used: embedded browsers and some extensions suppress it and answer "no", which made
// every delete button look dead.
function confirmAction(message, confirmLabel = 'Delete') {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    overlay.innerHTML = `
      <div class="modal glass" role="alertdialog" aria-modal="true" style="max-width: 400px;">
        <div class="modal-body"><p class="confirm-message"></p></div>
        <div class="modal-footer">
          <button class="btn btn-ghost" type="button" data-answer="no">Cancel</button>
          <button class="btn btn-primary" type="button" data-answer="yes"></button>
        </div>
      </div>`;
    overlay.querySelector('.confirm-message').textContent = message;
    const yes = overlay.querySelector('[data-answer="yes"]');
    yes.textContent = confirmLabel;
    const done = (answer) => { document.removeEventListener('keydown', onKey); overlay.remove(); resolve(answer); };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };
    overlay.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-answer]');
      if (btn) done(btn.dataset.answer === 'yes');
      else if (e.target === overlay) done(false);
    });
    document.addEventListener('keydown', onKey);
    document.body.appendChild(overlay);
    yes.focus();
  });
}

// ─── Auth Logic ──────────────────────────────────────────────
function selectAuthTab(name) {
  const tab = document.querySelector(`.auth-tab[data-tab="${name}"]`);
  if (tab) tab.click();
}

let showAuthForm = () => {}; // assigned inside initAuth; used by the Phase 5 boot code
let pendingResetToken = null; // ?reset=<token> from an emailed password-reset link

function initAuth() {
  // ── Form switching (tabs + cross-form links + forgot/reset panels) ──
  function switchTab(name) {
    document.querySelectorAll('.auth-tab').forEach(t => t.classList.remove('active'));
    const tab = document.querySelector(`.auth-tab[data-tab="${name}"]`);
    if (tab) tab.classList.add('active');
    ['login', 'signup', 'forgot', 'reset'].forEach(f => {
      const form = document.getElementById(`${f}-form`);
      if (form) form.classList.toggle('hidden', name !== f);
    });
    ['auth-error', 'auth-error-signup', 'auth-error-forgot', 'auth-error-reset', 'auth-success', 'auth-success-forgot']
      .forEach(id => document.getElementById(id)?.classList.add('hidden'));
  }
  showAuthForm = switchTab;

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
      localStorage.setItem(SIGNED_IN_HINT, '1');
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
      localStorage.setItem(SIGNED_IN_HINT, '1');
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

  // ── Forgot password (Phase 5) ──
  document.getElementById('forgot-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('auth-error-forgot');
    const okEl = document.getElementById('auth-success-forgot');
    errEl.classList.add('hidden'); okEl.classList.add('hidden');
    const btn = document.getElementById('forgot-btn');
    btn.disabled = true;
    try {
      const data = await api('/api/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email: document.getElementById('forgot-email').value }),
      });
      okEl.textContent = data.message;
      // Local dev without an email provider: the server hands the link back.
      if (data.devResetLink) {
        okEl.innerHTML = `${escapeHtml(data.message)}<br><a href="${escapeHtml(data.devResetLink)}" style="color:inherit;text-decoration:underline">Dev: open reset link</a>`;
      }
      okEl.classList.remove('hidden');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  });

  // ── Set new password (arrived via ?reset=<token>) ──
  document.getElementById('reset-form')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = document.getElementById('auth-error-reset');
    errEl.classList.add('hidden');
    const pw = document.getElementById('reset-password').value;
    const confirm = document.getElementById('reset-password-confirm').value;
    if (pw !== confirm) {
      errEl.textContent = 'Passwords do not match';
      errEl.classList.remove('hidden');
      return;
    }
    const btn = document.getElementById('reset-btn');
    btn.disabled = true;
    try {
      const data = await api('/api/auth/reset-password', {
        method: 'POST',
        body: JSON.stringify({ token: pendingResetToken, password: pw }),
      });
      pendingResetToken = null;
      showAuthForm('login');
      const okEl = document.getElementById('auth-success');
      okEl.textContent = data.message;
      okEl.classList.remove('hidden');
    } catch (err) {
      errEl.textContent = err.message;
      errEl.classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  });

  // ── OAuth buttons (visibility driven by /api/config) ──
  document.querySelectorAll('[data-oauth-provider]').forEach(btn => {
    btn.addEventListener('click', () => { location.href = `/api/auth/oauth/${btn.dataset.oauthProvider}`; });
  });
  fetch('/api/config').then(r => r.json()).then(cfg => {
    const o = cfg.oauth || {};
    if (!o.google && !o.github) return;
    document.querySelectorAll('.oauth-only').forEach(el => el.classList.remove('hidden'));
    ['google', 'github'].forEach(p => {
      if (o[p]) document.querySelectorAll(`[data-oauth-provider="${p}"]`).forEach(b => b.classList.remove('hidden'));
    });
  }).catch(() => {});
}


// ─── Dashboard ───────────────────────────────────────────────
async function showDashboard() {
  document.getElementById('auth-view').classList.add('hidden');
  document.getElementById('dashboard-view').classList.remove('hidden');
  requestAnimationFrame(moveNavIndicator); // nav is measurable only once the view is shown

  // Set user info
  if (currentUser) {
    document.getElementById('user-name').textContent = currentUser.name;
    document.getElementById('user-avatar').textContent = currentUser.name.charAt(0).toUpperCase();
  }
  renderTierControl();

  // Load all data
  syncBrowserTimeZone();
  await Promise.all([loadPortfolio(), loadNewsFeed(), loadAlerts(), loadPortfolioSentiment(), loadImpactFeed(), loadDailyBrief(), loadSmartMoney(), loadAskThreads()]);

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
      ? `<span class="ht-price">${fmtPrice(h.price, h.currency)}${h.change_pct != null
          ? ` <span class="ht-chg ${h.change_pct >= 0 ? 'up' : 'down'}">${h.change_pct >= 0 ? '▲' : '▼'}${Math.abs(h.change_pct).toFixed(2)}%</span>`
          : ''}</span>`
      : '<span class="ht-price muted">—</span>';
    return `
    <tr class="${rowClass}" data-ticker="${escapeHtml(h.ticker)}" onclick="toggleFilter('${escapeHtml(h.ticker)}')">
      <td>
        <div class="ht-ticker">${escapeHtml(h.ticker)} <span class="asset-class-badge ${cls}">${clsLabel}</span>${h.coverage === 'basic' ? ' <span class="coverage-badge" title="Outside SenIQ\'s curated list of companies. News is matched on the name and symbol only, so expect fewer stories and a thinner sentiment score.">Basic coverage</span>' : ''} ${priceInline}</div>
        <div class="ht-name">${escapeHtml(h.company_name || h.ticker)}</div>
      </td>
      <td class="ht-exposure">${exposure}</td>
      <td><span class="ht-senti-label neutral" id="senti-label-${escapeHtml(h.ticker)}">—</span></td>
      <td><button class="ht-score-why" type="button" title="See the stories behind this score" onclick="event.stopPropagation(); toggleSentimentDrivers('${escapeHtml(h.ticker)}')"><span class="ht-score neutral" id="score-${escapeHtml(h.ticker)}">—</span><span class="ht-score-caret" aria-hidden="true">▾</span></button></td>
      <td><span class="ht-headline" id="headline-${escapeHtml(h.ticker)}">—</span></td>
      <td class="ht-actions">
        <button class="ht-info" onclick="event.stopPropagation(); openBriefFor('${escapeHtml(h.ticker)}')" title="Company brief">ℹ</button>
        <button class="ht-remove" onclick="event.stopPropagation(); removeStock('${escapeHtml(h.ticker)}')" title="Remove">×</button>
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
          <div class="search-result-item${isActive ? ' active-item' : ''}" onclick="selectSearchResult('${escapeHtml(h.ticker)}')">
            <div>
              <span class="search-result-ticker">${escapeHtml(h.ticker)}</span>
              <span class="search-result-name">${escapeHtml(h.company_name || '')}</span>
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
          <div class="search-result-item${isActive ? ' active-item' : ''}" onclick="selectSearchResult('${escapeHtml(h.ticker)}')">
            <div>
              <span class="search-result-ticker">${escapeHtml(h.ticker)}</span>
              <span class="search-result-name">${escapeHtml(h.company_name || '')}</span>
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

// One news card. Shows a "+N more" badge when several outlets carried the same article,
// and "+N related headlines" when other headlines on the same story were folded into it.
function renderNewsItem(a) {
  const time = timeAgo(new Date(a.published_at));
  const tickers = (a.matchedTickers || []).filter(t => t !== '__MARKET__').slice(0, 3);
  const sources = a.source_count > 1 ? `<span class="news-source-count">+${a.source_count - 1} more</span>` : '';
  // Other headlines on the same story, folded into this card by the server.
  const related = a.related ? `<span class="news-source-count">+${a.related} related ${a.related === 1 ? 'headline' : 'headlines'}</span>` : '';
  // The folded headlines themselves, behind a disclosure so the card stays one line.
  const items = (a.related_items || []);
  const relatedList = items.length ? `<details class="news-related"><summary>Show ${items.length === a.related ? 'them' : `${items.length} of them`}</summary><ul>${items.map((r) =>
    `<li>${r.url && r.url !== '#' ? `<a href="${safeUrl(r.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(r.title)}</a>` : escapeHtml(r.title)}${r.source ? ` <span>${escapeHtml(r.source)}</span>` : ''}</li>`).join('')}</ul></details>` : '';
  const stance = a.stance && a.stance !== 'event' ? `<span class="news-stance">${a.stance === 'roundup' ? 'Round-up' : 'Commentary'}</span>` : '';
  // The engine's own figures for this reader: how much the story matters to their
  // portfolio, which way it reads for what they hold, and how much of it the story reaches.
  const LEVEL_WORD = { high: 'High', medium: 'Medium', low: 'Low' };
  const READS = { positive: 'Reads positive', negative: 'Reads negative', neutral: 'Reads mixed' };
  let engineLine;
  if (a.impact == null) {
    engineLine = '<span class="ni-label">Not linked to your holdings</span>';
  } else {
    const dir = a.direction || 'neutral';
    const reach = a.exposure_pct == null ? ''
      : a.tier === 'holding' ? `${a.exposure_pct}% of your portfolio` : 'market-wide';
    engineLine = `<span class="ni-label">Impact on you</span>
          <span class="ni-level ${a.impact_level}">${LEVEL_WORD[a.impact_level] || 'Low'}</span>
          <span class="ni-conf" title="Impact score: your exposure × how strong, surprising and recent the story is">${Number(a.impact).toFixed(2)}</span>
          <span class="ni-sep">·</span>
          <span class="ni-score ${dir}">${READS[dir]}</span>
          ${reach ? `<span class="ni-sep">·</span><span class="ni-conf">${reach}</span>` : ''}`;
  }
  const dot = a.direction || a.sentiment.label;
  return `
    <div class="news-item">
      <div class="news-sentiment-dot ${dot}"></div>
      <div class="news-content">
        <div class="news-title">${a.url
          ? `<a href="${safeUrl(a.url)}" target="_blank" rel="noopener noreferrer" class="news-title-link">${escapeHtml(a.title)}</a>`
          : escapeHtml(a.title)}</div>
        <div class="news-meta">
          ${tickers.map(t => `<span class="news-ticker">${escapeHtml(t)}</span>`).join('')}
          <span>${escapeHtml(a.source || '')}</span>
          ${sources}
          ${related}
          ${stance}
          <span>${time}</span>
        </div>
        <div class="news-impact-row">
          ${engineLine}
        </div>
        ${relatedList}
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
      ? `<a href="${safeUrl(a.article_url)}" target="_blank" rel="noopener noreferrer" class="alert-title-link">${escapeHtml(a.message)}</a>`
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
    cachedOverallLabel = data.overallLabel || 'neutral';

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

// ─── Explain the number: the stories behind a holding's sentiment score ──────
// Clicking a score opens a row under the holding listing each story's exact share of the
// score (GET /api/news/sentiment/:ticker/drivers — the same data Ask's explain tool uses).
function renderSentimentDrivers(d) {
  const z = d.baseline && d.baseline.z != null;
  const head = `<div class="drv-head"><strong>${escapeHtml(d.ticker)}</strong> sentiment ${Math.round((d.acute.score ?? 0.5) * 100)} from ${d.acute.count} article${d.acute.count === 1 ? '' : 's'} in the last ${d.window_hours}h` +
    (z ? ` · ${d.baseline.z > 0 ? '+' : ''}${d.baseline.z}σ vs its own 90-day norm` : ' · too little history for a comparison with its norm') + '</div>';
  if (!d.drivers.length) return head + `<div class="drv-empty">${escapeHtml(d.note || 'No recent articles are driving this score.')}</div>`;
  const unit = z ? 'σ' : ' pts';
  const rows = d.drivers.map((x) => {
    const title = x.url && x.url !== '#' ? `<a href="${safeUrl(x.url)}" target="_blank" rel="noopener">${escapeHtml(x.title)}</a>` : escapeHtml(x.title);
    return `<li class="drv-item ${x.direction}">
        <span class="drv-arrow">${x.direction === 'up' ? '▲' : x.direction === 'down' ? '▼' : '■'}</span>
        <span class="drv-title">${title}</span>
        <span class="drv-meta">${escapeHtml(x.source || '')} · ${escapeHtml(x.date || '')}${x.articles > 1 ? ` · ${x.articles} articles` : ''}</span>
        <span class="drv-contrib">${x.contribution > 0 ? '+' : ''}${x.contribution}${unit}</span>
      </li>`;
  }).join('');
  const rest = d.other_stories && d.other_stories.stories
    ? `<div class="drv-rest">${d.other_stories.stories} other ${d.other_stories.stories === 1 ? 'story' : 'stories'}: ${d.other_stories.contribution > 0 ? '+' : ''}${d.other_stories.contribution}${unit} combined</div>` : '';
  return head + `<ul class="drv-list">${rows}</ul>${rest}<div class="drv-foot">${z ? 'The parts add up to the score\'s distance from its norm.' : 'The parts add up to the score\'s distance from neutral (50).'} Weighted by recency, source and confidence.</div>`;
}

async function toggleSentimentDrivers(ticker) {
  const row = document.querySelector(`#holdings-grid tr[data-ticker="${CSS.escape(ticker)}"]`);
  if (!row) return;
  const next = row.nextElementSibling;
  if (next && next.classList.contains('ht-drivers-row')) { next.remove(); return; }
  document.querySelectorAll('#holdings-grid .ht-drivers-row').forEach((r) => r.remove());
  const tr = document.createElement('tr');
  tr.className = 'ht-drivers-row';
  tr.innerHTML = '<td colspan="6"><div class="drv-box">Loading…</div></td>';
  row.after(tr);
  const box = tr.querySelector('.drv-box');
  try {
    box.innerHTML = renderSentimentDrivers(await api(`/api/news/sentiment/${encodeURIComponent(ticker)}/drivers`));
  } catch (err) {
    box.innerHTML = err.status === 402
      ? upgradeNote('See which stories are driving each score on Plus.')
      : `<div class="drv-empty">${escapeHtml(err.message || 'Could not load the stories behind this score.')}</div>`;
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
    ? `<a class="impact-hero-title" href="${safeUrl(top.url)}" target="_blank" rel="noopener">${escapeHtml(top.title)}</a>`
    : `<span class="impact-hero-title no-link">${escapeHtml(top.title)}</span>`;
  hero.innerHTML = `
    <div class="impact-hero-tag">Most important event for you</div>
    ${topTitle}
    <div class="impact-hero-meta">
      <span class="impact-dir ${dir}">${DIR_ICON[dir]} ${dir}</span>
      <span class="impact-exposure">${top.exposure_pct}% of your exposure</span>
      <span class="impact-source">${escapeHtml(top.source || top.platform || '')}</span>
      <span class="impact-time">${timeAgo(new Date(top.published_at))}</span>
      ${top.related ? `<span class="impact-related">+${top.related} related ${top.related === 1 ? 'headline' : 'headlines'}</span>` : ''}
      ${top.stance && top.stance !== 'event' ? `<span class="impact-related">${top.stance === 'roundup' ? 'round-up' : 'commentary'}</span>` : ''}
    </div>`;

  if (list) list.innerHTML = feed.slice(1).map(e => {
    const d = e.direction || 'neutral';
    const inner = `
        <span class="impact-dir ${d}">${DIR_ICON[d]}</span>
        <span class="impact-row-title">${escapeHtml(e.title)}${e.related ? ` <span class="impact-related">+${e.related} related</span>` : ''}${e.stance && e.stance !== 'event' ? ` <span class="impact-related">· ${e.stance === 'roundup' ? 'round-up' : 'commentary'}</span>` : ''}</span>
        <span class="impact-row-exposure">${e.exposure_pct}%</span>`;
    return hasUrl(e.url)
      ? `<a class="impact-row glass" href="${safeUrl(e.url)}" target="_blank" rel="noopener">${inner}</a>`
      : `<div class="impact-row glass no-link">${inner}</div>`;
  }).join('');
}  // end renderImpactFeed

function renderFilteredSentiment() {
  // The engine's score and its own reading (above 60 positive, below 40 negative), for one
  // holding when a filter is on, otherwise for the portfolio weighted by position size.
  const one = activeFilter && cachedSentiments[activeFilter];
  const score = one ? Math.round(one.score * 100) : cachedOverallScore;
  const reading = one ? one.label : cachedOverallLabel;
  const label = reading === 'positive' ? 'Bullish' : reading === 'negative' ? 'Bearish' : 'Neutral';

  document.getElementById('portfolio-score').textContent = score;
  const labelEl = document.getElementById('portfolio-score-label');
  labelEl.textContent = activeFilter ? `${activeFilter} — ${label}` : label;
  labelEl.style.color = reading === 'positive' ? 'var(--positive)' : reading === 'negative' ? 'var(--negative)' : 'var(--neutral)';

  // Animate ring
  const circle = document.getElementById('score-circle');
  if (circle) {
    const circumference = 327;
    const offset = circumference - (score / 100) * circumference;
    circle.style.strokeDashoffset = offset;
    circle.style.transition = 'stroke-dashoffset 1.5s ease';
  }

  updateSentimentChart();
}

// ─── Analytics page: the score, explained ────────────────────
// One request (GET /api/news/sentiment-breakdown) feeds the whole page: the headline, the
// chart, a card per holding and the stories behind each score. The numbers are the
// engine's own, the same ones the "why" button on a holding and Ask use.
let cachedBreakdown = null;
let breakdownLoadedAt = 0;
const SENTI_WORD = { positive: 'Positive', negative: 'Negative', neutral: 'Mixed' };
const SENTI_COLOR = { positive: '#14B86A', negative: '#EF4444', neutral: '#94A3B8' };
const signed = (n, d = 1) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(Number(n)).toFixed(d)}`;

async function loadAnalytics(force = false) {
  if (!force && cachedBreakdown && Date.now() - breakdownLoadedAt < 60_000) return renderAnalytics();
  try {
    cachedBreakdown = await api('/api/news/sentiment-breakdown');
    breakdownLoadedAt = Date.now();
    renderAnalytics();
  } catch (err) {
    document.getElementById('an-summary').innerHTML = `<p class="empty-state small">${escapeHtml(err.message || 'Could not load the sentiment breakdown.')}</p>`;
  }
}

// Called wherever the old single chart was refreshed (dashboard load, ticker filter).
function updateSentimentChart() {
  if (cachedBreakdown) renderAnalytics();
}

function renderAnalytics() {
  const b = cachedBreakdown;
  if (!b) return;
  const shown = activeFilter ? b.holdings.filter((h) => h.ticker === activeFilter) : b.holdings;
  renderAnalyticsSummary(b, shown);
  renderAnalyticsChart(b, shown);
  document.getElementById('an-cards').innerHTML = shown.length
    ? shown.map((h) => analyticsCard(h, b)).join('')
    : '<p class="empty-state small">Add a holding to see how the news on it reads.</p>';
}

function renderAnalyticsSummary(b, shown) {
  const el = document.getElementById('an-summary');
  const p = b.portfolio;
  if (!b.holdings.length) { el.innerHTML = '<p class="empty-state small">Add holdings to your portfolio to see their sentiment explained here.</p>'; return; }
  if (activeFilter && shown.length === 1) {
    const h = shown[0];
    el.innerHTML = `<div class="an-sum-figure"><div class="an-sum-num">${h.has_news ? h.score : '—'}</div><div class="an-sum-cap">${escapeHtml(h.ticker)} sentiment</div></div>
      <ul class="an-sum-lines"><li>${analyticsSentence(h, b)}</li><li class="muted">Showing ${escapeHtml(h.ticker)} only. Clear the filter on the Dashboard to see every holding.</li></ul>`;
    return;
  }
  if (p.weighted_score == null) { el.innerHTML = `<p class="empty-state small">No scored articles on your holdings in the last ${b.window_hours} hours, so there is nothing to read yet.</p>`; return; }
  const parts = [`${p.positive} positive`, `${p.neutral} mixed`, `${p.negative} negative`];
  const quiet = p.holdings - p.with_news;
  const lines = [
    `Weighted by position size, the news across your holdings reads <span class="an-pill ${p.label}">${SENTI_WORD[p.label]}</span> at <strong>${p.weighted_score}</strong> out of 100. The plain average, counting every holding equally, is ${p.score}.`,
    `Of ${p.with_news} holding${p.with_news === 1 ? '' : 's'} with recent news: ${parts.join(', ')}.${quiet ? ` ${quiet} had no articles in the last ${b.window_hours} hours.` : ''}`,
  ];
  const lift = p.biggest_lift, drag = p.biggest_drag;
  const who = (x) => `<strong>${escapeHtml(x.ticker)}</strong> (score ${x.score}, ${x.exposure_pct}% of your portfolio)`;
  if (lift || drag) lines.push([lift ? `Lifting it most: ${who(lift)}.` : '', drag ? `Pulling it down most: ${who(drag)}.` : ''].filter(Boolean).join(' '));
  el.innerHTML = `<div class="an-sum-figure"><div class="an-sum-num">${p.weighted_score}</div><div class="an-sum-cap">Portfolio sentiment</div></div>
    <ul class="an-sum-lines">${lines.map((l) => `<li>${l}</li>`).join('')}
      <li class="muted">A large position moves the weighted figure more than a small one. Sentiment describes the coverage; it is not a forecast of price.</li></ul>`;
}

// One sentence a reader can act on: the reading, how unusual it is, and the trend.
function analyticsSentence(h, b) {
  const t = escapeHtml(h.ticker);
  if (!h.has_news) return `No scored articles on ${t} in the last ${b.window_hours} hours, so its score rests at neutral.`;
  let s = `News on ${t} reads <strong>${SENTI_WORD[h.label].toLowerCase()}</strong> (${h.score}).`;
  if (h.baseline) {
    if (h.baseline.z == null) s += ' There is too little history yet to compare it with its own normal.';
    else if (Math.abs(h.baseline.z) < 0.5) s += ` That is in line with its own normal of ${h.baseline.usual}.`;
    else s += ` That is ${Math.abs(h.baseline.z).toFixed(1)}σ ${h.baseline.z > 0 ? 'above' : 'below'} its own normal of ${h.baseline.usual}${Math.abs(h.baseline.z) >= 1 ? ', which is unusual for it' : ''}.`;
  }
  const m = h.momentum;
  if (m.delta == null) s += ' Not enough history for a week-on-week trend.';
  else if (m.direction === 'improving') s += ` Coverage is improving: up ${Math.abs(m.delta)} points on the week before.`;
  else if (m.direction === 'declining') s += ` Coverage is worsening: down ${Math.abs(m.delta)} points on the week before.`;
  else s += ' Coverage is steady week on week.';
  return s;
}

// A small line of the daily average over the last two weeks, on the same 0–100 scale.
function analyticsSparkline(trend) {
  if (!trend || trend.length < 3) return '<span class="muted">Needs 3 days of articles</span>';
  const W = 220, H = 34, pad = 3;
  const x = (i) => pad + (i * (W - pad * 2)) / (trend.length - 1);
  const y = (v) => pad + ((100 - v) * (H - pad * 2)) / 100;
  const pts = trend.map((d, i) => `${x(i).toFixed(1)},${y(d.score).toFixed(1)}`).join(' ');
  const last = trend[trend.length - 1];
  return `<svg class="an-spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily sentiment, ${trend[0].date} to ${last.date}: ${trend.map((d) => d.score).join(', ')}">
    <title>${trend.map((d) => `${d.date}: ${d.score}`).join('\n')}</title>
    <line x1="${pad}" x2="${W - pad}" y1="${y(50)}" y2="${y(50)}" stroke="#CBD5E1" stroke-width="1" stroke-dasharray="3 3"/>
    <polyline points="${pts}" fill="none" stroke="#0A2540" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>
    <circle cx="${x(trend.length - 1).toFixed(1)}" cy="${y(last.score).toFixed(1)}" r="4" fill="#0A2540" stroke="#fff" stroke-width="2"/>
  </svg>`;
}

function analyticsCard(h, b) {
  const total = h.split.positive + h.split.neutral + h.split.negative;
  const seg = (k) => (h.split[k] ? `<i class="${k}" style="flex:${h.split[k]}" title="${h.split[k]} ${SENTI_WORD[k].toLowerCase()}"></i>` : '');
  const split = total
    ? `<div><div class="an-split">${seg('positive')}${seg('neutral')}${seg('negative')}</div>
        <div class="an-split-text">${total} read: ${h.split.positive} positive · ${h.split.neutral} mixed · ${h.split.negative} negative</div></div>`
    : '<span class="muted">None in the window</span>';
  const move = h.change_pct == null ? '' : ` · latest session ${signed(h.change_pct, 2)}%`;
  let drivers = '';
  if (b.depth !== 'full') {
    drivers = `<div class="an-drivers">${upgradeNote('See each holding\'s own normal and the stories moving its score on Plus.')}</div>`;
  } else if (h.drivers && h.drivers.length) {
    const unit = h.driver_unit === 'sigma' ? 'σ' : ' pts';
    const rows = h.drivers.map((x) => {
      const title = x.url && x.url !== '#' ? `<a href="${safeUrl(x.url)}" target="_blank" rel="noopener">${escapeHtml(x.title)}</a>` : escapeHtml(x.title);
      return `<li class="drv-item ${x.direction}">
        <span class="drv-arrow">${x.direction === 'up' ? '▲' : x.direction === 'down' ? '▼' : '■'}</span>
        <span class="drv-title">${title}</span>
        <span class="drv-meta">${escapeHtml(x.source || '')} · ${escapeHtml(x.date || '')}${x.articles > 1 ? ` · ${x.articles} articles` : ''}</span>
        <span class="drv-contrib">${signed(x.contribution, h.driver_unit === 'sigma' ? 2 : 1)}${unit}</span>
      </li>`;
    }).join('');
    drivers = `<div class="an-drivers"><div class="an-drivers-head">Stories moving this score most</div><div class="drv-rest" style="margin:0 0 4px">${h.driver_unit === 'sigma' ? '▲ pushed it above its own normal, ▼ pulled it below.' : '▲ pushed it above neutral (50), ▼ pulled it below.'}</div><ul class="drv-list">${rows}</ul>
      ${h.other_stories ? `<div class="drv-rest">${h.other_stories} other ${h.other_stories === 1 ? 'story' : 'stories'} make up the rest.</div>` : ''}</div>`;
  }
  return `<article class="an-card">
    <div class="an-card-head">
      <div><div class="an-card-ticker">${escapeHtml(h.ticker)}</div><div class="an-card-name">${escapeHtml(h.name || '')}</div></div>
      <div class="an-card-score"><b>${h.has_news ? h.score : '—'}</b><span class="an-pill ${h.label}">${h.has_news ? SENTI_WORD[h.label] : 'No news'}</span></div>
    </div>
    <p class="an-card-say">${analyticsSentence(h, b)}</p>
    <div class="an-rows">
      <div class="an-row"><span>Articles, last ${b.window_hours}h</span>${split}</div>
      <div class="an-row"><span>Daily trend, 14 days</span><div>${analyticsSparkline(h.trend)}</div></div>
      <div class="an-row"><span>In your portfolio</span><span>${h.exposure_pct == null ? '—' : `${h.exposure_pct}% of it`}${move}</span></div>
    </div>
    ${drivers}
  </article>`;
}

// ─── Sentiment Chart ─────────────────────────────────────────
// Bars = the score now, coloured by its reading. The dash on each bar = that holding's own
// 90-day normal (Plus). The shaded band is the mixed zone, 40 to 60.
const mixedZoneBand = {
  id: 'mixedZoneBand',
  beforeDatasetsDraw(chart) {
    const { ctx, chartArea, scales } = chart;
    if (!chartArea) return;
    const top = scales.y.getPixelForValue(60), bottom = scales.y.getPixelForValue(40);
    ctx.save();
    ctx.fillStyle = '#F1F5F9';
    ctx.fillRect(chartArea.left, top, chartArea.right - chartArea.left, bottom - top);
    ctx.restore();
  },
};

function renderAnalyticsChart(b, shown) {
  const ctx = document.getElementById('sentiment-chart');
  if (!ctx) return;
  const rows = shown.filter((h) => h.has_news);
  const hasUsual = b.depth === 'full' && rows.some((h) => h.baseline && h.baseline.usual != null);
  document.getElementById('an-legend').innerHTML = [
    '<span><i class="an-key" style="background:#14B86A"></i>Positive, above 60</span>',
    '<span><i class="an-key" style="background:#94A3B8"></i>Mixed, 40 to 60</span>',
    '<span><i class="an-key" style="background:#EF4444"></i>Negative, below 40</span>',
    hasUsual ? `<span><i class="an-key dash"></i>Its own ${b.baseline_days}-day normal</span>` : '',
    '<span><i class="an-key band"></i>Mixed zone</span>',
  ].join('');
  document.getElementById('an-chart-caption').textContent = hasUsual
    ? 'Read each bar against its own dash, not against the other bars: a bar well above or below its dash is the unusual one, whatever its height.'
    : 'A bar above the shaded band reads positive, below it negative.';

  if (sentimentChart) sentimentChart.destroy();
  const datasets = [{
    type: 'bar', label: 'Score now', order: 2,
    data: rows.map((h) => h.score),
    backgroundColor: rows.map((h) => SENTI_COLOR[h.label]),
    borderRadius: 4, borderSkipped: 'bottom', maxBarThickness: 64,
  }];
  if (hasUsual) {
    datasets.push({
      type: 'line', label: 'Its own normal', order: 1, showLine: false,
      data: rows.map((h) => (h.baseline ? h.baseline.usual : null)),
      pointStyle: 'line', pointRadius: 26, pointHoverRadius: 28, pointBorderWidth: 3, pointHoverBorderWidth: 3,
      pointBorderColor: '#0A2540', pointBackgroundColor: '#0A2540',
    });
  }
  sentimentChart = new Chart(ctx, {
    data: { labels: rows.map((h) => h.ticker), datasets },
    plugins: [mixedZoneBand],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        tooltip: {
          backgroundColor: '#FFFFFF', titleColor: '#1E293B', bodyColor: '#475569',
          borderColor: '#E2E8F0', borderWidth: 1, cornerRadius: 8, padding: 12, displayColors: false,
          filter: (item) => item.datasetIndex === 0,
          callbacks: {
            label: (item) => {
              const h = rows[item.dataIndex];
              const out = [`Score now: ${h.score} (${SENTI_WORD[h.label].toLowerCase()})`];
              if (h.baseline && h.baseline.usual != null) out.push(`Its own normal: ${h.baseline.usual}${h.baseline.z != null ? ` (${signed(h.baseline.z)}σ)` : ''}`);
              out.push(`${h.articles} article${h.articles === 1 ? '' : 's'} in the last ${b.window_hours}h`);
              return out;
            },
          },
        },
      },
      scales: {
        y: { min: 0, max: 100, grid: { color: '#EEF2F7' }, ticks: { color: '#64748B', font: { family: 'Inter' }, stepSize: 20 } },
        x: { grid: { display: false }, ticks: { color: '#1E293B', font: { family: 'Inter', weight: 600 } } },
      },
      animation: { duration: 500, easing: 'easeOutQuart' },
    },
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

  // Smart autocomplete: the built-in list answers at once; the server's company reference
  // (every listed stock) fills the remaining rows a moment later.
  let searchTimer = null;
  const localMatches = (q) => ASSET_DB.filter(a =>
    a.ticker.toLowerCase().includes(q) ||
    a.name.toLowerCase().includes(q) ||
    a.market.toLowerCase().includes(q)
  ).slice(0, 8);

  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    clearTimeout(searchTimer);
    if (!q) { autocomplete.classList.add('hidden'); return; }
    renderMatches(localMatches(q));
    searchTimer = setTimeout(async () => {
      try {
        const { results } = await api(`/api/portfolio/search?q=${encodeURIComponent(q)}`);
        for (const r of results) {
          if (ASSET_DB.some(a => a.ticker === r.ticker)) continue;
          const india = r.country === 'IN';
          ASSET_DB.push({
            ticker: r.ticker, name: r.name,
            type: r.asset_class === 'equity' ? (india ? 'india' : 'stock') : r.asset_class,
            market: r.asset_class === 'equity' ? (india ? 'India Stock' : 'US Stock') : r.asset_class === 'crypto' ? 'Crypto' : 'Commodity',
          });
        }
        if (input.value.trim().toLowerCase() === q) renderMatches(localMatches(q));
      } catch { /* the built-in list is still shown */ }
    }, 200);
  });

  function renderMatches(matches) {
    if (matches.length === 0) {
      autocomplete.innerHTML = '<div class="asset-no-results">No matching assets found. Press Enter to add custom ticker.</div>';
    } else {
      autocomplete.innerHTML = matches.map(a => {
        const inPortfolio = holdings.some(h => h.ticker === a.ticker);
        return `
          <div class="asset-item${inPortfolio ? ' dimmed' : ''}" onclick="${inPortfolio ? '' : `selectAsset('${a.ticker}')`}">
            <div class="asset-item-left">
              <div class="asset-item-icon ${a.type}">${escapeHtml(a.ticker.slice(0,2))}</div>
              <div>
                <div class="asset-item-name">${escapeHtml(a.name)}</div>
                <div class="asset-item-ticker">${escapeHtml(a.ticker)}${inPortfolio ? ' • In portfolio' : ''}</div>
              </div>
            </div>
            <span class="asset-type-badge ${a.type}">${a.market}</span>
          </div>
        `;
      }).join('');
    }
    autocomplete.classList.remove('hidden');
  }

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

  document.getElementById('logout-btn').addEventListener('click', async () => {
    // Ends the session on the server; the page signs out here whether or not that call lands.
    try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* signed out locally regardless */ }
    showSignedOut();
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
    if (nw.length < 8) return showProfileMsg(msgEl, 'New password must be at least 8 characters', 'error');
    try {
      document.getElementById('profile-pw-btn').disabled = true;
      // The change signs out every other session; this one carries on.
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
  loadEmailPrefs();
  moveNavIndicator();
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

// ─── Email preferences (verified address + alert emails) ─────
let emailPrefsBound = false;
function emailPrefMsg(text, kind = 'success') {
  const el = document.getElementById('email-pref-msg');
  el.textContent = text;
  el.className = `profile-msg ${kind}`;
}
// "Weekly summary, Sundays at 18:00 India time" — from the server's own schedule.
function showReportSchedule(p) {
  const r = p.report;
  if (!r) return;
  const when = r.kind === 'daily' ? `The daily brief, weekdays at ${r.time}` : `A weekly summary, Sundays at ${r.time}`;
  // The time is on the user's own clock; say which, and whether it was set or guessed.
  const zone = r.time_zone_source === 'user' ? `your time (${zoneLabel(r.time_zone)})` : `${r.market_label} time`;
  const evening = r.evening_time ? ` An end-of-day report every evening at ${r.evening_time}, when there is something to report.` : '';
  document.getElementById('email-reports-hint').textContent =
    `${when} ${zone}${r.kind === 'weekly' ? '. Plus and Pro get the daily brief.' : '.'}${evening}`;
  const hint = document.getElementById('email-timezone-hint');
  if (hint) hint.textContent = r.time_zone_source === 'user'
    ? 'Reports arrive, and daily limits reset, on this clock.'
    : `Not set, so ${r.market_label} time (${zoneLabel(r.time_zone)}) is used. Reports arrive, and daily limits reset, on this clock.`;
}
// "Asia/Kolkata" → "Asia / Kolkata"; "America/Argentina/Buenos_Aires" → "America / Argentina / Buenos Aires".
const zoneLabel = (tz) => String(tz || '').replace(/_/g, ' ').replace(/\//g, ' / ');
const browserTimeZone = () => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone || null; } catch { return null; } };
// Fill the time-zone list once: every zone the browser knows, the browser's own first.
function fillTimeZoneSelect(select, current) {
  if (select.options.length <= 1) {
    let zones = [];
    try { zones = Intl.supportedValuesOf('timeZone'); } catch { /* older browser: only the two below */ }
    const mine = browserTimeZone();
    const list = [...new Set([mine, current, ...zones].filter(Boolean))];
    for (const tz of list) {
      const o = document.createElement('option');
      o.value = tz;
      o.textContent = tz === mine ? `${zoneLabel(tz)} (this device)` : zoneLabel(tz);
      select.appendChild(o);
    }
  }
  if (current && ![...select.options].some(o => o.value === current)) {
    const o = document.createElement('option');
    o.value = current; o.textContent = zoneLabel(current);
    select.appendChild(o);
  }
  select.value = current || '';
}
// Once per page load: tell the server this device's zone. It only fills an empty setting.
let browserZoneSent = false;
async function syncBrowserTimeZone() {
  if (browserZoneSent) return;
  browserZoneSent = true;
  const tz = browserTimeZone();
  if (!tz || tz === 'UTC' || !tz.includes('/')) return;
  try { await api('/api/email/preferences', { method: 'PUT', body: JSON.stringify({ time_zone_if_unset: tz }) }); } catch { /* not important enough to show */ }
}
async function loadEmailPrefs() {
  const toggle = document.getElementById('email-alerts-toggle');
  const reportsToggle = document.getElementById('email-reports-toggle');
  const marketSelect = document.getElementById('email-market-select');
  const zoneSelect = document.getElementById('email-timezone-select');
  const status = document.getElementById('email-verify-status');
  const btn = document.getElementById('email-verify-btn');
  if (!emailPrefsBound) {
    emailPrefsBound = true;
    toggle.addEventListener('change', async () => {
      try {
        const r = await api('/api/email/preferences', { method: 'PUT', body: JSON.stringify({ email_alerts: toggle.checked }) });
        emailPrefMsg(r.email_alerts ? 'Alert emails are on.' : 'Alert emails are off — alerts still appear in the app.');
      } catch (err) {
        toggle.checked = !toggle.checked;
        emailPrefMsg(err.message || 'Could not save that', 'error');
      }
    });
    reportsToggle.addEventListener('change', async () => {
      try {
        const r = await api('/api/email/preferences', { method: 'PUT', body: JSON.stringify({ email_reports: reportsToggle.checked }) });
        emailPrefMsg(r.email_reports ? 'Report emails are on.' : 'Report emails are off — your brief is still in the app.');
      } catch (err) {
        reportsToggle.checked = !reportsToggle.checked;
        emailPrefMsg(err.message || 'Could not save that', 'error');
      }
    });
    marketSelect.addEventListener('change', async () => {
      try {
        const r = await api('/api/email/preferences', { method: 'PUT', body: JSON.stringify({ home_market: marketSelect.value || null }) });
        showReportSchedule(r);
        emailPrefMsg(`Reports are timed for ${r.report.market_label}.`);
      } catch (err) {
        emailPrefMsg(err.message || 'Could not save that', 'error');
      }
    });
    zoneSelect.addEventListener('change', async () => {
      try {
        const r = await api('/api/email/preferences', { method: 'PUT', body: JSON.stringify({ time_zone: zoneSelect.value || null }) });
        showReportSchedule(r);
        emailPrefMsg(r.time_zone ? `Your time zone is ${zoneLabel(r.time_zone)}.` : `Your time zone follows your main market (${r.report.market_label}).`);
      } catch (err) {
        emailPrefMsg(err.message || 'Could not save that', 'error');
      }
    });
    // Pressing it shows it is working ("Sending…", greyed out), then holds it greyed for a
    // short countdown so it is clear the press registered and when another try is possible.
    const VERIFY_LABEL = btn.textContent;
    const VERIFY_COOLDOWN_SECONDS = 30;
    let verifyTimer = null;
    const verifyCooldown = (seconds) => {
      clearInterval(verifyTimer);
      let left = seconds;
      const tick = () => {
        if (left <= 0) {
          clearInterval(verifyTimer);
          btn.disabled = false;
          btn.textContent = VERIFY_LABEL;
          return;
        }
        btn.textContent = `Send again in ${left}s`;
        left--;
      };
      tick();
      verifyTimer = setInterval(tick, 1000);
    };
    btn.addEventListener('click', async () => {
      if (btn.disabled) return;
      btn.disabled = true;
      btn.textContent = 'Sending…';
      emailPrefMsg('Sending the verification link…');
      try {
        const r = await api('/api/auth/resend-verification', { method: 'POST' });
        emailPrefMsg(r.message);
        if (r.email_verified) {
          clearInterval(verifyTimer);
          btn.classList.add('hidden');
          status.textContent = 'Verified';
          status.className = 'email-verify-status ok';
          return;
        }
      } catch (err) {
        emailPrefMsg(err.message || 'Could not send the link', 'error');
      }
      verifyCooldown(VERIFY_COOLDOWN_SECONDS);
    });
  }
  try {
    const p = await api('/api/email/preferences');
    toggle.checked = !!p.email_alerts;
    reportsToggle.checked = !!p.email_reports;
    marketSelect.value = p.home_market || '';
    fillTimeZoneSelect(zoneSelect, p.time_zone);
    showReportSchedule(p);
    document.getElementById('email-verify-row').classList.remove('hidden');
    status.textContent = p.email_verified ? 'Verified' : 'Not verified — alert and report emails are only sent to a verified address';
    status.className = `email-verify-status ${p.email_verified ? 'ok' : 'warn'}`;
    btn.classList.toggle('hidden', !!p.email_verified);
  } catch { /* leave the controls as they are */ }
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

// India side of the two tabs (NSE bulk/block deals + insider trades). The US/India switch
// is shared by both tabs and only shown when the server has INDIA_SMART_MONEY on.
let smMarket = 'us';
let indiaSmartMoneyOn = false;
let inDealsScope = 'mine';
let inInsidersScope = 'mine';
let cachedInInvestors = [];
let cachedInDeals = [];
let cachedInInsiders = [];
let inDealsTeaser = null;
let inInsidersTeaser = null;
let inDealsSearchQuery = '';
let inInsidersSearchQuery = '';
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
  await Promise.all([loadFollows(), loadInstitutions(), loadCongress(), loadSmartMoneyMeta(), loadIndiaMeta()]);
  if (smMarket === 'in') loadIndiaSmartMoney();
}

// ── India: bulk/block deals + insider trades ──
// ₹ in crore (1e7) and lakh (1e5), the units Indian readers use.
function fmtInr(n) {
  const v = Number(n);
  if (n == null || !Number.isFinite(v)) return '—';
  if (v >= 1e7) return `₹${(v / 1e7).toFixed(v >= 1e9 ? 0 : 1)} Cr`;
  if (v >= 1e5) return `₹${(v / 1e5).toFixed(1)} L`;
  return `₹${Math.round(v).toLocaleString('en-IN')}`;
}
function fmtIndianCount(n) {
  const v = Number(n);
  if (n == null || !Number.isFinite(v)) return '—';
  if (v >= 1e7) return `${(v / 1e7).toFixed(2)} Cr`;
  if (v >= 1e5) return `${(v / 1e5).toFixed(2)} L`;
  return Math.round(v).toLocaleString('en-IN');
}

async function loadIndiaMeta() {
  try {
    const meta = await api('/api/smart-money/india/meta');
    indiaSmartMoneyOn = !!meta.enabled;
  } catch (err) { indiaSmartMoneyOn = false; }
  document.querySelectorAll('.market-switch').forEach(el => el.classList.toggle('hidden', !indiaSmartMoneyOn));
  if (!indiaSmartMoneyOn && smMarket !== 'us') setSmartMoneyMarket('us');
}

function setSmartMoneyMarket(market) {
  smMarket = market === 'in' ? 'in' : 'us';
  document.querySelectorAll('.market-btn').forEach(b => b.classList.toggle('active', b.dataset.market === smMarket));
  document.querySelectorAll('[data-market-pane]').forEach(el => el.classList.toggle('hidden', el.dataset.marketPane !== smMarket));
  if (smMarket === 'in') loadIndiaSmartMoney();
}

async function loadIndiaSmartMoney() {
  await Promise.all([loadIndiaInvestors(), loadIndiaDeals(), loadIndiaInsiders()]);
}

async function loadIndiaInvestors() {
  try {
    const data = await api('/api/smart-money/india/investors');
    cachedInInvestors = data.investors || [];
    renderIndiaInvestors();
  } catch (err) { console.error('India investors load error:', err); }
}

function renderIndiaInvestors() {
  const box = document.getElementById('in-investors');
  if (!box) return;
  box.innerHTML = cachedInInvestors.map(i => {
    const following = cachedFollows.has(followKey('in_investor', i.slug));
    const title = i.deals ? `${i.deals} deal${i.deals === 1 ? '' : 's'} on record, latest ${fmtDate(i.latest_deal)}` : 'No deals on record yet';
    return `<button class="congress-follow ${following ? 'following' : ''}" title="${escapeHtml(title)}"
      onclick="toggleFollow('in_investor','${i.slug}', ${JSON.stringify(i.name).replace(/"/g, '&quot;')}, this)">${following ? '✓' : '+'} ${escapeHtml(i.name)}</button>`;
  }).join('');
}

async function loadIndiaDeals() {
  try {
    const data = await api(`/api/smart-money/india/deals?scope=${inDealsScope}&limit=200`);
    cachedInDeals = data.deals || [];
    inDealsTeaser = data.teaser ? { total: data.total } : null;
    renderIndiaDeals();
  } catch (err) { console.error('India deals load error:', err); }
}

function renderIndiaDeals() {
  const list = document.getElementById('in-deals-list');
  if (!list) return;
  if (cachedInDeals.length === 0) {
    list.innerHTML = `<div class="empty-state small"><p>${inDealsScope === 'mine' ? 'No bulk or block deals in your Indian holdings or by investors you follow yet. Switch to "All" or follow an investor above.' : 'No bulk or block deals ingested yet.'}</p></div>`;
    return;
  }
  const q = inDealsSearchQuery.toLowerCase();
  const deals = q
    ? cachedInDeals.filter(d => `${d.client_name || ''} ${d.investor_name || ''} ${d.ticker || ''} ${d.security_name || ''}`.toLowerCase().includes(q))
    : cachedInDeals;
  if (deals.length === 0) {
    list.innerHTML = `<div class="empty-state small"><p>No deals match “${escapeHtml(inDealsSearchQuery)}”.</p></div>`;
    return;
  }
  list.innerHTML = deals.map(d => {
    const side = d.side === 'sell' ? 'sell' : 'buy';
    return `
      <div class="congress-item">
        <span class="trade-side ${side}">${side}</span>
        <div class="congress-main">
          <div class="congress-pol">${escapeHtml(d.client_name)} <span class="pol-meta">· ${d.deal_type === 'block' ? 'block' : 'bulk'} deal</span>${d.investor_name ? ` <span class="in-tracked">${escapeHtml(d.investor_name)}</span>` : ''}</div>
          <div class="congress-sub">
            <span class="ct-ticker">${escapeHtml(d.ticker)}</span> — ${escapeHtml(d.security_name || '')} · ${fmtIndianCount(d.quantity)} shares at ₹${escapeHtml(String(d.price))} · ${fmtInr(d.value)}
          </div>
        </div>
        <div class="congress-dates">traded ${fmtDate(d.deal_date)}</div>
      </div>`;
  }).join('');
  if (inDealsTeaser && !inDealsSearchQuery) {
    list.insertAdjacentHTML('beforeend', upgradeNote(`Showing ${cachedInDeals.length} of ${inDealsTeaser.total} deals — unlock the full feed on Plus.`));
  }
}

async function loadIndiaInsiders() {
  try {
    const data = await api(`/api/smart-money/india/insiders?scope=${inInsidersScope}&limit=200`);
    cachedInInsiders = data.trades || [];
    inInsidersTeaser = data.teaser ? { total: data.total } : null;
    renderIndiaInsiders();
  } catch (err) { console.error('India insider trades load error:', err); }
}

function renderIndiaInsiders() {
  const list = document.getElementById('in-insiders-list');
  if (!list) return;
  if (cachedInInsiders.length === 0) {
    list.innerHTML = `<div class="empty-state small"><p>${inInsidersScope === 'mine' ? 'No insider trades disclosed in your Indian holdings yet. Switch to "All" to see every company we track.' : 'No insider trades ingested yet.'}</p></div>`;
    return;
  }
  const q = inInsidersSearchQuery.toLowerCase();
  const trades = q
    ? cachedInInsiders.filter(t => `${t.person || ''} ${t.ticker || ''} ${t.company || ''} ${t.category || ''}`.toLowerCase().includes(q))
    : cachedInInsiders;
  if (trades.length === 0) {
    list.innerHTML = `<div class="empty-state small"><p>No insider trades match “${escapeHtml(inInsidersSearchQuery)}”.</p></div>`;
    return;
  }
  list.innerHTML = trades.map(t => {
    // pledge / other reuse the neutral badge colour
    const badge = t.side === 'buy' || t.side === 'sell' ? t.side : 'exchange';
    const lag = lagDays(t.trade_to || t.trade_from, t.disclosed_at);
    // Insiders also report debentures, warrants and the like — name the security when it is not a share.
    const unit = !t.security_type || /equity/i.test(t.security_type) ? 'shares'
      : /^any other/i.test(t.security_type) ? 'units' : escapeHtml(t.security_type.toLowerCase());
    const stake = t.pct_before != null && t.pct_after != null && (t.pct_before || t.pct_after)
      ? ` · stake ${Number(t.pct_before).toFixed(2)}% → ${Number(t.pct_after).toFixed(2)}%` : '';
    return `
      <div class="congress-item">
        <span class="trade-side ${badge}">${escapeHtml(t.side)}</span>
        <div class="congress-main">
          <div class="congress-pol">${escapeHtml(t.person)} <span class="pol-meta">${t.category ? `(${escapeHtml(t.category)})` : ''}${t.mode ? ` · ${escapeHtml(t.mode)}` : ''}</span></div>
          <div class="congress-sub">
            <span class="ct-ticker">${escapeHtml(t.ticker)}</span> — ${escapeHtml(t.company || '')}${t.quantity != null ? ` · ${fmtIndianCount(t.quantity)} ${unit}` : ''}${Number(t.value) > 0 ? ` · ${fmtInr(t.value)}` : ''}${stake}
          </div>
        </div>
        <div class="congress-dates">
          traded ${fmtDate(t.trade_from)}<br>
          disclosed ${fmtDate(t.disclosed_at)}${lag != null && lag >= 0 ? ` <span class="lag">(+${lag}d)</span>` : ''}
        </div>
      </div>`;
  }).join('');
  if (inInsidersTeaser && !inInsidersSearchQuery) {
    list.insertAdjacentHTML('beforeend', upgradeNote(`Showing ${cachedInInsiders.length} of ${inInsidersTeaser.total} insider trades — unlock the full feed on Plus.`));
  }
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
      await api('/api/smart-money/follow', { method: 'POST', body: JSON.stringify({ entity_type: type, entity_ref: type === 'politician' ? label : ref, label }) });
      cachedFollows.add(key);
      showToast(`Following ${label}`, 'success');
    }
    renderInstitutions();
    if (type === 'in_investor') {
      // Following an Indian investor changes the "mine" list of deals.
      renderIndiaInvestors();
      loadIndiaDeals();
      return;
    }
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

// ── IPO Watch: the calendar of Indian public issues ──
let ipoMarket = 'in';
let ipoBoard = 'mainboard';
let ipoSpacs = '0';
let ipoUsView = 'all';
const IPO_STAGE_LABEL = { announced: 'Announced', upcoming: 'Upcoming', open: 'Open', closed: 'Awaiting listing', listed: 'Listed', withdrawn: 'Withdrawn' };

// "2026-10-14" → "14 Oct"; the year is added only when it is not this one.
function ipoDay(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return '—';
  const mon = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][Number(m[2]) - 1];
  return `${Number(m[3])} ${mon}${Number(m[1]) === new Date().getFullYear() ? '' : ` ${m[1]}`}`;
}

function ipoPriceBand(i) {
  if (i.price_low == null && i.price_high == null) return '—';
  if (i.price_low == null || i.price_high == null || i.price_low === i.price_high) return `₹${i.price_high ?? i.price_low}`;
  return `₹${i.price_low} – ₹${i.price_high}`;
}

// Grey market premium: ₹ over the issue price, its share of the top price, and which way it
// moved since the reading before. "—" when there is no fresh reading.
function ipoGmpCell(i) {
  if (i.gmp == null) return '—';
  const pct = i.gmp_pct == null ? '' : ` <span class="ipo-meta-inline">(${i.gmp_pct > 0 ? '+' : ''}${i.gmp_pct}%)</span>`;
  const move = i.gmp_prev == null || i.gmp_prev === i.gmp ? '' : i.gmp > i.gmp_prev ? ' <span class="ipo-gmp-up" title="Up from ₹' + i.gmp_prev + '">▲</span>' : ' <span class="ipo-gmp-down" title="Down from ₹' + i.gmp_prev + '">▼</span>';
  return `<span title="Unofficial grey market figure via ${escapeHtml(i.gmp_source || 'an aggregator')}, read ${fmtDate(i.gmp_at)}">${i.gmp < 0 ? '−' : ''}₹${Math.abs(i.gmp)}${pct}${move}</span>`;
}

// A graduated issue's company is in the reference, so it can go straight into the portfolio.
function ipoAddButton(i) {
  if (!i.graduated || !i.symbol) return '';
  const held = holdings.some(h => h.ticker === i.symbol);
  return held ? ' · <span title="In your portfolio">held</span>'
    : ` · <button type="button" class="ipo-add" data-add-ticker="${escapeHtml(i.symbol)}" title="Add ${escapeHtml(i.symbol)} to your portfolio">+ Portfolio</button>`;
}

// The button sits inside a row that opens the news on click, so its click stops there.
function wireIpoAddButtons(box) {
  box.querySelectorAll('.ipo-add').forEach(b => b.addEventListener('click', (e) => { e.stopPropagation(); ipoAddToPortfolio(b); }));
}

async function ipoAddToPortfolio(btn) {
  const ticker = btn.dataset.addTicker;
  btn.disabled = true;
  try {
    const res = await api('/api/portfolio', { method: 'POST', body: JSON.stringify({ ticker, asset_class: 'equity' }) });
    if (res.holding) { holdings.push(res.holding); document.getElementById('holdings-count').textContent = holdings.length; renderHoldings(); }
    showToast(`${ticker} added to portfolio`, 'success');
    btn.outerHTML = '<span title="In your portfolio">held</span>';
  } catch (err) {
    showToast(err.message || `Could not add ${ticker}`, 'error');
    btn.disabled = false;
  }
}

// Under the listing date of a listed issue: the price it listed at and the gain over the issue price.
function ipoListingNote(i, cur = '₹') {
  if (i.listing_price == null && i.listing_gain_pct == null) return '';
  const g = i.listing_gain_pct;
  const gain = g == null ? '' : ` (${g > 0 ? '+' : g < 0 ? '−' : ''}${Math.abs(g).toFixed(1)}%)`;
  const price = i.listing_price == null ? 'listed' : `at ${i.listing_price_derived ? `≈${cur}${i.listing_price >= 100 ? Math.round(i.listing_price) : i.listing_price.toFixed(1)}` : `${cur}${i.listing_price}`}`;
  const tip = i.listing_price_derived ? 'Gain over the issue price as reported; the price is worked back from it' : 'Listing price and gain over the issue price';
  // Later closes, each as a return over the issue price, as they come due.
  const pct = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}%`;
  const later = [['day close', i.ret_listing_day_pct], ['1w', i.ret_1w_pct], ['1m', i.ret_1m_pct], ['3m', i.ret_3m_pct]].filter(([, v]) => v != null);
  return `<span class="ipo-meta ipo-lot" title="${tip}">${price}${gain}</span>${
    later.length ? `<span class="ipo-meta" title="Closing price against the issue price">${later.map(([k, v]) => `${k} ${pct(v)}`).join(' · ')}</span>` : ''}`;
}

// Subscription: times the issue was bid for, with the split by investor class beneath and
// the day the figures are as of on hover.
function ipoSubCell(i) {
  if (i.sub_total == null) return '—';
  const x = (v) => (v >= 100 ? Math.round(v) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
  const parts = [['QIB', i.sub_qib], ['NII', i.sub_nii], ['Retail', i.sub_retail]].filter(([, v]) => v != null);
  return `<span title="Times subscribed, as of ${fmtDate(i.sub_on)}">${x(i.sub_total)}x</span>${
    parts.length ? `<span class="ipo-meta">${parts.map(([k, v]) => `${k} ${x(v)}`).join(' · ')}</span>` : ''}`;
}

async function loadIpoCalendar() {
  const box = document.getElementById('ipo-calendar');
  if (!box) return;
  const us = ipoMarket === 'us';
  const wire = (id, key, get, set) => document.querySelectorAll(`#${id} .scope-btn`).forEach(b => {
    b.classList.toggle('active', b.dataset[key] === get());
    b.onclick = () => { set(b.dataset[key]); loadIpoCalendar(); };
  });
  wire('ipo-market-toggle', 'market', () => ipoMarket, v => { ipoMarket = v; });
  wire('ipo-board-toggle', 'board', () => ipoBoard, v => { ipoBoard = v; });
  wire('ipo-spac-toggle', 'spacs', () => ipoSpacs, v => { ipoSpacs = v; });
  wire('ipo-us-view-toggle', 'view', () => ipoUsView, v => { ipoUsView = v; });
  document.getElementById('ipo-us-view-toggle').classList.toggle('hidden', !us);
  document.getElementById('ipo-board-toggle').classList.toggle('hidden', us);      // boards are India's
  document.getElementById('ipo-spac-toggle').classList.toggle('hidden', !us);
  box.innerHTML = '<div class="loading-skeleton"><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>';
  let data;
  try { data = await api(us ? `/api/ipo-watch/calendar?market=us&spacs=${ipoSpacs}` : `/api/ipo-watch/calendar?market=in&board=${ipoBoard}`); }
  catch (err) {
    box.innerHTML = `<div class="empty-state"><p>${escapeHtml(err.message || 'Could not load the IPO calendar')}</p></div>`;
    return;
  }
  const issues = data.issues || [];
  ipoIssues = new Map(issues.map(i => [String(i.id), i]));
  const note = document.getElementById('ipo-source-note');
  if (note) note.textContent = !issues.length ? ''
    : us ? 'From Finnhub\'s IPO calendar. A filed issue has no price or listing day yet, and expected dates can move; check the prospectus before acting.'
    : 'Dates and prices are compiled from unofficial sources and can change; check the offer document before acting. GMP (grey market premium) is an unofficial, unregulated figure and does not predict the listing price.';
  if (issues.length === 0) {
    box.innerHTML = `<div class="empty-state"><p>No ${us ? 'US ' : ipoBoard === 'all' ? '' : ipoBoard === 'sme' ? 'SME ' : 'mainboard '}issues on the calendar yet.</p></div>`;
    return;
  }
  if (us) {
    // "Deals" leaves out the filings and withdrawals: only issues with a price and a date.
    const shown = ipoUsView === 'deals' ? issues.filter(i => ['upcoming', 'closed', 'listed'].includes(i.stage)) : issues;
    if (!shown.length) { box.innerHTML = '<div class="empty-state"><p>No expected or priced US deals right now.</p></div>'; return; }
    box.innerHTML = renderUsIpoTable(shown);
    box.querySelectorAll('tr[data-ipo]').forEach(tr => tr.addEventListener('click', () => toggleIpoStories(tr)));
    wireIpoAddButtons(box);
    return;
  }
  box.innerHTML = `
    <div class="ipo-table-wrap">
      <table class="holdings-tbl ipo-tbl">
        <thead><tr><th>Company</th><th>Stage</th><th>Opens</th><th>Closes</th><th>Lists</th><th>Price band</th><th title="Grey market premium: unofficial, per share over the issue price">GMP</th><th title="Times the shares on offer were bid for: QIB = institutions, NII = non-institutional (HNI), Retail = individuals">Subscribed</th><th>Issue size</th></tr></thead>
        <tbody>${issues.map(i => `
          <tr ${i.stories ? `class="ipo-row-click" data-ipo="${i.id}" title="Show the news on this issue"` : ''}>
            <td><span class="ipo-name">${escapeHtml(i.name)}</span>
                <span class="ipo-meta">${i.board === 'sme' ? 'SME' : 'Mainboard'}${i.exchange ? ` · ${escapeHtml(i.exchange)}` : ''}${i.symbol ? ` · ${escapeHtml(i.symbol)}` : ''}${i.stories ? ` · ${i.stories} ${i.stories === 1 ? 'story' : 'stories'}` : ''}${ipoAddButton(i)}</span></td>
            <td><span class="ipo-stage ${i.stage}">${IPO_STAGE_LABEL[i.stage] || escapeHtml(i.stage)}</span></td>
            <td class="mono">${ipoDay(i.open_date)}</td>
            <td class="mono">${ipoDay(i.close_date)}</td>
            <td class="mono">${ipoDay(i.listing_date)}${ipoListingNote(i)}</td>
            <td class="mono">${ipoPriceBand(i)}${i.lot_size ? `<span class="ipo-meta ipo-lot">lot of ${i.lot_size.toLocaleString('en-IN')}</span>` : ''}</td>
            <td class="mono">${ipoGmpCell(i)}</td>
            <td class="mono">${ipoSubCell(i)}</td>
            <td class="mono">${i.issue_size_cr != null ? fmtInr(i.issue_size_cr * 1e7) : '—'}</td>
          </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
  box.querySelectorAll('tr[data-ipo]').forEach(tr => tr.addEventListener('click', () => toggleIpoStories(tr)));
  wireIpoAddButtons(box);
}

// The US table. A US issue has a ticker and a stated status from the day it files, and no
// lot size, grey market or subscription figures.
const IPO_US_STAGE_LABEL = { announced: 'Filed', upcoming: 'Expected', closed: 'Priced', listed: 'Trading', withdrawn: 'Withdrawn' };
const IPO_US_DATE_LABEL = { announced: 'filed', withdrawn: 'withdrawn' };

function ipoUsPrice(i) {
  const d = (v) => `$${Number(v).toFixed(2)}`;
  if (i.price_high == null) return '—';
  return i.price_low != null && i.price_low !== i.price_high ? `${d(i.price_low)} – ${d(i.price_high)}` : d(i.price_high);
}

function renderUsIpoTable(issues) {
  return `
    <div class="ipo-table-wrap">
      <table class="holdings-tbl ipo-tbl">
        <thead><tr><th>Company</th><th>Stage</th><th>Date</th><th>Price</th><th>Shares</th><th>Deal size</th></tr></thead>
        <tbody>${issues.map(i => {
          const day = i.first_trade_date || i.listing_date || i.status_date;
          return `
          <tr ${i.stories ? `class="ipo-row-click" data-ipo="${i.id}" title="Show the news on this issue"` : ''}>
            <td><span class="ipo-name">${escapeHtml(i.name)}</span>
                <span class="ipo-meta">${[i.exchange, i.symbol, i.is_spac ? 'SPAC' : '', i.stories ? `${i.stories} ${i.stories === 1 ? 'story' : 'stories'}` : ''].filter(Boolean).map(escapeHtml).join(' · ') || '—'}${ipoAddButton(i)}</span></td>
            <td><span class="ipo-stage ${i.stage}">${IPO_US_STAGE_LABEL[i.stage] || escapeHtml(i.stage)}</span></td>
            <td class="mono">${ipoDay(day)}${day && IPO_US_DATE_LABEL[i.stage] ? `<span class="ipo-meta ipo-lot">${IPO_US_DATE_LABEL[i.stage]}</span>` : ''}${ipoListingNote(i, '$')}</td>
            <td class="mono">${ipoUsPrice(i)}</td>
            <td class="mono">${i.shares ? fmtMoney(i.shares).replace('$', '') : '—'}</td>
            <td class="mono">${i.issue_size_usd ? fmtMoney(i.issue_size_usd) : '—'}</td>
          </tr>`; }).join('')}
        </tbody>
      </table>
    </div>`;
}

// ── IPO Watch: one issue's news — its tone by day, then the stories ──
let ipoIssues = new Map();

async function toggleIpoStories(tr) {
  const open = tr.nextElementSibling;
  if (open && open.classList.contains('ipo-detail')) { open.remove(); tr.classList.remove('row-active'); return; }
  const issue = ipoIssues.get(tr.dataset.ipo);
  const detail = document.createElement('tr');
  detail.className = 'ipo-detail';
  detail.innerHTML = `<td colspan="${tr.cells.length}"><div class="loading-skeleton"><div class="skeleton-line"></div></div></td>`;
  tr.after(detail);
  tr.classList.add('row-active');
  let data;
  try { data = await api(`/api/ipo-watch/${issue.id}/stories`); }
  catch (err) { detail.firstElementChild.innerHTML = `<div class="empty-state small"><p>${escapeHtml(err.message || 'Could not load the news')}</p></div>`; return; }
  detail.firstElementChild.innerHTML = renderIpoStories(issue, data);
}

// Tone by day as a small chart: 0–100 up the side, a dot per day sized by its story count,
// and the issue's own dates marked. Drawn only when a story has been read.
function ipoArcChart(issue, arc) {
  if (!arc.length) return '';
  const W = 640, H = 150, L = 34, R = 14, T = 16, B = 26;
  const t = (d) => Date.parse(d);
  const marks = [['Opens', issue.open_date], ['Closes', issue.close_date], ['Lists', issue.listing_date]].filter(([, d]) => d);
  const days = [...arc.map(p => p.day), ...marks.map(([, d]) => d)];
  const lo = Math.min(...days.map(t)) - 86400e3, hi = Math.max(...days.map(t)) + 86400e3;
  const x = (d) => L + ((t(d) - lo) / (hi - lo)) * (W - L - R);
  const y = (score) => T + (1 - score) * (H - T - B);
  const pts = arc.map(p => `${x(p.day).toFixed(1)},${y(p.score).toFixed(1)}`).join(' ');
  return `
    <svg class="ipo-arc" viewBox="0 0 ${W} ${H}" role="img" aria-label="Tone of the news on ${escapeHtml(issue.name)} by day">
      ${[0, 0.5, 1].map(v => `<line x1="${L}" x2="${W - R}" y1="${y(v)}" y2="${y(v)}" class="ipo-arc-grid${v === 0.5 ? ' mid' : ''}"/><text x="${L - 6}" y="${y(v) + 3}" class="ipo-arc-axis" text-anchor="end">${v * 100}</text>`).join('')}
      ${marks.map(([label, d]) => `<line x1="${x(d)}" x2="${x(d)}" y1="${T}" y2="${H - B}" class="ipo-arc-mark"/><text x="${x(d)}" y="${T - 5}" class="ipo-arc-axis" text-anchor="middle">${label}</text>`).join('')}
      ${arc.length > 1 ? `<polyline points="${pts}" class="ipo-arc-line"/>` : ''}
      ${arc.map(p => `<circle cx="${x(p.day).toFixed(1)}" cy="${y(p.score).toFixed(1)}" r="${Math.min(8, 3 + p.stories)}" class="ipo-arc-dot"><title>${ipoDay(p.day)}: ${Math.round(p.score * 100)} from ${p.stories} ${p.stories === 1 ? 'story' : 'stories'}</title></circle>`).join('')}
      <text x="${L}" y="${H - 6}" class="ipo-arc-axis">${ipoDay(days.reduce((a, b) => (t(a) < t(b) ? a : b)))}</text>
      <text x="${W - R}" y="${H - 6}" class="ipo-arc-axis" text-anchor="end">${ipoDay(days.reduce((a, b) => (t(a) > t(b) ? a : b)))}</text>
    </svg>`;
}

function renderIpoStories(issue, { stories, arc, tone }) {
  const head = tone
    ? `Tone of the news: <span class="ht-senti-label ${tone.label}">${tone.label}</span> <span class="mono">${Math.round(tone.score * 100)}</span> of 100, from ${tone.stories} ${tone.stories === 1 ? 'story' : 'stories'} read`
    : 'No story on this issue has been read for tone yet.';
  return `
    <div class="ipo-stories">
      <p class="ipo-stories-head">${head}</p>
      ${ipoArcChart(issue, arc)}
      <ul class="ipo-story-list">${stories.map(s => `
        <li>
          ${s.sentiment ? `<span class="ht-senti-label ${escapeHtml(s.sentiment.label)}" title="${s.sentiment.model === 'subscription-rule' ? 'Scored from the subscription figure in the headline, not from its wording' : 'Tone of the headline and summary'}">${Math.round(s.sentiment.score * 100)}</span>` : '<span class="ht-senti-label neutral" title="Not read for tone">–</span>'}
          <div>
            ${/^https?:\/\//.test(s.url || '') ? `<a href="${escapeHtml(s.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(s.title)}</a>` : escapeHtml(s.title)}
            <span class="ipo-meta">${escapeHtml(s.source || '')} · ${ipoDay(s.day)}${s.shared ? ' · covers several issues, so not read for tone' : s.passing ? ' · names this issue only in passing, so not read for tone' : ''}</span>
          </div>
        </li>`).join('')}
      </ul>
    </div>`;
}

// Top-level page switcher (called from nav tabs and inline onclick).
const STRATEGY_PAGES = ['strategy-builder', 'strategies', 'backtest', 'paper-trade'];
const strategiesEnabled = () => !document.body.classList.contains('no-strategies');

function switchToPage(page) {
  if (STRATEGY_PAGES.includes(page) && !strategiesEnabled()) page = 'dashboard';
  if (page === 'ipo-watch' && document.body.classList.contains('no-ipo-watch')) page = 'dashboard';
  document.querySelectorAll('.main-tab').forEach(t => t.classList.toggle('active', t.dataset.page === page));
  document.querySelectorAll('.page').forEach(p => p.classList.toggle('hidden', p.id !== `page-${page}`));
  if (page === 'analytics') loadAnalytics();
  if (page === 'ai') { loadDailyBrief(); loadAskThreads(); }
  if (page === 'profile') { populateProfilePage(currentUser); loadPlans(); loadApiKeys(); loadEmailPrefs(); }
  if (page === 'ipo-watch') loadIpoCalendar();
  if (page === 'backtest') initBacktestPage();
  if (page === 'strategy-builder') initBuilderPage();
  if (page === 'strategies') initStrategiesPage();
  if (page === 'paper-trade') initPaperPage();
  moveNavIndicator();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function initMainTabs() {
  document.querySelectorAll('.main-tab').forEach(tab => {
    tab.addEventListener('click', () => switchToPage(tab.dataset.page));
  });
  window.addEventListener('resize', moveNavIndicator);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(moveNavIndicator);
  moveNavIndicator();
}

// Slide the active-tab indicator under (horizontal bar) or beside (sidebar) the active tab.
// Hidden when no tab is active (e.g. the Profile page).
function moveNavIndicator() {
  const nav = document.querySelector('.main-nav');
  if (!nav) return;
  let bar = nav.querySelector('.main-nav-indicator');
  if (!bar) {
    bar = document.createElement('span');
    bar.className = 'main-nav-indicator';
    bar.setAttribute('aria-hidden', 'true');
    nav.appendChild(bar);
  }
  const active = nav.querySelector('.main-tab.active');
  if (!active || active.offsetParent === null) { bar.style.opacity = '0'; return; }
  const sidebar = window.matchMedia('(min-width: 1024px)').matches;
  if (sidebar) {
    bar.style.width = '';
    bar.style.height = `${active.offsetHeight - 16}px`;
    bar.style.transform = `translateY(${active.offsetTop + 8}px)`;
  } else {
    bar.style.height = '';
    bar.style.width = `${active.offsetWidth - 24}px`;
    bar.style.transform = `translateX(${active.offsetLeft + 12}px)`;
    active.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }
  bar.style.opacity = '1';
}

// ─── Backtest page (Phase 7 — strategy engine) ───────────────
let btCatalog = null;       // strategy list from the engine, loaded once per session
let btChart = null;         // Chart.js instance for the equity curve
let btInitDone = false;
let btLastBody = null;      // body of the last successful backtest (re-used by the robustness check)

async function initBacktestPage() {
  if (!btInitDone) {
    btInitDone = true;
    document.getElementById('bt-form').addEventListener('submit', runBacktest);
    document.getElementById('bt-wf-run').addEventListener('click', runWalkForward);
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
    btLastBody = body;
    document.getElementById('bt-wf-body').innerHTML = '';
    renderBtResults(data);
    renderBtCompareOffer();
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

// "Did the SenIQ signal help?" — offered after a backtest of a Builder strategy that uses
// SenIQ signals. Runs the same strategy again with those conditions removed
// (POST /api/strategies/compare) and shows both side by side, caveats included.
function renderBtCompareOffer() {
  const el = document.getElementById('bt-compare');
  if (!el) return;
  const spec = btLastBody && btLastBody.custom;
  const usesSeniq = spec && (spec.factors || []).some((f) => f.source === 'seniq');
  el.classList.toggle('hidden', !usesSeniq);
  if (!usesSeniq) { el.innerHTML = ''; return; }
  el.innerHTML = `<div class="bt-compare-head">
      <div><strong>Did the SenIQ signals help?</strong><span class="bt-compare-sub">Runs this strategy again with its SenIQ conditions removed, over the same symbol and dates.</span></div>
      <button type="button" class="btn btn-ghost btn-sm" id="bt-compare-run"><span class="material-symbols-outlined">compare_arrows</span> Compare without SenIQ signals</button>
    </div><div id="bt-compare-body"></div>`;
  document.getElementById('bt-compare-run').addEventListener('click', runBtCompare);
}

async function runBtCompare() {
  const btn = document.getElementById('bt-compare-run');
  const body = document.getElementById('bt-compare-body');
  btn.disabled = true;
  body.innerHTML = '<div class="bt-compare-note">Running two backtests…</div>';
  try {
    const d = await api('/api/strategies/compare', { method: 'POST', body: JSON.stringify(btLastBody) });
    const p = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}%`);
    const cls = (v) => (v == null || v === 0 ? '' : v > 0 ? 'pos' : 'neg');
    const row = (label, a, b, diff, fmt = p) => `<tr><td>${label}</td><td>${fmt(a)}</td><td>${fmt(b)}</td><td class="${cls(diff)}">${diff == null ? '—' : fmt(diff)}</td></tr>`;
    const n = (v) => (v == null ? '—' : String(v));
    const signed = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}`);
    body.innerHTML = `<table class="bt-compare-table">
        <thead><tr><th></th><th>With SenIQ signals</th><th>Price rules only</th><th>Difference</th></tr></thead>
        <tbody>
          ${row('Total return', d.with_seniq.return_pct, d.without_seniq.return_pct, d.difference.return_pct)}
          ${row('Max drawdown', d.with_seniq.max_drawdown_pct, d.without_seniq.max_drawdown_pct, d.difference.max_drawdown_pct)}
          <tr><td>Trades</td><td>${n(d.with_seniq.trades)}</td><td>${n(d.without_seniq.trades)}</td><td>${signed(d.difference.trades)}</td></tr>
        </tbody>
      </table>
      <div class="bt-compare-note">Buy and hold over the same period: <strong>${p(d.buy_hold_return_pct)}</strong> · ${d.seniq_conditions_removed} SenIQ ${d.seniq_conditions_removed === 1 ? 'condition' : 'conditions'} removed for the price-only run.</div>
      <ul class="bt-compare-caveats">${(d.notes || []).map((x) => `<li>${escapeHtml(x)}</li>`).join('')}</ul>`;
  } catch (err) {
    body.innerHTML = `<div class="bt-compare-note warn">${escapeHtml(err.status === 503 ? 'The strategy engine is offline. Start it and try again.' : (err.message || 'The comparison could not be run.'))}</div>`;
  } finally {
    btn.disabled = false;
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
    `${req.start_date} → ${req.end_date} · ${data.n_bars} bars · ${data.provider.name}` +
    // Cash-limited entries the trade list can't show: buys cut down to the cash available
    // at the fill price, and buys skipped because cash didn't cover one share.
    (data.orders && data.orders.reduced ? ` · ${data.orders.reduced} ${data.orders.reduced === 1 ? 'entry' : 'entries'} sized down to available cash` : '') +
    (data.orders && data.orders.unaffordable ? ` · ${data.orders.unaffordable} ${data.orders.unaffordable === 1 ? 'entry' : 'entries'} skipped (not enough cash for one share)` : '');

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
  // The question a single-symbol backtest has to answer: did the rules beat just holding it?
  const bench = data.report.benchmark;
  if (bench && bench.points && bench.points.length) {
    const alpha = Number(bench.alpha_total_pct);
    cards.splice(1, 0,
      { label: 'Buy & hold', value: btPct(bench.benchmark_total_return_pct) },
      { label: 'vs buy & hold', value: `${alpha >= 0 ? '+' : ''}${btPct(alpha)}`, cls: alpha >= 0 ? 'pos' : 'neg' });
  }
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
        borderColor: positive ? '#14B86A' : '#EF4444',
        backgroundColor: positive ? 'rgba(20,184,106,0.08)' : 'rgba(239,68,68,0.08)',
        fill: true, pointRadius: 0, borderWidth: 2, tension: 0.1,
      }, ...(bench && bench.points && bench.points.length ? [{
        label: 'Buy & hold',
        data: bench.points.map(p => Number(p.benchmark_equity)),
        borderColor: '#64748B', borderDash: [5, 4],
        fill: false, pointRadius: 0, borderWidth: 1.5, tension: 0.1,
      }] : [])],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: !!(bench && bench.points && bench.points.length), labels: { color: '#64748B', boxWidth: 18 } } },
      interaction: { mode: 'index', intersect: false },
      scales: {
        x: { ticks: { maxTicksLimit: 8, color: '#64748B' }, grid: { display: false } },
        y: { ticks: { color: '#64748B' }, grid: { color: '#EEF2F7' } },
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

// Robustness check: the same rules on each in-sample stretch and the unseen stretch after it.
async function runWalkForward() {
  if (!btLastBody) return;
  const btn = document.getElementById('bt-wf-run');
  const out = document.getElementById('bt-wf-body');
  btn.disabled = true;
  btn.innerHTML = '<span class="material-symbols-outlined spin">progress_activity</span> Checking…';
  try {
    const data = await api('/api/strategies/walk-forward', { method: 'POST', body: JSON.stringify({ ...btLastBody, n_splits: 4 }) });
    const wf = data.walk_forward, s = wf.summary;
    const VERDICT_TEXT = {
      robust: 'Held up on data it wasn\'t judged on.',
      moderate: 'Profitable out of sample, but not consistently.',
      fragile: 'Results did not carry over to unseen data.',
      insufficient_data: 'Not enough data in these windows to judge — try a longer date range.',
    };
    const cell = (v) => v == null ? '<td>—</td>' : `<td class="${Number(v) >= 0 ? 'pos' : 'neg'}">${btPct(v)}</td>`;
    out.innerHTML = `
      <div class="bt-wf-verdict">
        <span class="bt-wf-pill ${escapeHtml(s.verdict)}">${escapeHtml(s.verdict.replace('_', ' '))}</span>
        <span>${VERDICT_TEXT[s.verdict] || ''}</span>
        <span class="brief-muted">${s.n_valid_folds} of ${s.n_folds} folds usable${s.oos_consistency != null ? ` · profitable in ${btPct(s.oos_consistency)} of unseen windows` : ''}</span>
      </div>
      <div class="bt-trades-scroll"><table class="bt-wf-table">
        <thead><tr><th>Fold</th><th>Judged on</th><th>Return</th><th>Then tested on</th><th>Return</th><th>Max drawdown</th><th>Trades</th></tr></thead>
        <tbody>${wf.folds.map(f => `<tr>
          <td>${f.index}</td>
          <td>${f.is_start} → ${f.is_end}</td>${cell(f.is_metrics && f.is_metrics.total_return_pct)}
          <td>${f.oos_start} → ${f.oos_end}</td>${cell(f.oos_metrics && f.oos_metrics.total_return_pct)}
          <td>${f.oos_metrics ? btPct(f.oos_metrics.max_drawdown_pct) : '—'}</td>
          <td>${f.oos_metrics ? f.oos_metrics.n_trades : '—'}</td>
        </tr>`).join('')}</tbody>
      </table></div>`;
  } catch (err) {
    out.innerHTML = `<p class="bt-wf-hint">${escapeHtml(err.status === 503 ? 'The strategy engine is offline.' : (err.message || 'Robustness check failed'))}</p>`;
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<span class="material-symbols-outlined">fact_check</span> Run check';
  }
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
  'seniq:sentiment_acute': {}, 'seniq:sentiment_avg': {}, 'seniq:sentiment_zscore': {}, 'seniq:news_volume': {},
  // Congress disclosures in a trailing window; politician (optional) follows one member.
  'seniq:congress_net_buys': { window_days: 30, politician: '' },
  'seniq:congress_buys': { window_days: 30, politician: '' },
  'seniq:congress_sells': { window_days: 30, politician: '' },
  'seniq:congress_buyers': { window_days: 45 },
  // Tracked funds' 13F filings (quarterly, US stocks).
  'seniq:funds_holding': {}, 'seniq:funds_net_adds': {}, 'seniq:funds_new_positions': {},
};
const SB_SENIQ_LABELS = {
  'seniq:sentiment_acute': 'Sentiment (dashboard score)',
  'seniq:sentiment_avg': 'Sentiment (daily avg)',
  'seniq:sentiment_zscore': 'Sentiment z-score',
  'seniq:news_volume': 'News volume',
  'seniq:congress_net_buys': 'Congress net buys',
  'seniq:congress_buys': 'Congress buys',
  'seniq:congress_sells': 'Congress sells',
  'seniq:congress_buyers': 'Congress members buying',
  'seniq:funds_holding': 'Tracked funds holding',
  'seniq:funds_net_adds': 'Tracked funds: adds minus cuts',
  'seniq:funds_new_positions': 'Tracked funds: new positions',
};
const SB_PARAM_LABELS = { window_days: 'days', politician: 'member (optional)' };
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
  const ps = Object.values(f.params).filter((v) => v !== '').join(',');
  const base = sbIsSeniq(f.fn) ? sbFnLabel(f.fn) : f.fn.toUpperCase();
  return `${base}${ps ? `(${ps})` : ''}  ·  f${i + 1}`;
}

// Reads the current DOM rows back into the UI model.
function sbReadUi() {
  const ui = { name: document.getElementById('sb-name').value.trim() || 'My strategy', factors: [], entry: [], exit: [] };
  document.querySelectorAll('#sb-factors .sb-row').forEach(row => {
    const fn = row.querySelector('.sb-fn').value;
    const params = {};
    row.querySelectorAll('.sb-param').forEach(inp => {
      params[inp.dataset.p] = inp.dataset.kind === 'text' ? inp.value.replace(/\s+/g, ' ').trim().slice(0, 80) : (Number(inp.value) || 1);
    });
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
  // Optional text params left blank (e.g. no politician chosen) are not sent.
  const filled = (params) => Object.fromEntries(Object.entries(params).filter(([, v]) => v !== ''));
  const factors = ui.factors.map((f, i) => sbIsSeniq(f.fn)
    ? { id: `f${i + 1}`, source: 'seniq', metric: f.fn.slice(6), params: filled(f.params) }
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

// The reverse of sbEmitSpec: a Builder spec (a SenIQ template, or a draft written by Ask) →
// the UI model. The page shows ONE list of entry conditions that must all hold and ONE list
// of exit conditions where any fires, so a spec with nested groups can't be displayed.
// Returns { ok: true, ui } or { ok: false, reason }.
function sbSpecToUi(spec) {
  if (!spec || !Array.isArray(spec.factors)) return { ok: false, reason: 'it has no indicators' };
  const idMap = {};
  const factors = [];
  for (const f of spec.factors) {
    const fn = f.source === 'seniq' ? `seniq:${f.metric}` : f.fn;
    if (!SB_PARAMS[fn]) return { ok: false, reason: `it uses "${f.source === 'seniq' ? f.metric : f.fn}", which this page doesn't list` };
    idMap[f.id] = `f${factors.length + 1}`;
    factors.push({ fn, params: { ...SB_PARAMS[fn], ...(f.params || {}) } });
  }
  const operand = (x) => (typeof x === 'number' ? '__num__' : x === 'close' ? 'price' : idMap[x] || (['price', 'volume'].includes(x) ? x : null));
  const flat = (node, joiner) => {
    if (!node) return [];
    const key = Object.keys(node)[0];
    if (key === 'all' || key === 'any') {
      if (key !== joiner && node[key].length > 1) return null; // "any of" in entry / "all of" in exit
      const out = [];
      for (const child of node[key]) {
        const k = Object.keys(child)[0];
        if (k === 'all' || k === 'any') {
          if (child[k].length > 1) return null; // a nested group
          out.push(child[k][0]);
        } else out.push(child);
      }
      return out;
    }
    return [node];
  };
  const ui = { name: String(spec.name || 'My strategy').slice(0, 80), factors, entry: [], exit: [], stop: '', target: '',
    sizingType: (spec.sizing && spec.sizing.type) || 'percent_equity', sizingValue: (spec.sizing && spec.sizing.value) || 25 };
  for (const [kind, joiner] of [['entry', 'all'], ['exit', 'any']]) {
    const conds = flat(spec[kind], joiner);
    if (!conds) return { ok: false, reason: 'it uses nested rule groups, and this page shows one flat list for entry and one for exit' };
    for (const c of conds) {
      const op = Object.keys(c)[0];
      if (op === 'stop_loss_pct') { ui.stop = String(c[op]); continue; }
      if (op === 'take_profit_pct') { ui.target = String(c[op]); continue; }
      if (!SB_OPS.some((o) => o.v === op) || !Array.isArray(c[op])) return { ok: false, reason: `it uses the rule "${op}", which this page doesn't list` };
      const left = operand(c[op][0]);
      const right = operand(c[op][1]);
      if (!left || left === '__num__' || !right) return { ok: false, reason: 'one of its rules compares something this page cannot show' };
      ui[kind].push({ left, op, right, num: right === '__num__' ? String(c[op][1]) : '' });
    }
  }
  if (!ui.entry.length) return { ok: false, reason: 'it has no entry rule' };
  return { ok: true, ui };
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
      ${Object.entries(f.params).map(([k, v]) => (typeof SB_PARAMS[f.fn]?.[k] === 'string'
        ? `<label class="sb-plabel">${SB_PARAM_LABELS[k] || k}<input class="sb-param sb-param-text" data-p="${k}" data-kind="text" type="text" value="${escapeHtml(String(v ?? ''))}" maxlength="80" placeholder="full name" /></label>`
        : `<label class="sb-plabel">${SB_PARAM_LABELS[k] || k}<input class="sb-param" data-p="${k}" type="number" value="${v}" min="1" max="500" /></label>`)).join('')}
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
  sbInitPresets();

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

// SenIQ templates: ready-made specs that use SenIQ signals (GET /api/strategies/seniq-presets).
// Loading one REPLACES what is in the editor; nothing is saved until the user saves.
let sbPresets = [];
async function sbInitPresets() {
  const wrap = document.getElementById('sb-presets');
  const sel = document.getElementById('sb-preset');
  if (!wrap || !sel) return;
  try { sbPresets = (await api('/api/strategies/seniq-presets')).presets || []; }
  catch { wrap.classList.add('hidden'); return; }
  if (!sbPresets.length) { wrap.classList.add('hidden'); return; }
  sel.innerHTML = '<option value="">Choose a template…</option>' + sbPresets.map((p) => `<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join('');
  const note = document.getElementById('sb-preset-note');
  const inputWrap = document.getElementById('sb-preset-input-wrap');
  sel.addEventListener('change', () => {
    const p = sbPresets.find((x) => x.id === sel.value);
    const inp = p && p.inputs && p.inputs[0];
    inputWrap.classList.toggle('hidden', !inp);
    if (inp) document.getElementById('sb-preset-input-label').textContent = inp.label;
    note.classList.toggle('hidden', !p);
    note.innerHTML = p ? `${escapeHtml(p.description)}<br><strong>History:</strong> ${escapeHtml(p.data_depth)}` : '';
  });
  document.getElementById('sb-preset-load').addEventListener('click', async () => {
    const p = sbPresets.find((x) => x.id === sel.value);
    if (!p) return showToast('Choose a template first', 'error');
    const body = {};
    if (p.inputs && p.inputs[0]) body[p.inputs[0].name] = document.getElementById('sb-preset-input').value;
    try {
      const { spec } = await api(`/api/strategies/seniq-presets/${encodeURIComponent(p.id)}`, { method: 'POST', body: JSON.stringify(body) });
      const out = sbSpecToUi(spec);
      if (!out.ok) return showToast(`This template can't be shown here: ${out.reason}`, 'error');
      sbSaveUi(out.ui); sbRender();
      showToast(`“${out.ui.name}” loaded. Review it, then backtest.`, 'success');
    } catch (err) {
      showToast(err.message || 'Could not load the template', 'error');
    }
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
  if (!(await confirmAction('Delete this strategy?'))) return;
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
  if (!(await confirmAction('Stop this deployment? Its track record freezes as of today.', 'Stop'))) return;
  try {
    await api(`/api/paper/${id}/stop`, { method: 'POST' });
    ptInitDone = false;
    initPaperPage();
  } catch (err) {
    showToast(err.message || 'Stop failed', 'error');
  }
}

async function ptDelete(id) {
  if (!(await confirmAction('Delete this deployment and its paper history?'))) return;
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
            ? `<a href="${safeUrl(a.article_url)}" target="_blank" rel="noopener noreferrer" class="alert-title-link">${escapeHtml(a.message)}</a>`
            : escapeHtml(a.message);
          return `<div class="alert-item ${urgency}${a.read ? ' read' : ''}"><div>${msg}</div><div class="alert-time">${timeAgo(new Date(a.created_at))}</div></div>`;
        }).join('')
      : '<div class="empty-state small"><p>No alerts yet. We\'ll notify you when something important happens.</p></div>';
  }
}

function initSmartMoney() {
  // Each Mine/All toggle drives its own list; data-scope-for says which (default: congress).
  document.querySelectorAll('.scope-btn[data-scope]').forEach(btn => {
    btn.addEventListener('click', () => {
      btn.parentElement.querySelectorAll('.scope-btn').forEach(b => b.classList.toggle('active', b === btn));
      const target = btn.dataset.scopeFor || 'congress';
      if (target === 'in-deals') { inDealsScope = btn.dataset.scope; loadIndiaDeals(); }
      else if (target === 'in-insiders') { inInsidersScope = btn.dataset.scope; loadIndiaInsiders(); }
      else { congressScope = btn.dataset.scope; loadCongress(); }
    });
  });
  document.querySelectorAll('.market-btn').forEach(btn => {
    btn.addEventListener('click', () => setSmartMoneyMarket(btn.dataset.market));
  });
  const whBtn = document.getElementById('webhook-add-btn');
  if (whBtn) whBtn.addEventListener('click', addWebhook);
  const wh = document.getElementById('sm-webhooks');
  if (wh) wh.addEventListener('toggle', () => { if (wh.open) loadWebhooks(); });

  // Client-side search filters (no refetch — filters the already-loaded list).
  wireSmartMoneySearch('inst-search', 'inst-search-clear', (v) => { instSearchQuery = v; renderInstitutions(); });
  wireSmartMoneySearch('congress-search', 'congress-search-clear', (v) => { congressSearchQuery = v; renderCongress(); });
  wireSmartMoneySearch('in-deals-search', 'in-deals-search-clear', (v) => { inDealsSearchQuery = v; renderIndiaDeals(); });
  wireSmartMoneySearch('in-insiders-search', 'in-insiders-search-clear', (v) => { inInsidersSearchQuery = v; renderIndiaInsiders(); });
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

// Safe inside element text AND inside a quoted attribute (quotes are escaped too).
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escapeHtml(text) {
  return String(text ?? '').replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]);
}

// For href="…": only http(s) links from feeds are followed; anything else becomes "#".
function safeUrl(url) {
  return /^https?:\/\//i.test(String(url || '').trim()) ? escapeHtml(String(url).trim()) : '#';
}

// Format a USD price: 2 decimals for ≥$1, up to 6 for sub-dollar (small-cap crypto).
function fmtUsd(n) {
  if (n == null || isNaN(n)) return '—';
  const d = Number(n) >= 1 ? 2 : 6;
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
}

// Format a price in its own currency (₹ for NSE/BSE holdings); USD when none is given.
function fmtPrice(n, currency) {
  if (!currency || currency === 'USD') return fmtUsd(n);
  if (n == null || isNaN(n)) return '—';
  const num = Number(n).toLocaleString(currency === 'INR' ? 'en-IN' : 'en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency === 'INR' ? '₹' + num : `${num} ${escapeHtml(currency)}`;
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
  const execs = (c.executives || []).map(e => {
    const role = [e.former ? 'former' : '', e.role || ''].filter(Boolean).join(' ');
    return `${escapeHtml(e.name)}${role ? ` (${escapeHtml(role)})` : ''}`;
  }).join(', ');
  // Oldest check among the people shown — the card is only as fresh as its stalest name.
  const execDates = (c.executives || []).filter(e => !e.former).map(e => e.as_of);
  const execAsOf = execDates.length && execDates.every(Boolean) ? execDates.slice().sort()[0] : null;

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
      ${execs ? `<div class="brief-execs">Key people: ${execs}${execAsOf ? ` <span class="brief-muted">· checked ${escapeHtml(execAsOf)}</span>` : ''}</div>` : ''}
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
  const dateStr = brief.brief_date ? new Date(brief.brief_date).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' }) : '';
  el.innerHTML = `
    <div class="brief-top">
      <span class="brief-date">${escapeHtml(dateStr)}</span>
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
// Conversations are saved on the server: each answer returns a thread_id, follow-ups send it
// back, and the server supplies the earlier turns itself. "New conversation" starts fresh;
// the Recent list reopens or deletes saved threads (auto-deleted after 30 days idle).
let askThreadId = null;
let askThread = []; // [{ question, answer, writer }]

const ASK_WRITER_TAG = { claude: 'AI answer', ollama: 'Local model answer', deterministic: 'Auto-generated from your data', scope: 'Not in your portfolio' };

// The automatic check of an AI answer against the data it was given (server: answerCheck.js).
// It flags, it does not block — and it can be wrong about figures the model added up itself,
// which is why the wording is "could not be matched", not "wrong".
function askGroundingBadge(g) {
  if (!g || !g.checked) return '';
  const missed = (g.unsupported || []).length;
  if (!missed) return `<span class="ask-check ok" title="Every figure, date and company name in this answer was found in the data SenIQ gave the model.">✓ ${g.checked} ${g.checked === 1 ? 'fact' : 'facts'} matched to your data</span>`;
  const list = g.unsupported.map((u) => u.text).join(', ');
  return `<span class="ask-check warn" title="Not found in the data given to the model: ${escapeHtml(list)}. It may be a total the model worked out itself. Treat it with care.">⚠ ${missed} of ${g.checked} could not be matched: ${escapeHtml(list.length > 60 ? list.slice(0, 59) + '…' : list)}</span>`;
}

// A strategy draft the agent wrote from the user's description (v2). Nothing is saved until
// the user opens it in the Builder and chooses to.
function askDraftCard(d, i) {
  if (!d || !d.spec) return '';
  const li = (items) => items.map((x) => `<li>${escapeHtml(x)}</li>`).join('');
  return `<div class="ask-draft">
      <div class="ask-draft-head"><span class="material-symbols-outlined">architecture</span><strong>${escapeHtml(d.name || 'Strategy draft')}</strong><span class="ask-draft-tag">Draft · not saved · not tested</span></div>
      <div class="ask-draft-rules">${escapeHtml(d.rules || '')}</div>
      ${(d.assumptions || []).length ? `<div class="ask-draft-sub">Assumed</div><ul class="ask-draft-list">${li(d.assumptions)}</ul>` : ''}
      ${(d.data_depth_notes || []).length ? `<div class="ask-draft-sub">How much history these signals have</div><ul class="ask-draft-list warn">${li(d.data_depth_notes)}</ul>` : ''}
      <button type="button" class="btn btn-primary btn-sm ask-draft-open" data-turn="${i}">Open in Strategy Builder</button>
    </div>`;
}

function openDraftInBuilder(i) {
  const d = askThread[i] && askThread[i].draft;
  if (!d || !d.spec) return;
  const out = sbSpecToUi(d.spec);
  if (!out.ok) return showToast(`The Builder can't show this draft yet: ${out.reason}`, 'error');
  sbSaveUi(out.ui);
  if (sbInitDone) sbRender();
  switchToPage('strategy-builder');
  showToast(`“${out.ui.name}” loaded into the Builder. Review it, then backtest.`, 'success');
}

function renderAskThread(pending) {
  const answerEl = document.getElementById('ask-answer');
  const resetBtn = document.getElementById('ask-reset');
  const turns = askThread.map((t, i) => `
      <div class="ask-turn">
        <div class="ask-q">${escapeHtml(t.question)}</div>
        <div class="ask-answer-text">${escapeHtml(t.answer)}</div>
        ${askDraftCard(t.draft, i)}
        ${t.writer ? `<div class="ask-answer-meta"><span class="ask-writer">${ASK_WRITER_TAG[t.writer] || t.writer}</span>${askGroundingBadge(t.grounding)}<span class="ask-disclaimer">Informational only — not advice.</span></div>` : ''}
      </div>`).join('');
  const pendingHtml = pending ? `<div class="ask-turn"><div class="ask-q">${escapeHtml(pending)}</div><div class="ask-thinking">Thinking…</div></div>` : '';
  answerEl.innerHTML = turns + pendingHtml;
  answerEl.classList.toggle('hidden', !turns && !pendingHtml);
  resetBtn?.classList.toggle('hidden', askThread.length === 0);
}

async function loadAskThreads() {
  const wrap = document.getElementById('ask-threads');
  if (!wrap) return;
  let threads = [];
  try { threads = (await api('/api/reports/threads')).threads || []; }
  catch { wrap.classList.add('hidden'); return; } // e.g. 402 on Free — the Ask box shows the upsell
  wrap.classList.toggle('hidden', threads.length === 0);
  wrap.innerHTML = `<div class="ask-threads-head">Recent conversations</div>` + threads.map((t) => `
      <div class="ask-thread-item${t.id === askThreadId ? ' active' : ''}" data-id="${t.id}">
        <button class="ask-thread-open" type="button" data-id="${t.id}">
          <span class="ask-thread-title">${escapeHtml(t.title || 'Untitled')}</span>
          <span class="ask-thread-meta">${t.turns} ${t.turns === 1 ? 'question' : 'questions'} · ${timeAgo(new Date(t.updated_at))}</span>
        </button>
        <button class="ask-thread-del" type="button" data-id="${t.id}" title="Delete conversation" aria-label="Delete conversation">×</button>
      </div>`).join('');
}

async function openAskThread(id) {
  try {
    const { thread, messages } = await api(`/api/reports/threads/${id}`);
    askThreadId = thread.id;
    askThread = [];
    for (let i = 0; i + 1 < messages.length; i += 2) {
      const a = messages[i + 1];
      askThread.push({
        question: messages[i].content, answer: a.content, writer: a.writer, draft: a.draft || null,
        grounding: a.claims_checked == null ? null : { checked: a.claims_checked, unsupported: a.unsupported || [] },
      });
    }
    renderAskThread();
    loadAskThreads();
  } catch (err) {
    showToast(err.message, 'error');
    loadAskThreads();
  }
}

async function deleteAskThread(id) {
  if (!(await confirmAction('Delete this conversation?'))) return;
  try {
    await api(`/api/reports/threads/${id}`, { method: 'DELETE' });
    if (Number(id) === askThreadId) { askThreadId = null; askThread = []; renderAskThread(); }
    loadAskThreads();
  } catch (err) {
    showToast(err.message, 'error');
  }
}

async function askPortfolio(question) {
  const input = document.getElementById('ask-input');
  const btn = document.getElementById('ask-btn');
  const q = (question || input.value || '').trim();
  if (!q) return showToast('Type a question first', 'error');
  input.value = '';
  if (btn) { btn.disabled = true; btn.textContent = '…'; }
  renderAskThread(q);
  try {
    const data = await api('/api/reports/ask', { method: 'POST', body: JSON.stringify({ question: q, thread_id: askThreadId }) });
    askThreadId = data.thread_id;
    askThread.push({ question: data.question || q, answer: data.answer, writer: data.writer, draft: data.draft || null, grounding: data.grounding || null });
    renderAskThread();
    renderAskQuota(data.quota);
    loadAskThreads();
  } catch (err) {
    if (err.status === 404) { askThreadId = null; askThread = []; loadAskThreads(); } // thread was deleted/expired
    renderAskThread();
    const answerEl = document.getElementById('ask-answer');
    answerEl.classList.remove('hidden');
    answerEl.insertAdjacentHTML('beforeend', err.status === 402
      ? `<div class="ask-turn"><div class="ask-answer-text">Portfolio Q&A is a Plus feature.</div>${upgradeNote('Upgrade to ask anything about your portfolio.')}</div>`
      : `<div class="ask-turn"><div class="ask-answer-text">${escapeHtml(err.message)}</div></div>`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Ask'; }
    input.focus();
  }
}

function renderAskQuota(quota) {
  const el = document.getElementById('ask-quota');
  if (el && quota) el.textContent = `${quota.remaining}/${quota.limit} questions left today`;
}

function initAsk() {
  document.getElementById('ask-answer')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.ask-draft-open');
    if (btn) openDraftInBuilder(Number(btn.dataset.turn));
  });
  document.getElementById('ask-btn')?.addEventListener('click', () => askPortfolio());
  document.getElementById('ask-input')?.addEventListener('keydown', (e) => { if (e.key === 'Enter') askPortfolio(); });
  document.querySelectorAll('.ask-chip').forEach((c) => c.addEventListener('click', () => askPortfolio(c.dataset.q)));
  document.getElementById('ask-reset')?.addEventListener('click', () => { askThreadId = null; askThread = []; renderAskThread(); loadAskThreads(); });
  document.getElementById('ask-threads')?.addEventListener('click', (e) => {
    const del = e.target.closest('.ask-thread-del');
    if (del) return deleteAskThread(del.dataset.id);
    const open = e.target.closest('.ask-thread-open');
    if (open) openAskThread(open.dataset.id);
  });
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
        p.apiAccess && strategiesEnabled() ? 'API / MCP access' : null,
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
  if (!strategiesEnabled()) return;
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
        ${k.can_write ? '<span class="ak-write">write</span>' : ''}
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
  const reauthRow = document.getElementById('api-key-reauth');
  const reauthInput = document.getElementById('api-key-reauth-pw');
  try {
    btn.disabled = true;
    // Asked for the password on the last try: confirm it first, then create the key.
    if (!reauthRow.classList.contains('hidden')) {
      if (!reauthInput.value) return showProfileMsg(msgEl, 'Enter your password to create a key with write access.', 'error');
      await api('/api/auth/reauth', { method: 'POST', body: JSON.stringify({ password: reauthInput.value }) });
      reauthInput.value = '';
      reauthRow.classList.add('hidden');
    }
    const created = await api('/api/keys', {
      method: 'POST',
      body: JSON.stringify({ name: nameInput.value.trim(), can_write: document.getElementById('api-key-write').checked }),
    });
    nameInput.value = '';
    document.getElementById('api-key-write').checked = false;
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
    } else if (err.status === 403 && err.data && err.data.reauth) {
      // A key with write access needs the password confirmed in the last few minutes.
      if (err.data.can_use_password) { reauthRow.classList.remove('hidden'); reauthInput.focus(); }
      showProfileMsg(msgEl, err.data.can_use_password ? 'Confirm your password, then press Create Key again.' : err.message, 'error');
    } else {
      showProfileMsg(msgEl, err.message, 'error');
    }
  } finally {
    btn.disabled = false;
  }
}

async function revokeApiKey(id) {
  if (!(await confirmAction('Revoke this key? Agents using it will stop working immediately.', 'Revoke'))) return;
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

  // ── Phase 5 boot: OAuth return, OAuth errors, reset + verify links ──
  {
    const qp = new URLSearchParams(location.search);
    const oauthErr = qp.get('oauth_error');
    if (oauthErr) {
      const errEl = document.getElementById('auth-error');
      errEl.textContent = oauthErr;
      errEl.classList.remove('hidden');
      history.replaceState({}, '', '/app');
    }
    const resetTok = qp.get('reset');
    if (resetTok) {
      pendingResetToken = resetTok;
      showAuthForm('reset');
      history.replaceState({}, '', '/app');
    }
    if (qp.get('verified') === '1') {
      const okEl = document.getElementById('auth-success');
      okEl.textContent = 'Email verified ✓';
      okEl.classList.remove('hidden');
      history.replaceState({}, '', '/app');
    }
  }

  // Check for an existing session. Always asked, hint or not: a Google/GitHub sign-in
  // returns here with only the cookie set.
  try {
    const data = await api('/api/auth/me');
    currentUser = data.user;
    localStorage.setItem(SIGNED_IN_HINT, '1');
    showDashboard();
  } catch (err) {
    localStorage.removeItem(SIGNED_IN_HINT);
  }
});
