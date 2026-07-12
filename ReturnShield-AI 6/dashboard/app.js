const DATA = JSON.parse(document.getElementById('data-bundle').textContent);
let cases = DATA.cases.slice();
const modelComparison = DATA.model_comparison;
const shapImportance = DATA.shap_importance;
const businessImpact = DATA.business_impact;

// ---------------- Backend integration (progressive enhancement) ----------------
// This page works fully standalone (everything below computed client-side
// against the embedded DATA bundle) — that's the fallback. If the FastAPI
// backend (backend/main.py, SQLite-persisted) is reachable at API_BASE, the
// app upgrades to using it instead: real persistence across restarts/tabs/
// devices, and the server-side rule/chat/product-match scoring in
// backend/customer_pipeline.py becomes authoritative. Same pattern this app
// already uses for the camera (falls back to file upload) and OCR (falls
// back to typed text) — degrade gracefully, never hard-fail.
// Production deploys set window.RETURNSHIELD_API_BASE (see index.html, near
// the top of <head>) since the backend normally lives on a different
// host/port than the static dashboard once deployed (e.g. Cloudflare Pages
// for this file, Fly.io for the API). Falls back to localhost:8000 for local
// dev, where both run on the same machine.
const API_BASE = window.RETURNSHIELD_API_BASE || 'http://localhost:8000';
const BACKEND_TIMEOUT_MS = 2000;
let backendAvailable = false;

async function apiFetch(path, options = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);
  try {
    const headers = { ...(options.headers || {}) };
    const passphrase = sessionStorage.getItem('rs_passphrase');
    if (passphrase) headers['X-Site-Passphrase'] = passphrase;
    const res = await fetch(`${API_BASE}${path}`, { ...options, headers, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// ---------------- Site access gate (public-demo deployments only) ----------------
// Only active when RETURNSHIELD_SITE_PASSPHRASE is set at deploy time (see
// index.html). This is a casual-visitor speed bump, not real security: the
// DATA bundle is already embedded in this page's HTML source regardless of
// the gate, and the passphrase itself has to live in this same client-side
// JS to be sent to the backend, so anyone who reads either is never truly
// blocked. It exists to keep a publicly-hosted prototype from being
// casually stumbled into (search engines, shared links, random port scans),
// not to protect anything sensitive — there's no real user data here.
function checkSiteGate() {
  const required = window.RETURNSHIELD_SITE_PASSPHRASE;
  const gate = document.getElementById('site-gate');
  if (!required) {
    if (gate) gate.style.display = 'none';
    return;
  }
  if (sessionStorage.getItem('rs_passphrase') === required) {
    if (gate) gate.style.display = 'none';
    return;
  }
  if (!gate) return;
  gate.style.display = 'flex';
  const input = document.getElementById('site-gate-input');
  const error = document.getElementById('site-gate-error');
  const submit = () => {
    if (input.value === required) {
      sessionStorage.setItem('rs_passphrase', input.value);
      gate.style.display = 'none';
    } else {
      error.style.display = 'block';
    }
  };
  document.getElementById('site-gate-submit').addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
  input.focus();
}
checkSiteGate();

// ---------------- Dark / light theme toggle ----------------
// The <head> script (template.html) already set data-theme="light" before
// first paint if that was the saved choice, so there's no flash to fix here
// — this just wires the button and keeps its icon in sync.
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}
function applyTheme(theme) {
  if (theme === 'light') {
    document.documentElement.setAttribute('data-theme', 'light');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  localStorage.setItem('rs_theme', theme);
  const btn = document.getElementById('theme-toggle-btn');
  if (btn) btn.textContent = theme === 'light' ? '☀️' : '🌙';
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f6f0df' : '#040a1e');
}
document.getElementById('theme-toggle-btn')?.addEventListener('click', () => {
  applyTheme(currentTheme() === 'light' ? 'dark' : 'light');
});
applyTheme(currentTheme()); // sync the icon to whatever the head script already set

async function refreshCasesFromBackend() {
  const backendCases = await apiFetch('/api/cases?limit=200');
  if (!backendCases) return false;
  cases = backendCases;
  renderKPIs();
  renderQueue(false);
  return true;
}

async function refreshAuditLogFromBackend() {
  const log = await apiFetch('/api/audit-log?limit=200');
  if (!log) return false;
  _AUDIT_LOG = log;
  renderAuditLog();
  return true;
}

async function initBackend() {
  const health = await apiFetch('/api/health');
  backendAvailable = !!health;
  const badge = document.getElementById('backend-status');
  if (badge) {
    badge.textContent = backendAvailable ? 'Backend connected' : 'Offline demo (no backend)';
    badge.className = `backend-status-pill ${backendAvailable ? 'on' : 'off'}`;
  }
  if (!backendAvailable) {
    console.info('ReturnShield: backend not reachable at ' + API_BASE + ' — running in standalone demo mode.');
    return;
  }
  await refreshCasesFromBackend();
  const names = await apiFetch('/api/customer-names');
  if (names) Object.assign(DATA.customer_names = DATA.customer_names || {}, names);
  const rules = await apiFetch('/api/fraud-rules');
  if (rules) {
    FRAUD_RULES.returnRateThreshold = rules.return_rate_threshold;
    FRAUD_RULES.lowValueThreshold = rules.low_value_threshold;
    FRAUD_RULES.lowValueFreePasses = rules.low_value_free_passes;
    FRAUD_RULES.highValueDropoffThreshold = rules.high_value_dropoff_threshold;
    FRAUD_RULES.repeatReturnFlagCount = rules.repeat_return_flag_count;
    if (rules.late_return_days !== undefined) FRAUD_RULES.lateReturnDays = rules.late_return_days;
  }
}

const fmtMoney = (n) => '$' + Number(n).toLocaleString(undefined, {maximumFractionDigits: 0});
const fmtMoney2 = (n) => '$' + Number(n).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
const riskColor = {HIGH: 'var(--risk-high)', MEDIUM: 'var(--risk-med)', LOW: 'var(--risk-low)'};

// Inline stroke-icon set (same weight/style as the .brand-mark logo — 1.6-1.8
// stroke, round caps, currentColor) replacing functional emoji. Each icon
// inherits its color from the element it's placed in, so callers set `color`
// on the wrapper to communicate state (risk-high/med/low, blue-cyan) rather
// than baking a color into the icon itself.
const ICONS = {
  success: '<svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.25" fill="currentColor" fill-opacity="0.12"/><path d="M8 12.3l2.6 2.6L16.2 9"/></svg>',
  error: '<svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.25" fill="currentColor" fill-opacity="0.12"/><path d="M9 9l6 6M15 9l-6 6"/></svg>',
  pending: '<svg width="42" height="42" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.25" fill="currentColor" fill-opacity="0.12"/><path d="M12 7.2v5l3.3 3.3"/></svg>',
  approve: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.25"/><path d="M8 12.3l2.6 2.6L16.2 9"/></svg>',
  reject: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9.25"/><path d="M9 9l6 6M15 9l-6 6"/></svg>',
  warn: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.2l9.3 16.6H2.7L12 3.2z"/><path d="M12 10v3.6M12 16.8h.01"/></svg>',
  warehouse: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 21V9.5l9-5 9 5V21"/><path d="M9 21v-7h6v7M3 9.5h18"/></svg>',
  attachment: '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.5l-8.4 8.4a4.5 4.5 0 01-6.4-6.4l9-9a3 3 0 014.2 4.2l-8.9 8.9a1.5 1.5 0 01-2.1-2.1l7.8-7.8"/></svg>',
};

let selectedId = null;

// ---------------- KPI + queue rendering ----------------
// The Company Dashboard only surfaces flagged (MEDIUM/HIGH) cases — LOW-risk
// returns are auto-approved and don't need analyst attention, so they're
// excluded from the queue and every KPI derived from it. The one deliberate
// exception is the customer return-frequency chart (renderCustomerFrequency),
// which counts ALL returns per customer regardless of tier — a customer's
// return RATE is exactly the kind of pattern a single case's risk tier can't
// show, so it stays computed from the full dataset.
function flaggedCases() {
  const viewTiers = currentRolePermissions().viewTiers;
  return cases.filter(c => viewTiers.includes(c.risk_tier));
}

function renderKPIs() {
  const flagged = flaggedCases();
  const total = flagged.length;
  const lowCount = cases.length - total;
  const high = flagged.filter(c => c.risk_tier === 'HIGH').length;
  const med = flagged.filter(c => c.risk_tier === 'MEDIUM').length;
  const avg = total ? (flagged.reduce((s, c) => s + c.fraud_probability_pct, 0) / total) : 0;
  const valueAtRisk = flagged.reduce((s, c) => s + c.purchase_value, 0);

  document.getElementById('kpi-total').textContent = total;
  document.getElementById('kpi-high').textContent = high;
  document.getElementById('kpi-high-sub').textContent = `+ ${med} medium risk`;
  document.getElementById('kpi-avg').textContent = avg.toFixed(1) + '%';
  document.getElementById('kpi-value').textContent = fmtMoney(valueAtRisk);
  document.getElementById('queue-count').textContent = `${total} flagged`;
  const subEl = document.getElementById('queue-sub');
  if (subEl) {
    const viewTiers = currentRolePermissions().viewTiers;
    const scopedToOne = viewTiers.length < 2;
    const parts = [];
    if (lowCount) parts.push(`${lowCount} low-risk return${lowCount === 1 ? '' : 's'} auto-approved`);
    if (scopedToOne) parts.push(`this role only sees ${viewTiers[0]} risk cases`);
    subEl.textContent = parts.length ? parts.join(' · ') + ' — not shown here' : '';
  }
  renderCustomerFrequency();
}

function caseRowHTML(c, isNew) {
  return `<div class="case-row ${c.return_id === selectedId ? 'selected' : ''} ${isNew ? 'new-case' : ''}" data-id="${c.return_id}">
    <span class="risk-chip ${c.risk_tier}">${c.risk_tier}</span>
    <div class="case-main">
      <div class="rid">${c.return_id} · ${c.category}${c.source === 'customer' ? '<span class="source-tag">CUSTOMER</span>' : ''}</div>
      <div class="meta"><b>${c.reason}</b> · <span class="customer-name-link" data-customer-id="${c.customer_id}">${customerNameAndId(c.customer_id)}</span></div>
    </div>
    <div class="case-prob" style="color:${riskColor[c.risk_tier]}">${c.fraud_probability_pct}%</div>
    <div class="case-value">${fmtMoney(c.purchase_value)}</div>
  </div>`;
}

// ---------------- Case queue: search + filters ----------------
// Lets an analyst narrow the queue by free-text (return ID, customer,
// reason, description/chat transcript) plus risk tier and source — the
// practical tool a company reviewing hundreds of cases actually needs.
function getFilteredCases() {
  const q = (document.getElementById('queue-search')?.value || '').trim().toLowerCase();
  const riskFilter = document.getElementById('queue-filter-risk')?.value || '';
  const sourceFilter = document.getElementById('queue-filter-source')?.value || '';

  return flaggedCases().filter(c => {
    if (riskFilter && c.risk_tier !== riskFilter) return false;
    if (sourceFilter === 'customer' && c.source !== 'customer') return false;
    if (sourceFilter === 'synthetic' && c.source === 'customer') return false;
    if (q) {
      const haystack = [
        c.return_id, c.customer_id, customerDisplayName(c.customer_id), c.reason, c.category,
        c.product_ordered, c.item_declared, c.chat_transcript,
        ...(c.reasons || []),
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  });
}

function renderQueue(newestIsNew) {
  const list = document.getElementById('case-list');
  const filtered = getFilteredCases();
  list.innerHTML = filtered.length
    ? filtered.map((c, i) => caseRowHTML(c, newestIsNew && i === 0 && c === cases[0])).join('')
    : '<div class="empty-state">No cases match these filters.</div>';
  list.querySelectorAll('.case-row').forEach(row => {
    row.addEventListener('click', () => {
      selectedId = row.dataset.id;
      renderQueue(false);
      renderDetail();
    });
  });
  list.querySelectorAll('.customer-name-link').forEach(el => {
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      renderCustomerRiskProfile(el.dataset.customerId);
    });
  });
}

['queue-search', 'queue-filter-risk', 'queue-filter-source'].forEach(id => {
  const el = document.getElementById(id);
  el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => renderQueue(false));
});

// ---------------- Fraud rule thresholds (Fraud Rule Management) ----------------
// Centralized as one mutable object — rather than scattered constants — so
// the Fraud Rule Management panel (Admin only) can edit these live and every
// scoring function immediately reads the current value.
// Changes only apply to returns submitted after the edit, not retroactively.
const FRAUD_RULES = {
  returnRateThreshold: 0.30,       // >X% of orders returned flags the account
  lowValueThreshold: 10,           // orders under $X get the "keep it" courtesy path
  lowValueFreePasses: 2,           // first N low-value returns are lenient
  highValueDropoffThreshold: 500,  // orders over $X require warehouse drop-off
  repeatReturnFlagCount: 3,        // customer-frequency chart "repeat" flag threshold
  lateReturnDays: 7,               // holding an item longer than this before returning gets flagged for investigation
};

// Reasons where the customer plausibly never has the item in hand, so a
// photo requirement is not just unenforceable but self-contradictory — you
// can't photograph something that never arrived. No image is required or
// stored for these.
const NO_PHOTO_REASONS = new Set(['Item never arrived']);

// A same-day/next-few-days exchange for the wrong size is normal shopping
// behavior (order two sizes, keep the one that fits), not return-frequency
// abuse — even if it happens 2-3 times in a row. It only stops being benign
// once the item sits around past FRAUD_RULES.lateReturnDays before being
// sent back (see the "stale return" check in the submit handler).
function isPromptExchange(reason, daysSinceDelivery) {
  return reason === 'Wrong size / needs exchange' && daysSinceDelivery <= FRAUD_RULES.lateReturnDays;
}

// ---------------- Customer return-frequency chart ----------------
// A fixed count (rather than a %-of-orders rate) because synthetic seed
// customers have no known total-order denominator — only the live demo
// customer account does (see TOTAL_CUSTOMER_ORDERS). FRAUD_RULES.repeatReturnFlagCount
// returns on file is used as the visual "repeat" flag; for the demo account
// (7 orders) that lines up with the return-rate threshold enforced in the portal.

// Looks up a human name for a customer_id from two sources: the demo login
// accounts (DEMO_USERS) and the seeded dataset's customer_names map (built by
// dashboard/build.py from data/customers.json). Falls back to the bare ID
// when neither has a name — true for ids the live portal invents on the fly.
function customerDisplayName(customerId) {
  if (DEMO_USERS[customerId]) return DEMO_USERS[customerId].name;
  return (DATA.customer_names || {})[customerId] || null;
}

// "Name (ID)" wherever a customer identifier is shown, per the ask to stop
// showing bare ids alone — falls back to just the ID if no name is known.
function customerNameAndId(customerId) {
  const name = customerDisplayName(customerId);
  return name ? `${name} (${customerId})` : customerId;
}

function renderCustomerFrequency() {
  const chartEl = document.getElementById('customer-freq-chart');
  const countEl = document.getElementById('freq-chart-count');
  if (!chartEl) return;

  const counts = new Map();
  cases.forEach(c => counts.set(c.customer_id, (counts.get(c.customer_id) || 0) + 1));
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
  const max = Math.max(...top.map(([, n]) => n), 1);

  countEl.textContent = `${counts.size} customers tracked`;
  chartEl.innerHTML = top.length ? top.map(([id, n]) => {
    const flagged = n >= FRAUD_RULES.repeatReturnFlagCount;
    const label = customerNameAndId(id);
    return `
      <div class="freq-row" data-customer-id="${id}" style="cursor:pointer;" title="${label} — ${n} return${n === 1 ? '' : 's'} on file — click for risk profile">
        <div class="freq-label">${label}${flagged ? '<span class="freq-flag">⚠ REPEAT</span>' : ''}</div>
        <div class="freq-track"><div class="freq-fill ${flagged ? 'flagged' : ''}" style="width:${(n / max) * 100}%"></div></div>
        <div class="freq-val">${n}</div>
      </div>`;
  }).join('') : '<div class="freq-empty">No return activity yet.</div>';
  chartEl.querySelectorAll('.freq-row').forEach(row => {
    row.addEventListener('click', () => renderCustomerRiskProfile(row.dataset.customerId));
  });
}

function scoreColor(score, inverted) {
  const v = inverted ? 100 - score : score;
  if (v >= 65) return 'var(--risk-high)';
  if (v >= 35) return 'var(--risk-med)';
  return 'var(--risk-low)';
}

// ---------------- Fraud Rule Management ----------------
// Admin can tune these live. Editing only affects returns submitted after
// the change — existing cases keep whatever score they were given at the time.
const FRAUD_RULE_DEFS = [
  { key: 'returnRateThreshold', label: 'Return-rate flag threshold', desc: 'Flags an account once returns exceed this share of its total orders.', unit: '%', toInput: v => Math.round(v * 100), fromInput: v => v / 100 },
  { key: 'lowValueThreshold', label: 'Low-value courtesy threshold', desc: 'Orders under this amount qualify for the "keep it, no return needed" path.', unit: '$', toInput: v => v, fromInput: v => v },
  { key: 'lowValueFreePasses', label: 'Low-value free passes', desc: 'Low-value returns allowed before the repeat pattern gets flagged.', unit: '', toInput: v => v, fromInput: v => v },
  { key: 'highValueDropoffThreshold', label: 'High-value drop-off threshold', desc: 'Orders over this amount must go to a warehouse instead of a shipped label.', unit: '$', toInput: v => v, fromInput: v => v },
  { key: 'repeatReturnFlagCount', label: 'Repeat-return chart flag', desc: 'Return count that marks a customer "REPEAT" in the frequency chart.', unit: '', toInput: v => v, fromInput: v => v },
  { key: 'lateReturnDays', label: 'Late-return investigation threshold', desc: 'Holding an item longer than this before returning it triggers a thorough multi-agent review.', unit: 'days', toInput: v => v, fromInput: v => v },
];

// JS camelCase <-> backend snake_case (backend/db.py's fraud_rules table keys)
const FRAUD_RULE_BACKEND_KEYS = {
  returnRateThreshold: 'return_rate_threshold',
  lateReturnDays: 'late_return_days',
  lowValueThreshold: 'low_value_threshold',
  lowValueFreePasses: 'low_value_free_passes',
  highValueDropoffThreshold: 'high_value_dropoff_threshold',
  repeatReturnFlagCount: 'repeat_return_flag_count',
};

function renderFraudRulesPanel() {
  const panel = document.getElementById('fraud-rules-panel');
  const scopeNote = document.getElementById('rules-scope-note');
  if (!panel) return;
  const canEdit = currentRolePermissions().canEditRules;
  scopeNote.textContent = canEdit ? 'editable' : 'view-only';

  panel.innerHTML = FRAUD_RULE_DEFS.map(def => `
    <div class="rule-row">
      <div class="rule-info">
        <div class="rule-label">${def.label}</div>
        <div class="rule-desc">${def.desc}</div>
      </div>
      <div class="rule-input-wrap">
        ${def.unit === '$' ? '<span class="rule-unit">$</span>' : '<span class="rule-unit"></span>'}
        <input type="number" data-rule-key="${def.key}" value="${def.toInput(FRAUD_RULES[def.key])}" ${canEdit ? '' : 'disabled'}>
        <span class="rule-unit">${def.unit === '%' ? '%' : ''}</span>
      </div>
    </div>`).join('')
    + (canEdit ? '' : '<div class="rules-readonly-note">Only Admin can edit these thresholds.</div>');

  if (!canEdit) return;
  panel.querySelectorAll('input[data-rule-key]').forEach(input => {
    input.addEventListener('change', async () => {
      const def = FRAUD_RULE_DEFS.find(d => d.key === input.dataset.ruleKey);
      const raw = parseFloat(input.value);
      if (Number.isNaN(raw)) { input.value = def.toInput(FRAUD_RULES[def.key]); return; }
      const oldDisplay = def.toInput(FRAUD_RULES[def.key]);
      const newValue = def.fromInput(raw);

      if (backendAvailable) {
        const updated = await apiFetch('/api/fraud-rules', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key: FRAUD_RULE_BACKEND_KEYS[def.key], value: newValue, actor: currentUser ? currentUser.name : 'Admin' }),
        });
        if (updated) {
          FRAUD_RULES[def.key] = newValue;
          await refreshAuditLogFromBackend();
          return;
        }
        // backend rejected/failed — fall through to the local-only update below
      }
      FRAUD_RULES[def.key] = newValue;
      logAudit('rule', `${def.label} changed from ${oldDisplay}${def.unit} to ${raw}${def.unit}`);
    });
  });
}

// ---------------- Customer Risk Profile ----------------
function renderCustomerRiskProfile(customerId) {
  const panel = document.getElementById('customer-risk-profile');
  if (!panel || !customerId) return;
  const customerCases = cases.filter(c => c.customer_id === customerId);
  if (!customerCases.length) {
    panel.innerHTML = '<div class="empty-state">No cases on file for this customer.</div>';
    return;
  }
  const name = customerDisplayName(customerId);
  const total = customerCases.length;
  const highCount = customerCases.filter(c => c.risk_tier === 'HIGH').length;
  const medCount = customerCases.filter(c => c.risk_tier === 'MEDIUM').length;
  const avgProb = customerCases.reduce((s, c) => s + c.fraud_probability_pct, 0) / total;
  const totalValue = customerCases.reduce((s, c) => s + c.purchase_value, 0);

  const casesHTML = customerCases.slice()
    .sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
    .slice(0, 12)
    .map(c => `
      <div class="risk-profile-case" data-case-id="${c.return_id}">
        <span class="risk-chip ${c.risk_tier}" style="width:52px; font-size:9px; flex-shrink:0;">${c.risk_tier}</span>
        <span class="rp-reason" style="flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">${c.reason}</span>
        <span style="color:var(--white-faint); flex-shrink:0;">${fmtMoney(c.purchase_value)}</span>
      </div>`).join('');

  panel.innerHTML = `
    <div class="risk-profile-header">
      <h4>${name ? `${name} <span style="color:var(--white-faint); font-weight:400; font-size:12px;">(${customerId})</span>` : customerId}</h4>
    </div>
    <div class="risk-profile-stats">
      <div class="risk-stat"><div class="val">${total}</div><div class="lbl">Total returns</div></div>
      <div class="risk-stat"><div class="val" style="color:${highCount ? 'var(--risk-high)' : 'var(--white)'}">${highCount}</div><div class="lbl">High risk</div></div>
      <div class="risk-stat"><div class="val" style="color:${scoreColor(avgProb, true)}">${avgProb.toFixed(0)}%</div><div class="lbl">Avg fraud prob.</div></div>
    </div>
    <div style="font-size:11.5px; color:var(--white-faint); margin-bottom:10px;">${medCount} medium risk · ${fmtMoney(totalValue)} total order value across these cases</div>
    <div class="risk-profile-cases">${casesHTML}</div>
  `;
  panel.querySelectorAll('.risk-profile-case').forEach(row => {
    row.addEventListener('click', () => {
      selectedId = row.dataset.caseId;
      renderQueue(false);
      renderDetail();
    });
  });
}

// ---------------- Audit Log ----------------
// Tracks who did what and when — customer-submitted cases, analyst
// decisions/comments, and fraud-rule changes. In-memory only for this
// standalone demo; a real deployment persists this to an AuditLog table
// (see backend/main.py's comment store for the equivalent server-side shape).
let _AUDIT_LOG = [];

function logAudit(type, text, actor) {
  _AUDIT_LOG.unshift({
    timestamp: new Date().toISOString(),
    type,
    text,
    actor: actor || (currentUser ? currentUser.name : 'System'),
  });
  _AUDIT_LOG = _AUDIT_LOG.slice(0, 200);
  renderAuditLog();
}

function renderAuditLog() {
  const panel = document.getElementById('audit-log-panel');
  const countEl = document.getElementById('audit-log-count');
  if (!panel) return;
  countEl.textContent = `${_AUDIT_LOG.length} entries`;
  panel.innerHTML = _AUDIT_LOG.length ? `<div class="audit-log">${_AUDIT_LOG.map(e => `
    <div class="audit-entry">
      <div class="audit-time">${new Date(e.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</div>
      <span class="audit-type ${e.type}">${e.type}</span>
      <div class="audit-text">${e.text} <span class="audit-actor">— ${e.actor}</span></div>
    </div>`).join('')}</div>` : '<div class="empty-state">No activity logged yet.</div>';
}

// ---------------- CSV export ----------------
function exportQueueToCSV() {
  const rows = getFilteredCases();
  const headers = ['return_id', 'customer_id', 'customer_name', 'category', 'purchase_value', 'reason', 'risk_tier', 'fraud_probability_pct', 'recommendation', 'timestamp'];
  const csvLines = [headers.join(',')];
  rows.forEach(c => {
    const vals = [
      c.return_id, c.customer_id, customerDisplayName(c.customer_id) || '', c.category,
      c.purchase_value, c.reason, c.risk_tier, c.fraud_probability_pct, c.recommendation, c.timestamp,
    ].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`);
    csvLines.push(vals.join(','));
  });
  const blob = new Blob([csvLines.join('\n')], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `returnshield-flagged-cases-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  logAudit('decision', `Exported ${rows.length} flagged case(s) to CSV`);
}
document.getElementById('export-csv-btn').addEventListener('click', exportQueueToCSV);

document.getElementById('risk-profile-search').addEventListener('input', (e) => {
  const q = e.target.value.trim().toLowerCase();
  if (!q) return;
  const match = cases.find(c => {
    const name = (customerDisplayName(c.customer_id) || '').toLowerCase();
    return c.customer_id.toLowerCase().includes(q) || name.includes(q);
  });
  if (match) renderCustomerRiskProfile(match.customer_id);
});

// Applies role-gated UI: fraud-rule edit access and CSV export visibility.
// Called on login and whenever the queue re-renders (roles don't change
// mid-session in this demo, but keeping it idempotent costs nothing).
function applyRolePermissionsToUI() {
  renderFraudRulesPanel();
  renderAuditLog();
  const exportBtn = document.getElementById('export-csv-btn');
  if (exportBtn) exportBtn.style.display = currentRolePermissions().canExport ? '' : 'none';
}

// Category icon shown for cases with no real captured photo — the 150
// synthetic seed cases predate the mandatory-photo requirement (they were
// generated as ML training data, never had an actual image), so every
// return in the queue still shows *something* in the photo slot rather than
// leaving it conspicuously empty next to cases that do have a real one.
//
// The image itself comes from LoremFlickr (loremflickr.com) — a long-standing,
// no-API-key-required service that serves real, keyword-tagged stock photos
// (unlike Picsum, which is untagged random photography; Unsplash's old
// keyword-search "Source" endpoint was discontinued). `?lock=<n>` pins one
// specific photo per lock value instead of re-randomizing on every load, so
// the same case shows the same photo on repeat visits. If the network
// request fails (offline demo, service down, blocked), onerror swaps to the
// same icon-based placeholder used before — this app never leaves a broken
// image icon, matching the same degrade-gracefully pattern already used for
// the camera and OCR.
const CATEGORY_ICONS = {
  'Electronics': '📱', 'Phones': '📱', 'Laptops': '💻', 'Apparel': '👕', 'Shoes': '👟',
  'Home & Kitchen': '🏠', 'Beauty': '💄', 'Toys': '🧸', 'Sporting Goods': '⚽', 'Jewelry': '💍',
};

const CATEGORY_STOCK_KEYWORDS = {
  'Electronics': 'electronics,gadget', 'Phones': 'smartphone,mobile', 'Laptops': 'laptop,computer',
  'Apparel': 'clothing,shirt', 'Shoes': 'shoes,sneakers', 'Home & Kitchen': 'kitchen,homeware',
  'Beauty': 'cosmetics,skincare', 'Toys': 'toys,toy', 'Sporting Goods': 'sports,equipment',
  'Jewelry': 'jewelry,ring',
};

// Product-level keywords, checked against the case's actual product/item text
// (only ever populated for live customer submissions — synthetic seed cases
// have no product name, just a category) so the stock photo matches the
// specific item rather than a generic category shot. Order matters: more
// specific patterns first, since e.g. "running shoe" should win over the
// bare "shoe" fallback.
const PRODUCT_STOCK_KEYWORD_RULES = [
  { match: /airpods|earbuds|earphone/i, keywords: 'earbuds,airpods' },
  { match: /headphone/i, keywords: 'headphones' },
  { match: /iphone|smartphone|cell ?phone|mobile phone/i, keywords: 'smartphone' },
  { match: /laptop|macbook|notebook computer/i, keywords: 'laptop,computer' },
  { match: /smart ?watch|galaxy watch/i, keywords: 'smartwatch' },
  { match: /watch/i, keywords: 'wristwatch' },
  { match: /running shoe|sneaker/i, keywords: 'sneakers,running-shoes' },
  { match: /\bboot/i, keywords: 'boots,footwear' },
  { match: /sandal/i, keywords: 'sandals,footwear' },
  { match: /\bshoe/i, keywords: 'shoes,footwear' },
  { match: /jean|denim/i, keywords: 'jeans,denim' },
  { match: /jacket|coat/i, keywords: 'jacket,coat' },
  { match: /\bshirt|t-shirt|tee\b/i, keywords: 'shirt,clothing' },
  { match: /\btv\b|television/i, keywords: 'television' },
  { match: /cable|charger|charging/i, keywords: 'usb-cable,charger' },
  { match: /ring|necklace|bracelet|jewelry|jewellery/i, keywords: 'jewelry,ring' },
  { match: /speaker/i, keywords: 'speaker,audio' },
  { match: /camera/i, keywords: 'camera' },
  { match: /backpack|handbag|\bbag\b/i, keywords: 'bag,backpack' },
  { match: /sunglasses/i, keywords: 'sunglasses' },
];

function stockKeywordsFor(category, label) {
  if (label) {
    const rule = PRODUCT_STOCK_KEYWORD_RULES.find(r => r.match.test(label));
    if (rule) return rule.keywords;
  }
  return CATEGORY_STOCK_KEYWORDS[category] || 'product,retail';
}

function simpleHash(str) {
  let hash = 0;
  for (let i = 0; i < String(str).length; i++) hash = (hash * 31 + str.charCodeAt(i)) >>> 0;
  return hash;
}

function categoryPlaceholderHTML(category, label, seedKey) {
  const icon = CATEGORY_ICONS[category] || '📦';
  const keyword = stockKeywordsFor(category, label);
  const lock = simpleHash(seedKey || category || 'item');
  const stockUrl = `https://loremflickr.com/320/240/${encodeURIComponent(keyword)}?lock=${lock}`;
  return `
    <div class="evidence-item" title="Stock photo representative of this case's category — no camera capture on file">
      <img src="${stockUrl}" alt="${label || category} (representative stock photo)" loading="lazy"
           onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';">
      <div class="evidence-placeholder-photo" style="display:none;"><span class="evidence-placeholder-icon">${icon}</span></div>
      <span class="evidence-caption">${label || category} <i>(stock photo — no photo on file)</i></span>
    </div>`;
}

function renderDetail() {
  const panel = document.getElementById('detail-panel');
  const c = cases.find(x => x.return_id === selectedId);
  if (!c) {
    panel.innerHTML = '<div class="empty-state">Select a case from the queue to see the full multi-agent breakdown.</div>';
    return;
  }
  const reasonsHTML = (c.reasons || []).map(r => `<li>${r}</li>`).join('') || '<li>No significant risk indicators detected.</li>';
  const driversHTML = (c.top_model_drivers || []).slice(0, 5).map(r => `<li>${r}</li>`).join('');

  panel.innerHTML = `
    <div class="detail-header">
      <div>
        <div class="rid" style="font-family:'JetBrains Mono',monospace; color:var(--white-faint); font-size:12px;">${c.return_id} · <span class="customer-name-link" id="detail-customer-link">${customerNameAndId(c.customer_id)}</span></div>
        <div style="font-size:15px; margin-top:4px; font-weight:600;">${c.category} · ${fmtMoney2(c.purchase_value)}</div>
        <div style="font-size:12.5px; color:var(--white-faint); margin-top:2px;">Reason: ${c.reason}</div>
        ${c.product_ordered ? `<div style="font-size:12px; color:var(--white-dim); margin-top:6px;">Ordered: <b>${c.product_ordered}</b> · Customer returning: <b>${c.item_declared}</b></div>` : ''}
        ${c.invoice_attached ? `<div style="font-size:11.5px; color:var(--blue-cyan); margin-top:4px; font-family:'JetBrains Mono',monospace; display:flex; align-items:center; gap:5px;">${ICONS.attachment} Invoice attached${c.invoice_ocr ? ` — ${c.invoice_ocr.retailer ? c.invoice_ocr.retailer.toUpperCase() + ' · ' : ''}${c.invoice_ocr.total !== null && c.invoice_ocr.total !== undefined ? 'total ' + fmtMoney2(c.invoice_ocr.total) : 'no total read'}` : ''}</div>` : ''}
      </div>
      <div class="fraud-gauge" style="color:${riskColor[c.risk_tier]}">
        <span class="num">${c.fraud_probability_pct}</span><span class="pct">% fraud probability</span>
      </div>
    </div>

    <div class="agent-scores">
      <div class="agent-score">
        <div class="name">Agent 1 · Pattern</div>
        <div class="num" style="color:${scoreColor(c.suspicious_pattern_score)}">${c.suspicious_pattern_score}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${c.suspicious_pattern_score}%; background:${scoreColor(c.suspicious_pattern_score)}"></div></div>
      </div>
      <div class="agent-score">
        <div class="name">Agent 2 · Trust</div>
        <div class="num" style="color:${scoreColor(c.customer_trust_score, true)}">${c.customer_trust_score}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${c.customer_trust_score}%; background:${scoreColor(c.customer_trust_score, true)}"></div></div>
      </div>
      <div class="agent-score">
        <div class="name">Agent 3 · Image</div>
        <div class="num" style="color:${scoreColor(c.image_authenticity_score, true)}">${c.image_authenticity_score}</div>
        <div class="bar-track"><div class="bar-fill" style="width:${c.image_authenticity_score}%; background:${scoreColor(c.image_authenticity_score, true)}"></div></div>
      </div>
    </div>

    <div class="reasons-block">
      <h3>Evidence (Agents 1–3)</h3>
      <ul>${reasonsHTML}</ul>
    </div>

    <div class="reasons-block">
      <h3>Top ML model drivers (Agent 4 · SHAP)</h3>
      <ul>${driversHTML}</ul>
    </div>

    <div class="recommendation-box ${c.risk_tier}">
      <span style="color:${riskColor[c.risk_tier]}; display:inline-flex;">${c.risk_tier === 'HIGH' ? ICONS.reject : c.risk_tier === 'MEDIUM' ? ICONS.warn : ICONS.approve}</span>
      <span><b>Agent 5 · Decision:</b> ${c.recommendation}</span>
    </div>

    ${c.warehouse_review_note ? `<div class="warehouse-note" style="display:flex; align-items:flex-start; gap:8px;"><span style="flex-shrink:0; margin-top:2px;">${ICONS.warehouse}</span><span><b>Routine fulfillment check suggested:</b> ${c.warehouse_review_note}</span></div>` : ''}

    <div class="reasons-block">
      <h3>Submitted evidence</h3>
      <div class="evidence-gallery">
        ${c.photo_data_url ? `
          <a class="evidence-item" href="${c.photo_data_url}" target="_blank" rel="noopener">
            <img src="${c.photo_data_url}" alt="Customer-submitted item photo">
            <span class="evidence-caption">Item photo</span>
          </a>` : (c.reason === 'Item never arrived'
              ? `<div class="evidence-item" style="display:flex; align-items:center; justify-content:center; width:180px; height:135px; border-radius:10px; border:1px dashed var(--glass-border); text-align:center; padding:10px;">
                   <span class="evidence-caption">No photo applicable<i>(item was never received)</i></span>
                 </div>`
              : categoryPlaceholderHTML(c.category, c.product_ordered, c.return_id))}
        ${c.serial_photo_data_url ? `
          <a class="evidence-item" href="${c.serial_photo_data_url}" target="_blank" rel="noopener">
            <img src="${c.serial_photo_data_url}" alt="Customer-submitted serial number/label photo">
            <span class="evidence-caption">Serial/label photo${c.serial_ocr && c.serial_ocr.detected ? ' — read: ' + c.serial_ocr.detected : (c.serial_ocr ? ' — unreadable' : '')}</span>
          </a>` : (c.reason === 'Item never arrived' ? '' : `
          <div class="evidence-item" style="display:flex; align-items:center; justify-content:center; width:180px; height:135px; border-radius:10px; border:1px dashed var(--glass-border); text-align:center; padding:10px;">
            <span class="evidence-caption">No serial photo on file</span>
          </div>`)}
        ${c.invoice_data_url ? `
          <a class="evidence-item" href="${c.invoice_data_url}" target="_blank" rel="noopener">
            <img src="${c.invoice_data_url}" alt="Customer-submitted invoice">
            <span class="evidence-caption">Invoice${c.invoice_ocr && c.invoice_ocr.retailer ? ' — ' + c.invoice_ocr.retailer.toUpperCase() : ''}</span>
          </a>` : (c.invoice_attached ? `
          <div class="evidence-item">
            <div class="evidence-placeholder">${ICONS.attachment}</div>
            <span class="evidence-caption">Invoice attached (PDF — no image preview)</span>
          </div>` : '')}
      </div>
    </div>

    <div class="reasons-block">
      <h3>Customer chat transcript</h3>
      <div class="chat-transcript">${(c.chat_transcript || '').replace(/</g, '&lt;')}</div>
    </div>

    <div class="comments-block reasons-block">
      <h3>Analyst review &amp; comments</h3>
      <div id="comments-list"></div>
      <div class="comment-form">
        <textarea id="comment-text" placeholder="Add a review note — e.g. 'Confirmed GPS mismatch with carrier data, escalating to investigations.'"></textarea>
        <input type="text" id="comment-author" placeholder="Your name" value="Analyst">
        <select id="comment-action">
          <option value="note">Note</option>
          <option value="approve">Approve return</option>
          <option value="reject">Reject return</option>
          <option value="escalate">Escalate</option>
        </select>
        <button class="ghost" id="comment-submit">Add comment</button>
      </div>
    </div>
  `;
  renderComments(c.return_id);
  document.getElementById('comment-submit').addEventListener('click', () => submitComment(c.return_id));
  document.getElementById('detail-customer-link').addEventListener('click', () => renderCustomerRiskProfile(c.customer_id));
}

// ---------------- Analyst comments (review workflow) ----------------
// In-memory store for the standalone dashboard. When the FastAPI backend is
// running, these map 1:1 to POST/GET /api/case/{id}/comments.
const commentStore = {};

function renderCommentsList(comments) {
  const list = document.getElementById('comments-list');
  if (!list) return;
  if (!comments.length) {
    list.innerHTML = '<div style="font-size:12px; color:var(--white-faint); padding:6px 0;">No review comments yet — be the first to weigh in on this case.</div>';
    return;
  }
  list.innerHTML = comments.map(cm => `
    <div class="comment-item">
      <div class="comment-avatar">${(cm.author || 'A').slice(0, 2).toUpperCase()}</div>
      <div class="comment-body">
        <div class="who"><b>${cm.author}</b> · ${new Date(cm.timestamp).toLocaleString()}<span class="action-tag ${cm.action}">${cm.action.toUpperCase()}</span></div>
        <div>${cm.text.replace(/</g, '&lt;')}</div>
      </div>
    </div>`).join('');
}

function renderComments(returnId) {
  renderCommentsList(commentStore[returnId] || []);
  if (backendAvailable) {
    apiFetch(`/api/case/${returnId}/comments`).then(comments => {
      if (comments) renderCommentsList(comments);
    });
  }
}

async function submitComment(returnId) {
  const text = document.getElementById('comment-text').value.trim();
  const author = document.getElementById('comment-author').value.trim() || 'Analyst';
  const action = document.getElementById('comment-action').value;
  if (!text) return;
  document.getElementById('comment-text').value = '';

  if (backendAvailable) {
    const result = await apiFetch(`/api/case/${returnId}/comments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ author, text, action }),
    });
    if (result) {
      renderCommentsList(result.comments);
      await refreshAuditLogFromBackend();
      return;
    }
    // backend failed mid-session — fall through to the local-only path below
  }
  (commentStore[returnId] = commentStore[returnId] || []).push({
    author, text, action, timestamp: new Date().toISOString(),
  });
  renderCommentsList(commentStore[returnId]);
  logAudit('decision', `${action.toUpperCase()} on ${returnId}: "${text.slice(0, 80)}${text.length > 80 ? '…' : ''}"`, author);
}

// ---------------- Model comparison table ----------------
function renderModelTable() {
  const results = modelComparison.results;
  const best = modelComparison.best_model;
  const rows = Object.entries(results).map(([name, r]) => `
    <tr class="${name === best ? 'best' : ''}">
      <td class="model-name-cell">${name}${name === best ? '<span class="best-tag">BEST · F1</span>' : ''}</td>
      <td>${(r.precision * 100).toFixed(1)}%</td>
      <td>${(r.recall * 100).toFixed(1)}%</td>
      <td>${(r.f1 * 100).toFixed(1)}%</td>
      <td>${(r.roc_auc * 100).toFixed(1)}%</td>
      <td>${r.confusion_matrix[1][1]} / ${r.confusion_matrix[1][0] + r.confusion_matrix[1][1]}</td>
    </tr>`).join('');

  document.getElementById('model-table').innerHTML = `
    <thead><tr><th>Model</th><th>Precision</th><th>Recall</th><th>F1</th><th>ROC-AUC</th><th>Fraud caught / total</th></tr></thead>
    <tbody>${rows}</tbody>`;
  document.getElementById('model-count').textContent = `held-out test set`;
}

// ---------------- SHAP chart ----------------
function renderShap() {
  const max = Math.max(...shapImportance.map(s => s.importance));
  document.getElementById('shap-chart').innerHTML = shapImportance.map(s => `
    <div class="shap-row">
      <div class="feat">${s.feature}</div>
      <div class="track"><div class="fill" style="width:${(s.importance / max * 100).toFixed(1)}%"></div></div>
      <div class="val">${s.importance.toFixed(3)}</div>
    </div>`).join('');
}

// ---------------- Business impact ----------------
function renderImpact() {
  const b = businessImpact;
  const cards = [
    {icon: '💰', big: fmtMoney(b.estimated_annual_fraud_value_prevented_usd), lbl: 'Estimated fraud value prevented / year'},
    {icon: '⏱️', big: Math.round(b.estimated_manual_review_minutes_saved_per_year / 60).toLocaleString() + ' hrs', lbl: 'Manual review time saved / year'},
    {icon: '📉', big: b.estimated_false_positive_cases_per_year.toLocaleString(), lbl: 'Estimated false positives / year'},
  ];
  document.getElementById('impact-row').innerHTML = cards.map(c => `
    <div class="glass impact-card">
      <div class="icon">${c.icon}</div>
      <div class="big">${c.big}</div>
      <div class="lbl">${c.lbl}</div>
    </div>`).join('');
  document.getElementById('impact-note').innerHTML =
    `Estimate assumes an illustrative ${b.assumptions.illustrative_annual_return_volume.toLocaleString()} returns/year at the ${(b.assumptions.observed_fraud_rate_in_data * 100).toFixed(1)}% fraud rate observed in this synthetic dataset, using the ${b.model_used_for_estimate} model's measured precision/recall on held-out data. Adjust assumptions to your real return volume before using in a business case.`;
}

// ---------------- Client-side live simulation (Agents 1-5, mirrored from backend Python) ----------------
const CATEGORIES = ["Electronics","Phones","Laptops","Apparel","Shoes","Home & Kitchen","Beauty","Toys","Sporting Goods","Jewelry"];
const HIGH_VALUE = new Set(["Electronics","Phones","Laptops","Jewelry"]);
const REASONS = ["Item never arrived","Item arrived damaged","Wrong item sent","Changed my mind","Item not as described","Defective / stopped working","Missing parts/accessories"];
let simCounter = 1;

function rand(min, max) { return Math.random() * (max - min) + min; }
function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function simulateCase() {
  const isFraudRing = Math.random() < 0.12;
  const fraudRoll = Math.random() < (isFraudRing ? 0.62 : 0.05);
  const category = pick(CATEGORIES);
  const isHighValueCat = HIGH_VALUE.has(category);
  const purchaseValue = isHighValueCat ? rand(300, 2200) : rand(15, 150);
  const returnFrequency = fraudRoll ? Math.floor(rand(4, 20)) : Math.floor(rand(1, 4));
  const gpsMismatch = (fraudRoll && Math.random() < 0.6) ? rand(300, 3000) : rand(0, 40);
  const addressesUsed = fraudRoll ? Math.floor(rand(3, 7)) : Math.floor(rand(1, 3));
  const paymentMethods = fraudRoll ? Math.floor(rand(2, 4)) : Math.floor(rand(1, 3));
  const priorFraudFlags = fraudRoll ? Math.floor(rand(1, 4)) : (Math.random() < 0.03 ? 1 : 0);
  const daysBeforeReturn = fraudRoll ? Math.floor(rand(0, 3)) : Math.floor(rand(1, 21));
  const reason = (fraudRoll && Math.random() < 0.5) ? "Item never arrived" : pick(REASONS);
  const isHoliday = Math.random() < 0.25;

  // Agent 1: Pattern
  let pScore = 0; const pFlags = [];
  if (returnFrequency >= 10) { pScore += 30; pFlags.push(`Excessive return frequency (${returnFrequency} returns on this account)`); }
  else if (returnFrequency >= 5) { pScore += 15; pFlags.push(`Elevated return frequency (${returnFrequency} returns)`); }
  if (isHighValueCat && purchaseValue > 300) { pScore += 15; pFlags.push(`Return concentrated on high-value item (${fmtMoney2(purchaseValue)}, ${category})`); }
  if (isHoliday) { pScore += 10; pFlags.push('Return filed during known holiday-abuse window'); }
  if (gpsMismatch > 250) { pScore += 20; pFlags.push(`Shipping location mismatch (${gpsMismatch.toFixed(0)} km from account home address)`); }
  if (addressesUsed >= 3) { pScore += 15; pFlags.push(`${addressesUsed} different shipping addresses used on this account`); }
  if (paymentMethods >= 3) { pScore += 10; pFlags.push(`${paymentMethods} different payment methods used`); }
  if (priorFraudFlags > 0) { pScore += 10 * Math.min(priorFraudFlags, 3); pFlags.push(`${priorFraudFlags} prior fraud flag(s) on account`); }
  pScore = Math.min(pScore, 100);

  // Agent 2: NLP / trust
  let trust = 100; const tFlags = [];
  let transcript;
  const contradiction = fraudRoll && reason === "Item never arrived" && Math.random() < 0.7;
  if (contradiction) {
    transcript = "Customer: the product broke after one use and i want a refund immediately\nAgent: Our tracking shows this package was delivered on time.\nCustomer: I never received it, I want a refund right now.";
    trust -= 35; tFlags.push('Contradiction detected: claims non-arrival while tracking shows delivered');
  } else {
    transcript = `Customer: ${reason}. I would like to return this item.\nAgent: I'm sorry to hear that. Can you tell me more?\nCustomer: It just didn't work out, thanks for understanding.`;
  }
  if (fraudRoll && Math.random() < 0.4) {
    transcript += "\nCustomer: this is ridiculous, i will report you";
    trust -= 20; tFlags.push('Abusive/hostile language detected (1 instance(s))');
  }
  const copyPaste = fraudRoll && Math.random() < 0.5;
  if (copyPaste) { trust -= 15; tFlags.push('Copy-paste excuse template matched across prior tickets'); }
  if (returnFrequency >= 5 && copyPaste) { trust -= 15; tFlags.push(`Same excuse pattern reused ${returnFrequency} times historically`); }
  trust = Math.max(0, Math.min(100, trust));

  // Agent 3: Vision
  let imgScore = 100; const iFlags = [];
  if (fraudRoll) {
    if (Math.random() < 0.5) { imgScore -= 35; iFlags.push('Uploaded product image does not match ordered SKU'); }
    if (Math.random() < 0.55) { imgScore -= 30; iFlags.push('Damage pattern inconsistent with claimed shipping damage (staged damage suspected)'); }
    if (Math.random() < 0.35) { imgScore -= 25; iFlags.push('Image appears to be reused/old (matches a previously submitted photo)'); }
    if (Math.random() < 0.4) { imgScore -= 20; iFlags.push('Visible serial number does not match order record'); }
  }
  imgScore = Math.max(0, Math.min(100, imgScore));

  // Agent 4: blended fraud probability heuristic (mirrors the trained model's key drivers)
  let prob = 0.03;
  prob += (pScore / 100) * 0.35;
  prob += ((100 - trust) / 100) * 0.25;
  prob += ((100 - imgScore) / 100) * 0.15;
  if (daysBeforeReturn <= 3) prob += 0.12;
  if (gpsMismatch > 250) prob += 0.08;
  prob = Math.min(0.98, Math.max(0.01, prob + rand(-0.03, 0.03)));

  const allFlags = [...pFlags, ...tFlags, ...iFlags];
  let riskTier, recommendation;
  if (prob >= 0.75) { riskTier = 'HIGH'; recommendation = 'Reject return. Escalate to fraud investigation team.'; }
  else if (prob >= 0.40) { riskTier = 'MEDIUM'; recommendation = 'Hold for manual review before approving or rejecting.'; }
  else { riskTier = 'LOW'; recommendation = 'Approve return through standard automated processing.'; }

  let warehouseNote = null;
  if (imgScore < 50 && pScore < 30) {
    warehouseNote = 'Item/photo inconsistency without matching customer-side risk signals — recommend checking warehouse handling/fulfillment logs for this SKU as a routine review step.';
  }

  simCounter += 1;
  return {
    return_id: `RET-LIVE-${String(simCounter).padStart(4, '0')}`,
    customer_id: `CUST-LIVE-${Math.floor(rand(10000, 99999))}`,
    order_id: `ORD-LIVE-${Math.floor(rand(10000, 99999))}`,
    category, purchase_value: Math.round(purchaseValue * 100) / 100, reason,
    ground_truth_is_fraud: fraudRoll,
    suspicious_pattern_score: pScore,
    customer_trust_score: trust,
    image_authenticity_score: imgScore,
    fraud_probability_pct: Math.round(prob * 1000) / 10,
    risk_tier: riskTier,
    reasons: allFlags.length ? allFlags : ['No significant risk indicators detected.'],
    top_model_drivers: shapImportance.slice(0, 5).map(s => `${s.feature} (impact: ${s.importance})`),
    recommendation, warehouse_review_note: warehouseNote,
    chat_transcript: transcript,
    timestamp: new Date().toISOString(),
  };
}

document.getElementById('simulate-btn').addEventListener('click', () => {
  const newCase = simulateCase();
  cases.unshift(newCase);
  cases = cases.slice(0, 200);
  selectedId = newCase.return_id;
  renderKPIs();
  renderQueue(true);
  renderDetail();
});

document.getElementById('reset-btn').addEventListener('click', async () => {
  selectedId = null;
  localStorage.removeItem(RETURN_HISTORY_KEY); // clear tracked return frequency/low-value history too
  // With a live backend, cases are real persisted data — "reset" re-syncs
  // with it rather than discarding it back to the static demo bundle.
  const refreshed = backendAvailable && await refreshCasesFromBackend();
  if (!refreshed) cases = DATA.cases.slice();
  renderKPIs();
  renderQueue(false);
  renderDetail();
});

// Auto-simulate a new incoming return every 12s for a "live" feel
setInterval(() => {
  const newCase = simulateCase();
  cases.unshift(newCase);
  cases = cases.slice(0, 200);
  renderKPIs();
  renderQueue(true);
}, 12000);

// ---------------- Clock ----------------
function tickClock() {
  document.getElementById('clock').textContent = 'LIVE · ' + new Date().toLocaleTimeString();
}
setInterval(tickClock, 1000);
tickClock();

// ---------------- Agent 3 camera / vision demo ----------------
// Robust camera handling + REAL client-side image analysis:
//  - perceptual hash (aHash) duplicate detection across submissions this session
//  - brightness check (too-dark photos hide product details)
//  - sharpness check (blur can conceal damage staging or serial numbers)
//  - resolution check (tiny images suggest screenshots / re-downloads)
const video = document.getElementById('camera-video');
const canvas = document.getElementById('camera-canvas');
const placeholder = document.getElementById('camera-placeholder');
const startBtn = document.getElementById('start-camera-btn');
const captureBtn = document.getElementById('capture-btn');
const uploadBtn = document.getElementById('upload-btn');
const fileInput = document.getElementById('file-input');
let stream = null;
const seenImageHashes = [];

function stopStream() {
  if (stream) { stream.getTracks().forEach(t => t.stop()); stream = null; }
}
window.addEventListener('beforeunload', stopStream);

function cameraSupportMessage() {
  if (!window.isSecureContext) {
    return 'Camera requires a secure context. You are viewing this over file:// or plain http.<br>' +
           'Fix: run <b>python serve.py</b> in the project folder and open <b>http://localhost:3000</b>, ' +
           'or use the live Netlify URL (https). "Upload photo instead" works everywhere.';
  }
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return 'This browser does not expose the camera API. Try Chrome, Edge, Firefox, or Safari — or use "Upload photo instead".';
  }
  return null;
}

async function startCamera() {
  const unsupported = cameraSupportMessage();
  if (unsupported) { placeholder.innerHTML = unsupported; placeholder.style.display = 'block'; return; }
  try {
    stopStream();
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    video.srcObject = stream;
    await video.play().catch(() => {});
    video.style.display = 'block';
    canvas.style.display = 'none';
    placeholder.style.display = 'none';
    captureBtn.disabled = false;
    captureBtn.textContent = 'Capture photo';
    startBtn.textContent = 'Restart camera';
  } catch (err) {
    let msg;
    switch (err.name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        msg = 'Camera permission was denied. Click the camera icon in your browser\'s address bar to allow access, then press "Open camera" again.'; break;
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        msg = 'No camera was found on this device. Use "Upload photo instead".'; break;
      case 'NotReadableError':
      case 'TrackStartError':
        msg = 'The camera is in use by another application. Close it and try again.'; break;
      case 'OverconstrainedError':
        msg = 'The requested camera settings aren\'t supported on this device — retrying with defaults may help.'; break;
      default:
        msg = `Camera error: ${err.message || err.name}. "Upload photo instead" always works.`;
    }
    placeholder.innerHTML = msg;
    placeholder.style.display = 'block';
    video.style.display = 'none';
  }
}

// ---- Real image analysis helpers ----
function getImageData(sourceCanvas) {
  const ctx = sourceCanvas.getContext('2d');
  return ctx.getImageData(0, 0, sourceCanvas.width, sourceCanvas.height);
}

function computeAHash(sourceCanvas) {
  // 8x8 average hash: downscale, grayscale, threshold on mean → 64-bit fingerprint
  const small = document.createElement('canvas');
  small.width = 8; small.height = 8;
  small.getContext('2d').drawImage(sourceCanvas, 0, 0, 8, 8);
  const d = small.getContext('2d').getImageData(0, 0, 8, 8).data;
  const gray = [];
  for (let i = 0; i < d.length; i += 4) gray.push(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]);
  const mean = gray.reduce((a, b) => a + b, 0) / 64;
  return gray.map(g => (g > mean ? '1' : '0')).join('');
}

function hammingDistance(a, b) {
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

function computeBrightness(imgData) {
  const d = imgData.data;
  let sum = 0;
  const step = 4 * 16; // sample every 16th pixel for speed
  let n = 0;
  for (let i = 0; i < d.length; i += step) { sum += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; }
  return sum / n; // 0-255
}

function computeSharpness(sourceCanvas) {
  // Downscale to 128px wide, measure mean absolute horizontal+vertical gradient
  const w = 128, h = Math.max(1, Math.round(sourceCanvas.height / sourceCanvas.width * 128));
  const small = document.createElement('canvas');
  small.width = w; small.height = h;
  small.getContext('2d').drawImage(sourceCanvas, 0, 0, w, h);
  const d = small.getContext('2d').getImageData(0, 0, w, h).data;
  const gray = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  let grad = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      grad += Math.abs(gray[i + 1] - gray[i - 1]) + Math.abs(gray[i + w] - gray[i - w]);
      n++;
    }
  }
  return grad / n; // typical sharp photos: 8-40+; blurry: < 4
}

function analyzeCapturedImage(sourceCanvas, sourceLabel) {
  let score = 100;
  const flags = [];

  // Resolution check
  if (sourceCanvas.width < 320 || sourceCanvas.height < 240) {
    score -= 20;
    flags.push(`Very low resolution (${sourceCanvas.width}×${sourceCanvas.height}) — could be a screenshot or re-downloaded thumbnail rather than an original photo`);
  }

  // Duplicate detection via perceptual hash
  const hash = computeAHash(sourceCanvas);
  const nearMatch = seenImageHashes.find(prev => hammingDistance(prev.hash, hash) <= 5);
  if (nearMatch) {
    score -= 35;
    flags.push(`This image is a near-duplicate of one submitted earlier this session (${nearMatch.label}) — reused-photo fraud pattern`);
  }
  seenImageHashes.push({ hash, label: sourceLabel + ' @ ' + new Date().toLocaleTimeString() });

  // Brightness
  const imgData = getImageData(sourceCanvas);
  const brightness = computeBrightness(imgData);
  if (brightness < 40) {
    score -= 15;
    flags.push(`Image is very dark (brightness ${brightness.toFixed(0)}/255) — product details and serial numbers cannot be verified; request a re-shot`);
  } else if (brightness > 235) {
    score -= 10;
    flags.push(`Image is heavily overexposed (brightness ${brightness.toFixed(0)}/255) — damage claims cannot be assessed`);
  }

  // Sharpness / blur
  const sharpness = computeSharpness(sourceCanvas);
  if (sharpness < 4) {
    score -= 20;
    flags.push(`Image is blurry (sharpness ${sharpness.toFixed(1)}) — blur can conceal staged damage or mismatched serial numbers; request a re-shot`);
  }

  score = Math.max(0, Math.min(100, score));
  const color = scoreColor(score, true);
  const metaLine = `${sourceCanvas.width}×${sourceCanvas.height} · brightness ${brightness.toFixed(0)} · sharpness ${sharpness.toFixed(1)} · hash ${hash.slice(0, 16)}…`;
  document.getElementById('vision-result').innerHTML = `
    <div class="agent-score" style="max-width:340px;">
      <div class="name">Image Quality &amp; Authenticity Score</div>
      <div class="num" style="color:${color}">${score}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${score}%; background:${color}"></div></div>
    </div>
    <div style="font-size:11px; color:var(--white-faint); margin-top:8px; font-family:'JetBrains Mono',monospace;">${metaLine}</div>
    <div class="reasons-block"><ul>${flags.length ? flags.map(f => `<li>${f}</li>`).join('') : '<li>Image passes all automated checks: original (no duplicate match), adequate resolution, brightness, and sharpness. In production, SKU/serial matching runs next via a vision model.</li>'}</ul></div>
  `;
}

startBtn.addEventListener('click', startCamera);

captureBtn.addEventListener('click', () => {
  if (!stream || !video.videoWidth) return;
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  video.style.display = 'none';
  canvas.style.display = 'block';
  stopStream();
  captureBtn.disabled = true;
  startBtn.textContent = 'Retake (open camera)';
  analyzeCapturedImage(canvas, 'camera capture');
});

uploadBtn.addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    document.getElementById('vision-result').innerHTML =
      '<div class="reasons-block"><ul><li>That file is not an image. Please upload a JPG, PNG, or WebP photo of the returned item.</li></ul></div>';
    fileInput.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      stopStream();
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      canvas.style.display = 'block';
      video.style.display = 'none';
      placeholder.style.display = 'none';
      captureBtn.disabled = true;
      startBtn.textContent = 'Open camera';
      analyzeCapturedImage(canvas, `upload: ${file.name}`);
    };
    img.onerror = () => {
      document.getElementById('vision-result').innerHTML =
        '<div class="reasons-block"><ul><li>Could not decode that image file. Try a different photo.</li></ul></div>';
    };
    img.src = ev.target.result;
  };
  reader.onerror = () => {
    document.getElementById('vision-result').innerHTML =
      '<div class="reasons-block"><ul><li>Could not read that file. Try again.</li></ul></div>';
  };
  reader.readAsDataURL(file);
  fileInput.value = ''; // allow re-uploading the same file (duplicate demo)
});

// Show a helpful hint immediately if camera can't work in this context
(function initCameraHint() {
  const unsupported = cameraSupportMessage();
  if (unsupported) placeholder.innerHTML = unsupported;
})();

// ---------------- Agent 6: Invoice verification ----------------
// JS mirror of agents/invoice_agent.py. Document hashes are tracked in-memory
// for duplicate-invoice detection across submissions this session.
const seenInvoiceHashes = {};
let currentInvoiceHash = null;

const invoiceDrop = document.getElementById('invoice-drop');
const invoiceFileInput = document.getElementById('invoice-file-input');
invoiceDrop.addEventListener('click', () => invoiceFileInput.click());
invoiceDrop.addEventListener('dragover', e => { e.preventDefault(); invoiceDrop.classList.add('drag'); });
invoiceDrop.addEventListener('dragleave', () => invoiceDrop.classList.remove('drag'));
invoiceDrop.addEventListener('drop', e => {
  e.preventDefault(); invoiceDrop.classList.remove('drag');
  if (e.dataTransfer.files.length) handleInvoiceFile(e.dataTransfer.files[0]);
});
invoiceFileInput.addEventListener('change', e => {
  if (e.target.files.length) handleInvoiceFile(e.target.files[0]);
});

async function handleInvoiceFile(file) {
  document.getElementById('invoice-file-name').textContent = `${file.name} (${(file.size / 1024).toFixed(0)} KB)`;
  const buf = await file.arrayBuffer();
  const hashBuf = await crypto.subtle.digest('SHA-256', buf);
  currentInvoiceHash = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 24);
}

document.getElementById('verify-invoice-btn').addEventListener('click', () => {
  const invAmount = parseFloat(document.getElementById('inv-amount').value) || 0;
  const invDate = document.getElementById('inv-date').value;
  const invOrderId = document.getElementById('inv-order-id').value.trim();
  const orderAmount = parseFloat(document.getElementById('inv-order-amount').value) || 0;
  const orderDate = document.getElementById('inv-order-date').value;
  const deliveryDate = document.getElementById('inv-delivery-date').value;

  let score = 100; const flags = [];

  // 1. Amount match
  if (invAmount > 0 && orderAmount > 0) {
    const diffPct = Math.abs(invAmount - orderAmount) / Math.max(orderAmount, 0.01);
    if (diffPct > 0.10) {
      score -= 35;
      flags.push(`Invoice amount (${fmtMoney2(invAmount)}) differs from order record (${fmtMoney2(orderAmount)}) by ${(diffPct * 100).toFixed(0)}% — possible edited invoice`);
    }
  } else if (invAmount <= 0) {
    score -= 15; flags.push('No amount entered from the invoice');
  }

  // 2. Duplicate invoice reuse
  if (currentInvoiceHash) {
    const prior = seenInvoiceHashes[currentInvoiceHash];
    if (prior && prior !== invOrderId) {
      score -= 40;
      flags.push(`This exact invoice document was already submitted for a different claim (${prior || 'earlier this session'}) — duplicate-invoice fraud pattern`);
    }
    seenInvoiceHashes[currentInvoiceHash] = invOrderId || 'unspecified-order';
  }

  // 3. Date consistency
  if (invDate && deliveryDate && new Date(invDate) > new Date(deliveryDate)) {
    score -= 25;
    flags.push('Invoice is dated AFTER the delivery date — timeline impossible for an original purchase invoice');
  } else if (invDate && orderDate) {
    const dayDiff = Math.abs((new Date(invDate) - new Date(orderDate)) / 86400000);
    if (dayDiff > 3) { score -= 15; flags.push(`Invoice date is ${Math.round(dayDiff)} days away from the order date`); }
  }

  score = Math.max(0, Math.min(100, score));
  const verdict = score >= 80 ? 'VERIFIED' : score >= 50 ? 'NEEDS REVIEW' : 'SUSPECT DOCUMENT';
  const chipClass = score >= 80 ? 'VERIFIED' : score >= 50 ? 'REVIEW' : 'SUSPECT';
  const color = scoreColor(score, true);

  document.getElementById('invoice-result').innerHTML = `
    <span class="verdict-chip ${chipClass}">${verdict}</span>
    <div class="agent-score" style="max-width:320px;">
      <div class="name">Invoice Verification Score</div>
      <div class="num" style="color:${color}">${score}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${score}%; background:${color}"></div></div>
    </div>
    <div class="reasons-block"><ul>${flags.length ? flags.map(f => `<li>${f}</li>`).join('') : '<li>All invoice fields are consistent with the order record.</li>'}</ul></div>
  `;
});

// ---------------- Agent 2: Live transcript analyzer ----------------
// JS mirror of agents/nlp_agent.py — same rules, same scoring.
const ABUSIVE_RE = [/\bridiculous\b/i, /\breport you\b/i, /\bscam\b/i, /\bmanager immediately\b/i, /\bsue\b/i, /\bstupid\b/i, /\bidiot\b/i];
const MANIP_RE = [/\bright now\b/i, /\bimmediately\b/i, /\bi will report\b/i, /\bmy lawyer\b/i, /\bnever again\b/i, /\bworst company\b/i];
const NON_ARRIVAL_RE = /\bnever (arrived|received|got it)\b/i;
const DELIVERED_RE = /\bdelivered\b/i;
const COPY_PASTE_TEMPLATES = [
  'the product broke after one use and i want a refund immediately',
  'this item never arrived even though it says delivered',
  'the box was empty when i opened it please refund me now',
];

// Single source of truth for the Agent 2 trust-scoring rules (mirrors
// agents/nlp_agent.py::analyze_transcript). Every place that needs a trust
// score — the analyst transcript tool, the customer portal chat, and the
// portal submission pipeline — calls this instead of re-implementing it.
function analyzeTrustSignals(text, excuseHistoryCount = 0) {
  let trust = 100;
  const flags = [];
  if (!text || !text.trim()) return { trust, flags };
  const lower = text.toLowerCase();

  if (NON_ARRIVAL_RE.test(text) && DELIVERED_RE.test(text)) {
    trust -= 35;
    flags.push('Contradiction detected: claims non-arrival while tracking shows delivered');
  }
  const abusiveHits = ABUSIVE_RE.filter(r => r.test(text)).length;
  if (abusiveHits) { trust -= 10 * abusiveHits; flags.push(`Abusive/hostile language detected (${abusiveHits} instance(s))`); }
  const manipHits = MANIP_RE.filter(r => r.test(text)).length;
  if (manipHits) { trust -= 8 * manipHits; flags.push(`Emotional-manipulation / urgency-pressure language detected (${manipHits} instance(s))`); }
  if (COPY_PASTE_TEMPLATES.some(t => lower.includes(t))) {
    trust -= 15; flags.push('Copy-paste excuse template matched across prior tickets');
  }
  if (excuseHistoryCount >= 5) {
    trust -= 15; flags.push(`Same excuse pattern reused ${excuseHistoryCount} times historically`);
  }

  trust = Math.max(0, Math.min(100, trust));
  return { trust, flags };
}

// Keyword buckets for cross-turn contradiction detection — if a customer
// asserts two different, mutually-exclusive claims across separate chat
// turns (e.g. "it never arrived" in one message, "it arrived damaged" in
// another), that's a materially stronger signal than any single-message
// regex check can catch, since analyzeTrustSignals only sees the whole
// transcript joined together and has no notion of "turn."
const CLAIM_BUCKET_PATTERNS = {
  never_arrived: /\bnever (arrived|received|got it)\b|\bdid ?n't (arrive|receive)\b/i,
  damaged: /\bdamaged?\b|\bbroken\b|\bcracked\b|\bshattered\b/i,
  wrong_item: /\bwrong (item|product|size|color)\b|\bnot what i ordered\b/i,
  changed_mind: /\bchanged my mind\b|\bdon't (want|need) it (any ?more)\b|\bno longer (want|need)\b/i,
};
const VAGUE_DODGE_PHRASES = ['idk', "i don't know", 'whatever', 'just refund me', "doesn't matter", 'who cares'];

function classifyClaim(text) {
  const lower = (text || '').toLowerCase();
  for (const [bucket, re] of Object.entries(CLAIM_BUCKET_PATTERNS)) {
    if (re.test(lower)) return bucket;
  }
  return null;
}

// Soft signal by design (see the module doc comment on analyzeConversationIntent):
// a single terse reply is normal customer behavior, not evidence of anything.
function isVagueReply(text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return false;
  const lower = trimmed.toLowerCase();
  if (VAGUE_DODGE_PHRASES.some(p => lower.includes(p))) return true;
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  return wordCount > 0 && wordCount < 3;
}

// Scores a full multi-turn conversation, not just a single string. Reuses
// analyzeTrustSignals for everything a joined transcript can catch, then
// adds two checks only a real turn-by-turn transcript makes possible: a
// story that changes between turns, and terse/dodging non-answers to a
// direct question. Both are capped/low-weight — soft signals that nudge the
// score, not decisive on their own.
function analyzeConversationIntent(chatLog) {
  const customerTurns = chatLog.filter(m => m.role === 'customer').map(m => m.text);
  const base = analyzeTrustSignals(customerTurns.join('\n'));

  let trust = base.trust;
  const flags = [...base.flags];

  const buckets = new Set(customerTurns.map(classifyClaim).filter(Boolean));
  if (buckets.size >= 2) {
    trust -= 25;
    flags.push(`Story changed between messages — asserted ${[...buckets].sort().join(' and ')} as separate claims`);
  }

  // Skip the opening message: an open-ended first reply is often short
  // ("it broke") and that alone shouldn't read as dodging.
  if (customerTurns.slice(1).some(isVagueReply)) {
    trust -= 8;
    flags.push('Gave a very short or non-committal answer to a direct question');
  }

  return { trust: Math.max(0, Math.min(100, trust)), flags };
}

document.getElementById('analyze-transcript-btn').addEventListener('click', () => {
  const transcript = document.getElementById('transcript-input').value;
  const excuseCount = parseInt(document.getElementById('excuse-count').value) || 0;
  if (!transcript.trim()) return;

  const { trust, flags } = analyzeTrustSignals(transcript, excuseCount);
  const color = scoreColor(trust, true);
  document.getElementById('transcript-result').innerHTML = `
    <div class="agent-score" style="max-width:320px;">
      <div class="name">Customer Trust Score</div>
      <div class="num" style="color:${color}">${trust}</div>
      <div class="bar-track"><div class="bar-fill" style="width:${trust}%; background:${color}"></div></div>
    </div>
    <div class="reasons-block"><ul>${flags.length ? flags.map(f => `<li>${f}</li>`).join('') : '<li>No trust-reducing signals detected in this transcript.</li>'}</ul></div>
  `;
});

// ---------------- Role permissions ----------------
// Just two portals: Customer and Admin. Admin has full access to everything
// in the Company Dashboard (Fraud Rule Management, Audit Log, CSV export,
// every risk tier) — kept as a permissions object rather than inlined so
// those features don't need touching if roles are ever reintroduced.
const ROLE_PERMISSIONS = {
  admin: { label: 'Admin', viewTiers: ['HIGH', 'MEDIUM'], canDecide: true, canEditRules: true, canExport: true },
};

function currentRolePermissions() {
  return (currentUser && ROLE_PERMISSIONS[currentUser.role]) || ROLE_PERMISSIONS.admin;
}

// ---------------- Demo authentication ----------------
// Prototype auth: two demo accounts, session held in memory (reload = logout).
// In production this is replaced by real identity (OAuth/SSO + roles).
const DEMO_USERS = {
  'customer@demo.com': { password: 'customer123', role: 'customer', name: 'Alex Morgan' },
  'admin@returnshield.ai': { password: 'admin123', role: 'admin', name: 'Ops Admin' },
};
let currentUser = null;

// Demo customer's order history (what they actually bought)
// serial_number is each order's known-good serial "on file" (what a real
// inventory/fulfillment system would have recorded at ship time) — checked
// against what the customer photographs in the portal's serial-number step.
// Only present for these 7 fixed demo orders; a self-added ("new order")
// return has no inventory record at all, so there's nothing to check against
// (see the new-order-toggle flow below, which never sets this field).
const CUSTOMER_ORDERS = [
  { order_id: 'ORD-1001', product: 'Nike Air Max 90 Sneakers', brand: 'Nike', category: 'Shoes', value: 129.99, days_ago: 4, icon: '👟', serial_number: 'SN-7CQ4-2MXH' },
  { order_id: 'ORD-1002', product: 'Apple AirPods Pro 2', brand: 'Apple', category: 'Electronics', value: 249.00, days_ago: 7, icon: '🎧', serial_number: 'SN-4F82-K93X' },
  { order_id: 'ORD-1003', product: 'Samsung Galaxy Watch 6', brand: 'Samsung', category: 'Electronics', value: 299.99, days_ago: 12, icon: '⌚', serial_number: 'SN-9GT5-XQ84' },
  { order_id: 'ORD-1004', product: "Levi's 501 Original Jeans", brand: 'Levis', category: 'Apparel', value: 89.50, days_ago: 3, icon: '👖', serial_number: 'SN-2KB7-XQ94' },
  { order_id: 'ORD-1005', product: 'Adidas Ultraboost Light', brand: 'Adidas', category: 'Shoes', value: 189.99, days_ago: 20, icon: '👟', serial_number: 'SN-6RY3-9CDF' },
  { order_id: 'ORD-1006', product: 'USB-C Charging Cable (6ft)', brand: 'Anker', category: 'Electronics', value: 8.99, days_ago: 2, icon: '🔌', serial_number: 'SN-3NP8-77YX' },
  { order_id: 'ORD-1007', product: 'LG 55" 4K OLED TV', brand: 'LG', category: 'Electronics', value: 799.99, days_ago: 6, icon: '📺', serial_number: 'SN-8HZ6-D2MK' },
];
let selectedOrder = null;

// ---------------- Customer return history (account-level fraud signals) ----------------
// Tracked per customer in localStorage so return frequency/patterns persist
// across page reloads, not just within one session.
const RETURN_HISTORY_KEY = 'returnshield_customer_return_history';
const TOTAL_CUSTOMER_ORDERS = CUSTOMER_ORDERS.length;

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

function loadAllReturnHistory() {
  try { return JSON.parse(localStorage.getItem(RETURN_HISTORY_KEY)) || {}; }
  catch { return {}; }
}

function saveAllReturnHistory(all) {
  try { localStorage.setItem(RETURN_HISTORY_KEY, JSON.stringify(all)); } catch { /* private-mode/no storage */ }
}

function currentCustomerId() {
  return currentUser ? currentUser.email : 'guest-customer';
}

function getCustomerReturnHistory(customerId) {
  return loadAllReturnHistory()[customerId] || { returnsFiled: 0, lowValueReturnsFiled: 0 };
}

function recordCustomerReturn(customerId, { isLowValue }) {
  const all = loadAllReturnHistory();
  const entry = all[customerId] || { returnsFiled: 0, lowValueReturnsFiled: 0 };
  entry.returnsFiled += 1;
  if (isLowValue) entry.lowValueReturnsFiled += 1;
  all[customerId] = entry;
  saveAllReturnHistory(all);
  return entry;
}

const KNOWN_BRANDS = ['nike', 'puma', 'adidas', 'reebok', 'new balance', 'under armour',
  'apple', 'samsung', 'sony', 'lg', 'levis', "levi's", 'gucci', 'zara', 'h&m', 'converse', 'vans', 'asics'];

function detectBrand(text) {
  const lower = (text || '').toLowerCase();
  for (const b of KNOWN_BRANDS) {
    if (lower.includes(b)) return b.replace("levi's", 'levis');
  }
  return null;
}

const KNOWN_RETAILERS = ['amazon', 'walmart', 'target', 'best buy', 'bestbuy', 'costco',
  'ebay', 'etsy', 'home depot', 'lowes', "lowe's", 'macys', "macy's", 'nordstrom', 'ikea', 'wayfair', 'flipkart'];

function detectRetailer(text) {
  const lower = (text || '').toLowerCase();
  for (const r of KNOWN_RETAILERS) {
    if (lower.includes(r)) return r;
  }
  return null;
}

function extractInvoiceTotal(text) {
  // Find monetary amounts; prefer ones near "total"
  const lines = (text || '').split('\n');
  let best = null;
  const moneyRe = /\$?\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2}))/g;
  for (const line of lines) {
    const isTotalLine = /total|amount due|grand total|balance/i.test(line);
    let m;
    while ((m = moneyRe.exec(line)) !== null) {
      const val = parseFloat(m[1].replace(/,/g, ''));
      if (isTotalLine) return val;                    // total line wins immediately
      if (best === null || val > best) best = val;    // else keep the largest amount
    }
  }
  return best;
}

// Uppercase + strip everything but alphanumerics, so "SN-4F82-K93X" and
// "sn4f82k93x" compare equal — OCR/typing noise around punctuation and case
// shouldn't be able to turn a real match into a false mismatch. Mirrored
// server-side as _normalize_serial() in backend/customer_pipeline.py; keep
// both in lockstep by hand if either ever changes (same existing precedent
// as detectBrand/detect_brand living in both places).
function normalizeSerial(s) {
  return (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Two-tier extraction: a serial number printed near a "S/N"/"Serial" label is
// a confident, specific read; one guessed from bare text with no such label
// could just as easily be a barcode's human-readable digits, a model number,
// or a regulatory code sharing the same frame — real, but not reliable enough
// to treat as equivalent evidence. Callers must gate any HIGH-severity
// mismatch decision on `confident === true` (see runSerialOCR below) and
// treat a confident:false read as inconclusive instead, never a confirmed
// mismatch.
function extractSerialNumber(text) {
  if (!text) return null;
  const lines = text.split('\n');
  const keywordRe = /(?:s\/?n|serial\s*(?:no\.?|number|#)?)\s*[:#-]?\s*([A-Z0-9][A-Z0-9-]{4,})/i;
  for (const line of lines) {
    const m = keywordRe.exec(line);
    if (m) return { value: m[1], confident: true };
  }
  const tokens = (text.match(/[A-Z0-9-]{6,}/gi) || [])
    .filter(t => /[A-Z]/i.test(t) && /[0-9]/.test(t));
  if (!tokens.length) return null;
  const longest = tokens.reduce((a, b) => (b.length > a.length ? b : a));
  return { value: longest, confident: false };
}

// ---------------- OCR engine (Tesseract.js, lazy-loaded, graceful fallback) ----------------
// Loads from CDN on first use. If unavailable (offline / file:// restrictions),
// all OCR-dependent checks silently fall back to text-declaration matching.
let ocrWorkerPromise = null;
function getOCR() {
  if (ocrWorkerPromise) return ocrWorkerPromise;
  ocrWorkerPromise = new Promise((resolve) => {
    if (window.Tesseract) return resolve(window.Tesseract);
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/tesseract.js/5.1.0/tesseract.min.js';
    s.onload = () => resolve(window.Tesseract || null);
    s.onerror = () => resolve(null);
    document.head.appendChild(s);
    setTimeout(() => resolve(window.Tesseract || null), 15000);
  });
  return ocrWorkerPromise;
}

async function ocrCanvas(sourceCanvas, statusEl) {
  try {
    const T = await getOCR();
    if (!T) { if (statusEl) statusEl.textContent = 'OCR unavailable in this context — using your typed details instead.'; return null; }
    if (statusEl) statusEl.textContent = 'Reading text from image…';
    const { data } = await T.recognize(sourceCanvas, 'eng');
    if (statusEl) statusEl.textContent = '';
    return data.text || '';
  } catch (e) {
    if (statusEl) statusEl.textContent = 'OCR failed — using your typed details instead.';
    return null;
  }
}

// ---------------- Login / logout ----------------
function doLogin() {
  const email = document.getElementById('login-email').value.trim().toLowerCase();
  const password = document.getElementById('login-password').value;
  const user = DEMO_USERS[email];
  if (!user || user.password !== password) {
    document.getElementById('login-error').textContent = 'Invalid email or password — use one of the demo accounts below.';
    return;
  }
  currentUser = { email, ...user };
  document.getElementById('login-error').textContent = '';
  document.body.classList.add('authed');
  const roleLabel = currentUser.role === 'customer' ? 'customer' : currentRolePermissions().label;
  document.getElementById('user-chip').innerHTML =
    `<div class="comment-avatar">${currentUser.name.slice(0, 2).toUpperCase()}</div><span>${currentUser.name} · ${roleLabel}</span>`;
  // No role gets the view switcher: customers only ever see the portal, and
  // every company role only ever sees the dashboard (scoped to their
  // permissions) — there's no legitimate reason for a company session to
  // view or submit through the customer intake form.
  document.getElementById('view-switch-wrap').style.display = 'none';
  if (currentUser.role === 'customer') {
    setView('customer');
    renderOrderPicker();
  } else {
    setView('company');
    applyRolePermissionsToUI();
  }
}
document.getElementById('login-btn').addEventListener('click', doLogin);
document.getElementById('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.querySelectorAll('.fill-link').forEach(link => {
  link.addEventListener('click', () => {
    const role = link.dataset.fill;
    const entry = Object.entries(DEMO_USERS).find(([, u]) => u.role === role);
    if (!entry) return;
    document.getElementById('login-email').value = entry[0];
    document.getElementById('login-password').value = entry[1].password;
  });
});
document.getElementById('logout-btn').addEventListener('click', () => {
  currentUser = null;
  document.body.classList.remove('authed');
  document.getElementById('login-password').value = '';
  stopStream(); stopPortalStream(); stopInvStream(); stopSerialStream();
});

// ---------------- Order picker (customer account history) ----------------
function renderOrderPicker() {
  const el = document.getElementById('order-picker');
  const selfAddedCard = (selectedOrder && selectedOrder.isNewOrder) ? `
    <div class="order-select-card selected" data-oid="${selectedOrder.order_id}">
      <div class="thumb">${selectedOrder.icon}</div>
      <div class="info">
        <div class="pname">${selectedOrder.product}</div>
        <div class="pmeta">${selectedOrder.order_id} · ${selectedOrder.category} · self-reported, ${selectedOrder.days_ago} day${selectedOrder.days_ago === 1 ? '' : 's'} ago</div>
      </div>
      <div class="price">${fmtMoney2(selectedOrder.value)}</div>
    </div>` : '';
  // Demo-only: showing the order's "known" serial number to the customer
  // here so a tester actually has something to write down and photograph
  // for the step-4 serial check below. A real system would NEVER surface
  // the value a submission is about to be checked against — this exists
  // purely so this prototype's serial-verification feature is testable
  // end-to-end without a real physical product in hand.
  el.innerHTML = selfAddedCard + CUSTOMER_ORDERS.map(o => `
    <div class="order-select-card ${selectedOrder && selectedOrder.order_id === o.order_id ? 'selected' : ''}" data-oid="${o.order_id}">
      <div class="thumb">${o.icon}</div>
      <div class="info">
        <div class="pname">${o.product}</div>
        <div class="pmeta">${o.order_id} · ${o.category} · delivered ${o.days_ago} day${o.days_ago === 1 ? '' : 's'} ago · S/N ${o.serial_number}</div>
      </div>
      <div class="price">${fmtMoney2(o.value)}</div>
    </div>`).join('');
  el.querySelectorAll('.order-select-card').forEach(card => {
    card.addEventListener('click', () => {
      const found = CUSTOMER_ORDERS.find(o => o.order_id === card.dataset.oid);
      if (!found) return; // clicking the already-selected self-added card — nothing to do
      selectedOrder = found;
      renderOrderPicker();
      notifyPortalOrderSelected(selectedOrder);
    });
  });
}

// ---------------- Customer portal: add a new (not pre-listed) order to return ----------------
// An order that isn't in the customer's account history can't be verified
// against a system-of-record — an attached invoice/receipt becomes the
// proof of purchase instead, and is made mandatory for this path (see the
// guard in the submit handler) rather than optional as it is for orders we
// already have on file.
const newOrderToggle = document.getElementById('new-order-toggle');
const newOrderForm = document.getElementById('new-order-form');
newOrderToggle.addEventListener('click', () => {
  newOrderForm.style.display = newOrderForm.style.display === 'none' ? '' : 'none';
  document.getElementById('no-error').textContent = '';
});
document.getElementById('no-cancel-btn').addEventListener('click', () => {
  newOrderForm.style.display = 'none';
  document.getElementById('no-error').textContent = '';
});
document.getElementById('no-add-btn').addEventListener('click', () => {
  const product = document.getElementById('no-product').value.trim();
  const brand = document.getElementById('no-brand').value.trim();
  const category = document.getElementById('no-category').value;
  const value = parseFloat(document.getElementById('no-value').value);
  const days = parseInt(document.getElementById('no-days').value, 10);
  const errorEl = document.getElementById('no-error');
  if (!product || !brand) { errorEl.textContent = 'Please enter both a product name and brand.'; return; }
  if (Number.isNaN(value) || value <= 0) { errorEl.textContent = 'Please enter a valid purchase price.'; return; }
  if (Number.isNaN(days) || days < 0) { errorEl.textContent = 'Please enter how many days since delivery.'; return; }
  errorEl.textContent = '';
  selectedOrder = {
    order_id: `ORD-CUST-NEW-${simpleHash(product + brand + Date.now()).toString(36)}`,
    product, brand, category, value, days_ago: days, icon: '📦', isNewOrder: true,
  };
  newOrderForm.style.display = 'none';
  document.getElementById('no-product').value = '';
  document.getElementById('no-brand').value = '';
  document.getElementById('no-value').value = '';
  document.getElementById('no-days').value = '';
  portalOrderAcknowledged = false;
  renderOrderPicker();
  notifyPortalOrderSelected(selectedOrder);
});

// ---------------- View switcher: Customer Portal vs Company Dashboard ----------------
const tabCustomer = document.getElementById('tab-customer');
const tabCompany = document.getElementById('tab-company');

function setView(mode) {
  document.body.classList.toggle('customer-mode', mode === 'customer');
  tabCustomer.classList.toggle('active', mode === 'customer');
  tabCompany.classList.toggle('active', mode === 'company');
  // Company-only controls hidden in customer view
  document.getElementById('simulate-btn').style.display = mode === 'customer' ? 'none' : '';
  document.getElementById('reset-btn').style.display = mode === 'customer' ? 'none' : '';
  document.getElementById('live-pill').style.display = mode === 'customer' ? 'none' : '';
  if (mode === 'customer') stopStream();
  if (mode === 'company') stopPortalStream();
}
tabCustomer.addEventListener('click', () => setView('customer'));
tabCompany.addEventListener('click', () => setView('company'));

// Photo requirement is reason-dependent — "Item never arrived" has no item
// to photograph, so the step badge reflects that instead of always saying
// "Required" (which would be self-contradictory for that reason).
function updatePhotoRequiredBadge() {
  const reason = document.getElementById('p-reason').value;
  const notApplicable = NO_PHOTO_REASONS.has(reason);
  [document.getElementById('p-photo-required-badge'), document.getElementById('p-serial-required-badge')].forEach(badge => {
    if (!badge) return;
    if (notApplicable) {
      badge.textContent = 'Not needed for this reason';
      badge.style.color = 'var(--white-faint)';
    } else {
      badge.textContent = 'Required';
      badge.style.color = 'var(--risk-high)';
    }
  });
}
document.getElementById('p-reason').addEventListener('change', updatePhotoRequiredBadge);

// ---------------- Customer portal: photo capture ----------------
const pVideo = document.getElementById('portal-video');
const pCanvas = document.getElementById('portal-canvas');
const pPhotoWrap = document.getElementById('portal-photo-wrap');
const pCameraBtn = document.getElementById('p-camera-btn');
const pCaptureBtn = document.getElementById('p-capture-btn');
const pUploadBtn = document.getElementById('p-upload-btn');
const pFileInput = document.getElementById('p-file-input');
const pPhotoStatus = document.getElementById('p-photo-status');
let portalStream = null;
let portalPhotoTaken = false;

function stopPortalStream() {
  if (portalStream) { portalStream.getTracks().forEach(t => t.stop()); portalStream = null; }
}
window.addEventListener('beforeunload', stopPortalStream);

pCameraBtn.addEventListener('click', async () => {
  const unsupported = cameraSupportMessage();
  if (unsupported) {
    pPhotoStatus.innerHTML = 'Camera needs https or localhost — use "Upload a photo" instead.';
    return;
  }
  try {
    stopPortalStream();
    portalStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    pVideo.srcObject = portalStream;
    await pVideo.play().catch(() => {});
    pPhotoWrap.classList.add('show');
    pVideo.style.display = 'block';
    pCanvas.style.display = 'none';
    pCaptureBtn.style.display = '';
    pPhotoStatus.textContent = '';
    pCameraBtn.textContent = 'Restart camera';
  } catch (err) {
    pPhotoStatus.textContent = err.name === 'NotAllowedError'
      ? 'Camera permission denied — allow it in your address bar, or upload a photo.'
      : `Camera unavailable (${err.name}) — upload a photo instead.`;
  }
});

pCaptureBtn.addEventListener('click', () => {
  if (!portalStream || !pVideo.videoWidth) return;
  pCanvas.width = pVideo.videoWidth;
  pCanvas.height = pVideo.videoHeight;
  pCanvas.getContext('2d').drawImage(pVideo, 0, 0);
  pVideo.style.display = 'none';
  pCanvas.style.display = 'block';
  stopPortalStream();
  pCaptureBtn.style.display = 'none';
  pCameraBtn.textContent = 'Retake photo';
  portalPhotoTaken = true;
  pPhotoStatus.textContent = '✓ Photo attached';
  runPhotoBrandOCR();
  photoCategoryCheckPromise = runPhotoCategoryCheck();
});

pUploadBtn.addEventListener('click', () => pFileInput.click());
pFileInput.addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    pPhotoStatus.textContent = 'Please choose an image file (JPG/PNG).';
    pFileInput.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      stopPortalStream();
      pCanvas.width = img.naturalWidth;
      pCanvas.height = img.naturalHeight;
      pCanvas.getContext('2d').drawImage(img, 0, 0);
      pPhotoWrap.classList.add('show');
      pCanvas.style.display = 'block';
      pVideo.style.display = 'none';
      pCaptureBtn.style.display = 'none';
      portalPhotoTaken = true;
      pPhotoStatus.textContent = `✓ ${file.name} attached`;
      runPhotoBrandOCR();
      photoCategoryCheckPromise = runPhotoCategoryCheck();
    };
    img.onerror = () => { pPhotoStatus.textContent = 'Could not read that image — try another.'; };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
  pFileInput.value = '';
});

// OCR the product photo for visible brand text (progressive enhancement)
let photoDetectedBrand = null;
async function runPhotoBrandOCR() {
  photoDetectedBrand = null;
  const text = await ocrCanvas(pCanvas, document.getElementById('p-photo-ocr'));
  if (text) {
    photoDetectedBrand = detectBrand(text);
    if (photoDetectedBrand) {
      document.getElementById('p-photo-ocr').textContent =
        `Detected brand text in photo: "${photoDetectedBrand.toUpperCase()}"`;
    }
  }
}

// ---------------- Image classification (TensorFlow.js MobileNet, lazy-loaded) ----------------
// Catches a photo that plainly isn't the right kind of item at all — e.g. a
// completely unrelated object photographed for an AirPods return — which
// brand-text OCR above can't catch when there's no readable text in frame.
// ImageNet's 1000 classes don't cover every retail category equally well
// (weak/no coverage for jewelry and beauty especially), so this only ever
// ADDS a mismatch signal on a clear, confident match to a *different*
// category — never on low confidence or "no match" — and it silently no-ops
// if the model can't load (offline, CDN blocked), same graceful-degrade
// pattern as OCR and the camera. This is a heuristic general-object
// classifier, not a verification that the exact product was photographed.
const CATEGORY_IMAGENET_KEYWORDS = {
  'Electronics': ['ipod', 'cellular telephone', 'cellphone', 'mobile phone', 'headset', 'microphone',
    'loudspeaker', 'speaker', 'remote control', 'laptop', 'notebook computer', 'modem', 'hand-held computer',
    'joystick', 'computer keyboard', 'digital watch', 'digital clock', 'tape player', 'cassette player',
    'cd player', 'radio', 'television', 'monitor', 'hard disc', 'printer', 'scanner', 'projector',
    'hearing aid', 'combination lock'], // common ImageNet misclassifications for small earbuds/case-shaped objects
  'Phones': ['cellular telephone', 'cellphone', 'mobile phone', 'ipod'],
  'Laptops': ['laptop', 'notebook computer', 'desktop computer', 'hand-held computer'],
  'Apparel': ['jersey', 't-shirt', 'cardigan', 'sweatshirt', 'miniskirt', 'poncho', 'kimono', 'abaya',
    'sarong', 'bikini', 'military uniform', 'trench coat', 'fur coat', 'lab coat', 'jean', 'denim',
    'overskirt', 'bow tie', 'apron', 'academic gown'],
  'Shoes': ['running shoe', 'clog', 'sandal', 'cowboy boot'],
  'Home & Kitchen': ['frying pan', 'wok', 'microwave', 'toaster', 'dutch oven', 'coffeepot', 'espresso maker',
    'waffle iron', 'refrigerator', 'dishwasher', 'washer', 'vacuum', 'iron', 'teapot', 'plate', 'soup bowl'],
  'Beauty': ['lipstick', 'perfume', 'hair spray', 'face powder'],
  'Toys': ['teddy bear', 'toyshop', 'jigsaw puzzle', "rubik's cube", 'yo-yo', 'balloon', 'kite'],
  'Sporting Goods': ['basketball', 'baseball', 'tennis ball', 'ski', 'soccer ball', 'golf ball', 'dumbbell',
    'punching bag', 'volleyball', 'hockey puck', 'racket'],
  'Jewelry': [], // no reliable ImageNet coverage — never flagged via this path
};

let classifierPromise = null;
function getImageClassifier() {
  if (classifierPromise) return classifierPromise;
  classifierPromise = new Promise((resolve) => {
    if (window.mobilenet) return resolve(window.mobilenet);
    const tfScript = document.createElement('script');
    tfScript.src = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.20.0/dist/tf.min.js';
    tfScript.onload = () => {
      const mnScript = document.createElement('script');
      mnScript.src = 'https://cdn.jsdelivr.net/npm/@tensorflow-models/mobilenet@2.1.1/dist/mobilenet.min.js';
      mnScript.onload = () => resolve(window.mobilenet || null);
      mnScript.onerror = () => resolve(null);
      document.head.appendChild(mnScript);
    };
    tfScript.onerror = () => resolve(null);
    document.head.appendChild(tfScript);
    // The submit button awaits this (see photoCategoryCheckPromise) with a
    // visible "Verifying photo…" message, so a longer budget here is safe UX
    // now — it used to be 8s to avoid a silent wait, but a cold first-load of
    // TF.js (~1MB) + MobileNet (~16MB) from a CDN routinely takes longer than
    // 8s, which meant this timeout won regardless of the photo, silently
    // treating "hasn't finished downloading yet" as "no signal, don't flag."
    // That — not the classification logic — was the actual bug behind a
    // clearly wrong photo (e.g. a ring or a person) still getting approved
    // for an unrelated item. 20s gives a real first load a fair chance to
    // finish; every submission after the first in the same session reuses
    // window.mobilenet/mobilenetModel and resolves instantly.
    setTimeout(() => resolve(window.mobilenet || null), 20000);
  });
  return classifierPromise;
}

let mobilenetModel = null;

// Checks whether ANY of the top-3 predictions plausibly belong to the
// expected category — not just whether the #1 guess happens to land in one
// of the OTHER categories' keyword lists. That distinction matters: a photo
// of something totally uncategorized (a bottle, a wall, a pet) won't match
// ANY category's keywords, so a "does this match a different known
// category" check silently lets it through — which is exactly the bug this
// replaced (a bottle photographed for a Nike Air Max return was approved
// because "bottle" isn't a keyword under any of the 10 retail categories).
// Checking "does it match the EXPECTED category" instead, across the top 3
// guesses (not just #1, to tolerate the model's second-best guess being the
// right one), catches that case while still being reasonably tolerant of
// classifier noise on a genuinely correct photo.
function checkPhotoAgainstCategory(predictions, expectedCategory) {
  if (!predictions || !predictions.length) return null; // classifier unavailable — no signal, don't block
  const expectedKeywords = CATEGORY_IMAGENET_KEYWORDS[expectedCategory];
  if (!expectedKeywords || !expectedKeywords.length) return null; // no reliable coverage for this category (e.g. Jewelry) — don't guess
  // Only bail on genuinely degenerate output (near-uniform noise across all
  // classes) — a real "clearly wrong object" photo (a ring, a person, a
  // bottle) often gets a confident-but-wrong top guess (e.g. "cardigan" at
  // 40% for a person), not a low one, so gating on "top guess is uncertain"
  // let exactly the fraudulent case through: a low-confidence guess isn't
  // evidence the photo is secretly a shoe, it's often evidence it isn't one.
  if (predictions[0].probability < 0.05) return null;
  const topGuesses = predictions.slice(0, 5); // check more than the top-3 to tolerate the right answer landing 4th/5th
  const matchesExpected = topGuesses.some(p => expectedKeywords.some(k => p.className.toLowerCase().includes(k)));
  if (matchesExpected) return { mismatch: false };
  // Flagging the mismatch itself only needs "none of the top-5 look like the
  // expected category" — that's true whether the top guess is confident or
  // not. But quoting a SPECIFIC wrong object name back to the analyst is a
  // separate claim ("this is a burrito") that needs its own bar: MobileNet's
  // top-1 guess on a genuinely off-category photo is very often a low-
  // confidence, close-to-arbitrary label (a bottle might score 8% "burrito",
  // 7% "corkscrew", 6% "beer bottle" — all near-noise, picking whichever
  // edged out the others by a hair). Reporting that as "shows a burrito" is
  // asserting something the classifier doesn't actually know. Below this bar,
  // report the mismatch without a specific label — still true, just honest
  // about what the classifier does and doesn't know.
  const confidentLabel = predictions[0].probability >= 0.15;
  return { mismatch: true, label: confidentLabel ? predictions[0].className : null };
}

let photoCategoryMismatch = false;
let photoClassifiedLabel = null;
// The submit handler awaits this before reading photoCategoryMismatch — this
// check is async (loads a model over the network + runs inference, which can
// take several seconds), and without something to await, a customer who
// photographs the item and submits quickly would sail through before the
// check ever finished, silently skipping it every time. That race condition
// — not the classification logic itself — was the actual bug behind
// mismatched photos (e.g. AirPods photographed for a Nike Air Max return)
// getting approved.
let photoCategoryCheckPromise = null;
async function runPhotoCategoryCheck() {
  photoCategoryMismatch = false;
  photoClassifiedLabel = null;
  if (!selectedOrder) return;
  try {
    const mn = await getImageClassifier();
    if (!mn) return; // offline / CDN blocked — silently skip, matches OCR's fallback behavior
    if (!mobilenetModel) mobilenetModel = await mn.load();
    const predictions = await mobilenetModel.classify(pCanvas, 5);
    const result = checkPhotoAgainstCategory(predictions, selectedOrder.category);
    if (result && result.mismatch) {
      photoCategoryMismatch = true;
      photoClassifiedLabel = result.label;
    }
  } catch (e) {
    photoCategoryMismatch = false;
  }
}

// ---------------- Customer portal: INVOICE attach / capture (any retailer) ----------------
const pInvVideo = document.getElementById('p-inv-video');
const pInvCanvas = document.getElementById('p-inv-canvas');
const pInvWrap = document.getElementById('portal-inv-wrap');
const pInvStatus = document.getElementById('p-inv-status');
let invStream = null;
let invoiceAttached = false;
let invoiceOCRData = { retailer: null, total: null, brand: null, raw: null };

function stopInvStream() {
  if (invStream) { invStream.getTracks().forEach(t => t.stop()); invStream = null; }
}
window.addEventListener('beforeunload', stopInvStream);

document.getElementById('p-inv-camera-btn').addEventListener('click', async () => {
  const unsupported = cameraSupportMessage();
  if (unsupported) { pInvStatus.textContent = 'Camera needs https or localhost — upload instead.'; return; }
  try {
    stopInvStream();
    invStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    pInvVideo.srcObject = invStream;
    await pInvVideo.play().catch(() => {});
    pInvWrap.classList.add('show');
    pInvVideo.style.display = 'block';
    pInvCanvas.style.display = 'none';
    document.getElementById('p-inv-capture-btn').style.display = '';
    pInvStatus.textContent = 'Hold the invoice flat and well-lit';
  } catch (err) {
    pInvStatus.textContent = err.name === 'NotAllowedError'
      ? 'Camera permission denied — upload the invoice instead.'
      : `Camera unavailable (${err.name}) — upload instead.`;
  }
});

document.getElementById('p-inv-capture-btn').addEventListener('click', async () => {
  if (!invStream || !pInvVideo.videoWidth) return;
  pInvCanvas.width = pInvVideo.videoWidth;
  pInvCanvas.height = pInvVideo.videoHeight;
  pInvCanvas.getContext('2d').drawImage(pInvVideo, 0, 0);
  pInvVideo.style.display = 'none';
  pInvCanvas.style.display = 'block';
  stopInvStream();
  document.getElementById('p-inv-capture-btn').style.display = 'none';
  invoiceAttached = true;
  pInvStatus.textContent = '✓ Invoice captured';
  await runInvoiceOCR();
});

document.getElementById('p-inv-upload-btn').addEventListener('click', () => document.getElementById('p-inv-file-input').click());
document.getElementById('p-inv-file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.type === 'application/pdf') {
    invoiceAttached = true;
    invoiceOCRData = { retailer: null, total: null, brand: null, raw: null };
    pInvStatus.textContent = `✓ ${file.name} attached (PDF — text extraction runs server-side in production)`;
    e.target.value = '';
    return;
  }
  if (!file.type.startsWith('image/')) {
    pInvStatus.textContent = 'Please choose an image or PDF.';
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = async () => {
      stopInvStream();
      pInvCanvas.width = img.naturalWidth;
      pInvCanvas.height = img.naturalHeight;
      pInvCanvas.getContext('2d').drawImage(img, 0, 0);
      pInvWrap.classList.add('show');
      pInvCanvas.style.display = 'block';
      pInvVideo.style.display = 'none';
      invoiceAttached = true;
      pInvStatus.textContent = `✓ ${file.name} attached`;
      await runInvoiceOCR();
    };
    img.onerror = () => { pInvStatus.textContent = 'Could not read that image — try another.'; };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});

async function runInvoiceOCR() {
  invoiceOCRData = { retailer: null, total: null, brand: null, raw: null };
  const text = await ocrCanvas(pInvCanvas, document.getElementById('p-inv-ocr'));
  if (!text) return;
  invoiceOCRData.raw = text;
  invoiceOCRData.retailer = detectRetailer(text);
  invoiceOCRData.total = extractInvoiceTotal(text);
  invoiceOCRData.brand = detectBrand(text);
  const bits = [];
  if (invoiceOCRData.retailer) bits.push(`retailer: ${invoiceOCRData.retailer.toUpperCase()}`);
  if (invoiceOCRData.total !== null) bits.push(`total: ${fmtMoney2(invoiceOCRData.total)}`);
  if (invoiceOCRData.brand) bits.push(`brand on invoice: ${invoiceOCRData.brand.toUpperCase()}`);
  document.getElementById('p-inv-ocr').textContent = bits.length
    ? 'Read from invoice — ' + bits.join(' · ')
    : 'Invoice attached (no structured fields recognized — reviewed manually)';
}

// ---------------- Customer portal: SERIAL NUMBER / label photo ----------------
// Verifies the physical unit being returned against the order's serial
// number on file (an inventory/fulfillment record in a real system) — the
// strongest evidence this app has against a swapped/counterfeit-unit return,
// since it's an exact identifier check rather than a fuzzy brand/category
// guess. Structurally identical to the invoice capture above; the one real
// difference is runSerialOCR's result is tracked as a promise
// (serialOCRPromise) rather than awaited inline in the click handlers — same
// fix already applied once in this file for the photo-category classifier
// (see photoCategoryCheckPromise's comment), because the submit handler's
// mismatch decision depends on this specific check having fully resolved
// before scoring, not just "probably done by the time they click submit."
const pSerialVideo = document.getElementById('p-serial-video');
const pSerialCanvas = document.getElementById('p-serial-canvas');
const pSerialWrap = document.getElementById('portal-serial-wrap');
const pSerialStatus = document.getElementById('p-serial-status');
let serialStream = null;
let serialPhotoTaken = false;
let detectedSerialNumber = null;   // normalized value, or null if nothing usable was read
let serialConfident = false;       // true only for a keyword-anchored read (see extractSerialNumber)
let serialOCRRaw = null;
let serialOCRPromise = null;

function stopSerialStream() {
  if (serialStream) { serialStream.getTracks().forEach(t => t.stop()); serialStream = null; }
}
window.addEventListener('beforeunload', stopSerialStream);

document.getElementById('p-serial-camera-btn').addEventListener('click', async () => {
  const unsupported = cameraSupportMessage();
  if (unsupported) { pSerialStatus.textContent = 'Camera needs https or localhost — upload instead.'; return; }
  try {
    stopSerialStream();
    serialStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'environment', width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false });
    pSerialVideo.srcObject = serialStream;
    await pSerialVideo.play().catch(() => {});
    pSerialWrap.classList.add('show');
    pSerialVideo.style.display = 'block';
    pSerialCanvas.style.display = 'none';
    document.getElementById('p-serial-capture-btn').style.display = '';
    pSerialStatus.textContent = 'Get close — the serial/label text should fill the frame';
  } catch (err) {
    pSerialStatus.textContent = err.name === 'NotAllowedError'
      ? 'Camera permission denied — upload the photo instead.'
      : `Camera unavailable (${err.name}) — upload instead.`;
  }
});

document.getElementById('p-serial-capture-btn').addEventListener('click', () => {
  if (!serialStream || !pSerialVideo.videoWidth) return;
  pSerialCanvas.width = pSerialVideo.videoWidth;
  pSerialCanvas.height = pSerialVideo.videoHeight;
  pSerialCanvas.getContext('2d').drawImage(pSerialVideo, 0, 0);
  pSerialVideo.style.display = 'none';
  pSerialCanvas.style.display = 'block';
  stopSerialStream();
  document.getElementById('p-serial-capture-btn').style.display = 'none';
  serialPhotoTaken = true;
  pSerialStatus.textContent = '✓ Serial/label photo captured';
  serialOCRPromise = runSerialOCR();
});

document.getElementById('p-serial-upload-btn').addEventListener('click', () => document.getElementById('p-serial-file-input').click());
document.getElementById('p-serial-file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    pSerialStatus.textContent = 'Please choose an image.';
    e.target.value = '';
    return;
  }
  const reader = new FileReader();
  reader.onload = (ev) => {
    const img = new Image();
    img.onload = () => {
      stopSerialStream();
      pSerialCanvas.width = img.naturalWidth;
      pSerialCanvas.height = img.naturalHeight;
      pSerialCanvas.getContext('2d').drawImage(img, 0, 0);
      pSerialWrap.classList.add('show');
      pSerialCanvas.style.display = 'block';
      pSerialVideo.style.display = 'none';
      serialPhotoTaken = true;
      pSerialStatus.textContent = `✓ ${file.name} attached`;
      serialOCRPromise = runSerialOCR();
    };
    img.onerror = () => { pSerialStatus.textContent = 'Could not read that image — try another.'; };
    img.src = ev.target.result;
  };
  reader.readAsDataURL(file);
  e.target.value = '';
});

async function runSerialOCR() {
  detectedSerialNumber = null;
  serialConfident = false;
  serialOCRRaw = null;
  const text = await ocrCanvas(pSerialCanvas, document.getElementById('p-serial-ocr'));
  serialOCRRaw = text || null;
  if (!text) return;
  const found = extractSerialNumber(text);
  if (!found) {
    document.getElementById('p-serial-ocr').textContent = 'Serial number not clearly readable — will be reviewed manually.';
    return;
  }
  detectedSerialNumber = normalizeSerial(found.value);
  serialConfident = found.confident;
  document.getElementById('p-serial-ocr').textContent = found.confident
    ? `Detected serial number: "${found.value}"`
    : `Possible serial number: "${found.value}" (low confidence — will be reviewed manually)`;
}

// ---------------- Customer portal: AI support chat + live NLP intent scoring ----------------
// Design note: the chat runs the same trust-scoring rules as Agent 2 on every
// customer message, but — matching this app's anti-fraud principle of never
// tipping off bad actors (see submit_customer_return in backend/main.py) —
// the assistant's replies never surface a score, label, or flag list to the
// customer. The signal is used silently and only feeds the real fraud
// pipeline + the Company Dashboard's analyst view.
const portalChatThread = document.getElementById('portal-chat-thread');
const portalChatInput = document.getElementById('portal-chat-input');
const portalChatSend = document.getElementById('portal-chat-send');

let portalChatLog = [];       // [{role: 'customer'|'agent', text}]
let portalOrderAcknowledged = false;
let portalConversationTurn = 0;
let portalChatRejected = false;

// Reason-specific opening questions — asked once, right after the customer's
// first message, the way a support agent would probe the specific claim
// instead of a generic "tell me more."
const FOLLOWUP_QUESTIONS = {
  'Item arrived damaged': (p) => `Thanks for letting me know about your ${p}. Could you tell me specifically what's damaged — the packaging, the item itself, or both — and did you notice it right when it arrived?`,
  'Wrong item sent': (p) => `Sorry about that — you ordered the ${p}. What did you actually receive instead?`,
  'Item not as described': (p) => `Got it — what's different about the ${p} compared to what was listed on the product page?`,
  'Defective / stopped working': (p) => `Understood. When did the ${p} stop working, and had it been working normally before that?`,
  'Missing parts/accessories': (p) => `Thanks — which parts or accessories are missing from your ${p}?`,
  'Item never arrived': () => "I'm sorry to hear that. Just to check — does your tracking show the package as delivered, or still in transit?",
  'Changed my mind': (p) => `No problem at all — was there something specific about the ${p} that didn't work out, or just a change of plans?`,
};

function scrollPortalChatToBottom() {
  portalChatThread.scrollTop = portalChatThread.scrollHeight;
}

function chatAvatarHTML(role) {
  return role === 'agent'
    ? '<div class="chat-avatar agent">AI</div>'
    : `<div class="chat-avatar user">${currentUser ? currentUser.name.charAt(0) : 'Y'}</div>`;
}

function addPortalChatBubble(text, role = 'agent') {
  const row = document.createElement('div');
  row.className = `chat-row ${role}`;
  row.innerHTML = `${chatAvatarHTML(role)}<div class="chat-bubble ${role}">${text}</div>`;
  portalChatThread.appendChild(row);
  scrollPortalChatToBottom();
  return row;
}

function showPortalTyping() {
  const row = document.createElement('div');
  row.className = 'chat-row agent';
  row.id = 'portal-chat-typing';
  row.innerHTML = `${chatAvatarHTML('agent')}<div class="chat-bubble agent typing-dots"><span></span><span></span><span></span></div>`;
  portalChatThread.appendChild(row);
  scrollPortalChatToBottom();
}

function hidePortalTyping() {
  const el = document.getElementById('portal-chat-typing');
  if (el) el.remove();
}

// Crafts a natural, customer-safe reply. It reacts to what the NLP layer
// found (e.g. asks a clarifying question on a contradiction, de-escalates on
// hostile language) and otherwise asks a reason- and product-specific
// follow-up the way a real support agent would, instead of a generic
// "tell me more" every time.
function craftAssistantReply(message, analysis) {
  if (NON_ARRIVAL_RE.test(message) && DELIVERED_RE.test(message)) {
    return "Just to make sure I've got this right — tracking shows the package as delivered, but it didn't actually reach you? I've noted that for the team.";
  }
  // Cross-turn contradiction (analyzeConversationIntent) — the honest
  // customer-facing surface of "NLP judges intent": a clarifying question,
  // never a score, badge, or the word "suspicious."
  if (analysis.flags.some(f => f.startsWith('Story changed between messages'))) {
    return "I want to make sure I've got the full picture — a couple of the details you've shared don't quite line up with each other. Could you walk me through what happened, in order?";
  }
  const isHostile = ABUSIVE_RE.some(r => r.test(message)) || MANIP_RE.some(r => r.test(message));
  if (isHostile) {
    return "I understand this is frustrating, and I'm sorry for the trouble — I've logged everything you've shared so our team can prioritize it.";
  }
  if (isVagueReply(message) && portalConversationTurn > 1) {
    return "Could you tell me a bit more about that? Any extra detail helps our team process this faster.";
  }

  const reason = document.getElementById('p-reason').value;
  const product = selectedOrder ? selectedOrder.product : 'this item';

  if (portalConversationTurn === 1) {
    const opener = FOLLOWUP_QUESTIONS[reason];
    if (opener) return opener(product);
  }
  if (portalConversationTurn === 2) {
    return "Thanks, that's really helpful detail. If you have a photo of it, go ahead and attach one in step 3 — otherwise you're all set to continue below.";
  }
  if (analysis.flags.length) {
    return "Thanks for the details. I've recorded this and it'll be included with your request for review.";
  }
  const generic = [
    "Got it, thank you for explaining. Feel free to add a photo in the next step if you have one.",
    "Thanks — that's helpful context. You can continue with the steps below whenever you're ready.",
    "Understood, I've added that to your request. Let me know if there's anything else worth mentioning.",
  ];
  return generic[portalConversationTurn % generic.length];
}

function seedPortalChat() {
  portalChatThread.innerHTML = '';
  portalChatLog = [];
  portalOrderAcknowledged = false;
  portalConversationTurn = 0;
  portalChatRejected = false;
  addPortalChatBubble("Hi, I'm the ReturnShield assistant. Tell me what happened with your order and I'll pass the details straight to our team.", 'agent');
}

// Once the customer picks an order (step 1), greet them by product name and
// run the account-level checks (return frequency, repeat low-value returns)
// right away — these don't depend on anything they type, so there's no
// reason to wait for chat to catch them at submission time.
function notifyPortalOrderSelected(order) {
  if (portalOrderAcknowledged) return;
  portalOrderAcknowledged = true;

  const history = getCustomerReturnHistory(currentCustomerId());
  const projectedReturns = history.returnsFiled + 1;
  const projectedRate = projectedReturns / TOTAL_CUSTOMER_ORDERS;
  const isLowValueOrder = order.value < FRAUD_RULES.lowValueThreshold;
  const projectedLowValue = history.lowValueReturnsFiled + (isLowValueOrder ? 1 : 0);

  if (projectedRate > FRAUD_RULES.returnRateThreshold) {
    portalChatRejected = true;
    addPortalChatBubble(
      `Thanks — I can see your ${order.product} (${order.order_id}). Before we go further: this would be your ${ordinal(projectedReturns)} return out of ${TOTAL_CUSTOMER_ORDERS} orders on this account, which is above what we're able to approve automatically. I've flagged this request for our review team.`,
      'agent'
    );
    return;
  }
  if (isLowValueOrder && projectedLowValue > FRAUD_RULES.lowValueFreePasses) {
    portalChatRejected = true;
    addPortalChatBubble(
      `Thanks — I can see your ${order.product} (${order.order_id}). I see you've had a few similar low-value returns recently, so I've flagged this one for review by our team rather than approving it automatically.`,
      'agent'
    );
    return;
  }
  addPortalChatBubble(`Thanks — I can see your ${order.product} (${order.order_id}). What happened with it?`, 'agent');
}

function sendPortalChatMessage() {
  const message = portalChatInput.value.trim();
  if (!message) return;
  addPortalChatBubble(message, 'customer');
  portalChatLog.push({ role: 'customer', text: message });
  portalChatInput.value = '';
  portalChatSend.disabled = true;
  portalConversationTurn += 1;

  // Score the FULL conversation so far (not just this message) — catches
  // signals split across turns, e.g. "never arrived" in one message and
  // "delivered" in the next, or a claim that changes between messages. This
  // also feeds the real fraud pipeline (see analyzeConversationIntent).
  const fullAnalysis = analyzeConversationIntent(portalChatLog);
  const orderBrand = selectedOrder ? selectedOrder.brand.toLowerCase().replace("levi's", 'levis') : null;
  const mentionedBrand = detectBrand(message);
  const brandConflict = !!(orderBrand && mentionedBrand && mentionedBrand !== orderBrand);
  // A hard in-chat decline is reserved for strong, stacked signals (or an
  // unambiguous brand mismatch) — a single moderate signal (one contradiction,
  // one hostile remark) instead gets a clarifying question from
  // craftAssistantReply, never a "suspicious"-sounding message.
  const newlySuspicious = !portalChatRejected && (fullAnalysis.trust < 40 || brandConflict);

  showPortalTyping();
  setTimeout(() => {
    hidePortalTyping();
    let reply;
    if (portalChatRejected) {
      reply = "This request is already flagged for review, so there's nothing more you need to add here — you're welcome to finish the form below.";
    } else if (newlySuspicious) {
      portalChatRejected = true;
      reply = brandConflict
        ? "I'm sorry, but the item you're describing doesn't match what was ordered, so I'm not able to approve this return. I've flagged it for our fraud review team."
        : "I'm sorry, but based on what's been shared I'm not able to approve this return automatically. I've flagged this request for our fraud review team.";
    } else {
      reply = craftAssistantReply(message, fullAnalysis);
    }
    addPortalChatBubble(reply, 'agent');
    portalChatLog.push({ role: 'agent', text: reply });
    portalChatSend.disabled = false;
    portalChatInput.focus();
  }, 500 + Math.random() * 400);
}

portalChatSend.addEventListener('click', sendPortalChatMessage);
portalChatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    sendPortalChatMessage();
  }
});

// Builds the same "Customer: ... / Agent: ..." transcript shape used
// throughout the demo data (data/generate_data.py, agents/nlp_agent.py) so
// the real trust score is computed off the actual conversation, and analysts
// in the Company Dashboard see exactly what the customer said.
function getPortalChatTranscript() {
  if (!portalChatLog.length) return '(no conversation with the support assistant)';
  return portalChatLog.map(m => `${m.role === 'customer' ? 'Customer' : 'Agent'}: ${m.text}`).join('\n');
}

// ---------------- Customer portal: submission through the full pipeline ----------------
function analyzePortalPhoto() {
  // A photo is now a mandatory, submission-blocking requirement (see the
  // guard at the top of the p-submit-btn handler), so this early-return only
  // matters while the form is still being filled out (e.g. live UI checks
  // before the customer has attached anything).
  if (!portalPhotoTaken || !pCanvas.width) {
    return { score: 50, flags: [], provided: false };
  }
  let score = 100; const flags = [];
  if (pCanvas.width < 320 || pCanvas.height < 240) {
    score -= 20; flags.push(`Very low resolution photo (${pCanvas.width}×${pCanvas.height}) — possible screenshot/thumbnail`);
  }
  const hash = computeAHash(pCanvas);
  const nearMatch = seenImageHashes.find(prev => hammingDistance(prev.hash, hash) <= 5);
  if (nearMatch) { score -= 35; flags.push(`Customer photo is a near-duplicate of a previously submitted image (${nearMatch.label})`); }
  seenImageHashes.push({ hash, label: 'customer submission @ ' + new Date().toLocaleTimeString() });
  const brightness = computeBrightness(getImageData(pCanvas));
  if (brightness < 40) { score -= 15; flags.push(`Customer photo is very dark (brightness ${brightness.toFixed(0)}/255) — details unverifiable`); }
  const sharpness = computeSharpness(pCanvas);
  if (sharpness < 4) { score -= 20; flags.push(`Customer photo is blurry (sharpness ${sharpness.toFixed(1)}) — could conceal item condition`); }
  return { score: Math.max(0, Math.min(100, score)), flags, provided: true };
}

let portalCounter = 0;

// Shared by both the backend-driven and offline-fallback submission paths so
// resetting the form for another return only has one implementation.
function appendSubmitAnotherButton(statusEl, formCard) {
  const again = document.createElement('button');
  again.className = 'ghost';
  again.style.marginTop = '16px';
  again.textContent = 'Submit another return';
  again.addEventListener('click', () => {
    statusEl.classList.remove('show');
    formCard.style.display = '';
    seedPortalChat();
    document.getElementById('p-item-returned').value = '';
    document.getElementById('p-match-result').className = 'match-result';
    portalPhotoTaken = false;
    photoDetectedBrand = null;
    photoCategoryMismatch = false;
    photoClassifiedLabel = null;
    photoCategoryCheckPromise = null;
    invoiceAttached = false;
    invoiceOCRData = { retailer: null, total: null, brand: null, raw: null };
    serialPhotoTaken = false;
    detectedSerialNumber = null;
    serialConfident = false;
    serialOCRRaw = null;
    serialOCRPromise = null;
    pPhotoStatus.textContent = '';
    pInvStatus.textContent = '';
    pSerialStatus.textContent = '';
    document.getElementById('p-photo-ocr').textContent = '';
    document.getElementById('p-inv-ocr').textContent = '';
    document.getElementById('p-serial-ocr').textContent = '';
    updatePhotoRequiredBadge();
    pPhotoWrap.classList.remove('show');
    pInvWrap.classList.remove('show');
    pSerialWrap.classList.remove('show');
    selectedOrder = null;
    renderOrderPicker();
  });
  statusEl.appendChild(again);
}

// Renders the customer-facing status screen from a backend /api/submit-return
// response — same visual treatment (icons, rejection-reasons list) as the
// offline fallback below, just driven by the server's decision instead of a
// locally-computed one.
function renderPortalStatusFromBackendResult(result) {
  const statusEl = document.getElementById('portal-status');
  const formCard = document.getElementById('portal-form-card');
  const cfg = {
    approved: { icon: ICONS.success, color: 'var(--risk-low)', heading: 'Your return is approved' },
    under_review: { icon: ICONS.pending, color: 'var(--risk-med)', heading: "We're reviewing your request" },
    rejected: { icon: ICONS.error, color: 'var(--risk-high)', heading: "We're unable to approve this return" },
  }[result.status] || { icon: ICONS.pending, color: 'var(--risk-med)', heading: 'Update on your return' };

  const reasonsHTML = (result.reasons && result.reasons.length) ? `
    <div style="margin-top:14px; text-align:left;">
      <div style="font-size:11px; color:var(--white-faint); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px;">Why this was declined</div>
      <ul style="list-style:none;">
        ${result.reasons.map(r => `<li style="font-size:13px; color:var(--white-dim); padding:5px 0 5px 18px; position:relative;"><span style="position:absolute; left:0; color:var(--risk-high);">•</span>${r}</li>`).join('')}
      </ul>
    </div>` : '';

  statusEl.innerHTML = `
    <div class="status-icon" style="color:${cfg.color};">${cfg.icon}</div>
    <h3>${cfg.heading}</h3>
    <p>${result.message}</p>
    ${reasonsHTML}
    <div class="case-ref">Reference: ${result.reference}</div>`;
  statusEl.classList.add('show');
  formCard.style.display = 'none';
  stopPortalStream();
  stopInvStream();
  stopSerialStream();
  appendSubmitAnotherButton(statusEl, formCard);
}

document.getElementById('p-submit-btn').addEventListener('click', async () => {
  const matchResultEl = document.getElementById('p-match-result');
  matchResultEl.className = 'match-result';

  if (!selectedOrder) {
    matchResultEl.classList.add('show', 'bad');
    matchResultEl.textContent = 'Please select which order you are returning (step 1).';
    return;
  }
  if (selectedOrder.isNewOrder && !invoiceAttached) {
    matchResultEl.classList.add('show', 'bad');
    matchResultEl.textContent = 'Since this order isn\'t in our system, an invoice or receipt is required as proof of purchase (step 5).';
    return;
  }
  const reason = document.getElementById('p-reason').value;
  const photoNotApplicable = NO_PHOTO_REASONS.has(reason);
  if (!photoNotApplicable && (!portalPhotoTaken || !pCanvas.width)) {
    matchResultEl.classList.add('show', 'bad');
    matchResultEl.textContent = 'A photo of the item is required before we can process your return (step 3).';
    return;
  }
  if (!photoNotApplicable && (!serialPhotoTaken || !pSerialCanvas.width)) {
    matchResultEl.classList.add('show', 'bad');
    matchResultEl.textContent = 'A photo of the serial number/label is required before we can process your return (step 4).';
    return;
  }
  const itemReturned = document.getElementById('p-item-returned').value.trim();
  const chatTranscript = getPortalChatTranscript();
  const value = selectedOrder.value;
  const days = selectedOrder.days_ago;
  const orderBrand = selectedOrder.brand.toLowerCase().replace("levi's", 'levis');
  // Wait for the (async, CDN-loaded) photo classification AND serial-number
  // OCR to actually finish before scoring — without this, a customer who
  // captures photos and submits quickly would sail through before either
  // check completed, silently skipping them regardless of what's in the
  // photos (the exact bug this pattern already had to fix once for the
  // photo-category classifier).
  if (!photoNotApplicable && (photoCategoryCheckPromise || serialOCRPromise)) {
    matchResultEl.classList.add('show');
    matchResultEl.textContent = 'Verifying photos…';
    await Promise.all([photoCategoryCheckPromise, serialOCRPromise]);
    matchResultEl.classList.remove('show');
    matchResultEl.textContent = '';
  }
  // "Item never arrived" is self-contradictory with a photo requirement — the
  // customer doesn't have the item to photograph. Treat photo evidence as
  // fully neutral (not "unverified") and never store/send an image for it,
  // even if one happens to be sitting in the canvas from a prior reason.
  const img = photoNotApplicable ? { score: 100, flags: [], provided: false } : analyzePortalPhoto();

  // ---- Try the real backend first; only fall back to local scoring if it's
  // genuinely unreachable (see API_BASE comment at the top of this file). ----
  if (backendAvailable) {
    const result = await apiFetch('/api/submit-return', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        order_id: selectedOrder.order_id,
        email: currentCustomerId(),
        category: selectedOrder.category,
        purchase_value: value,
        reason,
        days_since_delivery: days,
        chat_transcript: chatTranscript,
        chat_turns: portalChatLog.filter(m => m.role === 'customer').map(m => m.text),
        product_ordered: selectedOrder.product,
        item_declared: itemReturned || '(not stated)',
        order_brand: selectedOrder.brand,
        photo_provided: !photoNotApplicable,
        photo_data_url: (!photoNotApplicable && pCanvas.width) ? pCanvas.toDataURL('image/jpeg', 0.72) : '',
        photo_score: img.score,
        photo_flags: img.flags,
        photo_detected_brand: photoNotApplicable ? '' : (photoDetectedBrand || ''),
        photo_category_mismatch: !photoNotApplicable && photoCategoryMismatch,
        photo_classified_label: photoNotApplicable ? '' : (photoClassifiedLabel || ''),
        invoice_attached: invoiceAttached,
        invoice_data_url: (invoiceAttached && pInvCanvas.width) ? pInvCanvas.toDataURL('image/jpeg', 0.72) : '',
        invoice_total: invoiceOCRData.total,
        invoice_retailer: invoiceOCRData.retailer || '',
        invoice_brand: invoiceOCRData.brand || '',
        serial_photo_provided: !photoNotApplicable && serialPhotoTaken,
        serial_photo_data_url: (!photoNotApplicable && pSerialCanvas.width) ? pSerialCanvas.toDataURL('image/jpeg', 0.72) : '',
        detected_serial: photoNotApplicable ? '' : (detectedSerialNumber || ''),
        serial_confident: !photoNotApplicable && serialConfident,
        order_known_serial: selectedOrder.serial_number || '',
        is_new_order: !!selectedOrder.isNewOrder,
      }),
    });
    if (result) {
      await refreshCasesFromBackend();
      await refreshAuditLogFromBackend();
      renderPortalStatusFromBackendResult(result);
      return;
    }
    // backend call failed mid-session — fall through to full local scoring
    // below so the submission still succeeds.
  }

  // ---- OFFLINE FALLBACK: full client-side scoring (used whenever the
  // backend isn't running) ----
  // ---- Account-level history: return frequency + repeat low-value pattern ----
  const customerId = currentCustomerId();
  const returnHistory = getCustomerReturnHistory(customerId);
  const isLowValueOrder = value < FRAUD_RULES.lowValueThreshold;
  const isHighValueOrder = value > FRAUD_RULES.highValueDropoffThreshold;
  const projectedReturnsFiled = returnHistory.returnsFiled + 1;
  const returnRate = projectedReturnsFiled / TOTAL_CUSTOMER_ORDERS;
  const exceedsReturnRate = returnRate > FRAUD_RULES.returnRateThreshold;
  const projectedLowValueReturns = returnHistory.lowValueReturnsFiled + (isLowValueOrder ? 1 : 0);
  const isLeniedLowValue = isLowValueOrder && projectedLowValueReturns <= FRAUD_RULES.lowValueFreePasses;
  const isRepeatLowValueAbuse = isLowValueOrder && projectedLowValueReturns > FRAUD_RULES.lowValueFreePasses;
  // A quick, same-reason exchange sequence (buy a 10.5, doesn't fit, get an
  // 11, still doesn't fit, get a 12 — each returned promptly) is normal
  // shopping, not return-frequency abuse, even though it can trip the
  // return-rate/repeat-low-value checks above on raw count alone. Genuinely
  // holding onto an item well past a reasonable try-it-on window before
  // sending it back is the actual fraud-adjacent signal (classic
  // "wardrobing") — that's staleReturn below, and it applies regardless of
  // reason.
  const promptExchange = isPromptExchange(reason, days);
  const staleReturn = days > FRAUD_RULES.lateReturnDays;

  // ============ PRODUCT MATCH VERIFICATION (Agent 3 upgrade) ============
  // Four evidence sources, strongest/most-specific wins:
  //   1. Brand text OCR'd from the item photo
  //   2. Brand on the attached invoice
  //   3. Brand in the customer's own declaration
  //   4. General object classification of the photo (catches a photo that
  //      isn't the right kind of item at all, even with no readable text —
  //      see runPhotoCategoryCheck)
  let mismatchEvidence = null;
  const declaredBrand = detectBrand(itemReturned);
  // Serial-number check is the FIRST and strongest signal — an exact
  // identifier disagreement, not a fuzzy brand/category guess — so it wins
  // over every other mismatch source below. Skipped entirely for a self-
  // added order (no inventory record exists to check against) and never
  // escalates to a confirmed mismatch on a low-confidence (non-keyword-
  // anchored) OCR read — that's inconclusive, not proof, and only floors the
  // tier at MEDIUM further down.
  let serialInconclusive = false;
  let serialMismatchFired = false;
  if (!photoNotApplicable && !selectedOrder.isNewOrder && selectedOrder.serial_number) {
    if (!detectedSerialNumber || !serialConfident) {
      serialInconclusive = !!serialPhotoTaken;
    } else if (detectedSerialNumber !== normalizeSerial(selectedOrder.serial_number)) {
      mismatchEvidence = `Photographed serial number "${detectedSerialNumber}" does not match this order's serial number on file (${selectedOrder.serial_number})`;
      serialMismatchFired = true;
    }
  }
  // photoNotApplicable ("Item never arrived") — never use photo-derived
  // evidence for the mismatch check, even if a photo happens to be sitting
  // in the canvas from a previous reason; there's genuinely no photo for
  // this claim, so nothing photo-derived should count against it.
  if (mismatchEvidence) {
    // serial check already won — fall through, skip the rest of the chain
  } else if (!photoNotApplicable && photoDetectedBrand && photoDetectedBrand !== orderBrand) {
    mismatchEvidence = `Photo shows "${photoDetectedBrand.toUpperCase()}" branding but the order is ${selectedOrder.brand} (${selectedOrder.product})`;
  } else if (invoiceOCRData.brand && invoiceOCRData.brand !== orderBrand) {
    mismatchEvidence = `Attached invoice is for a ${invoiceOCRData.brand.toUpperCase()} product but the order is ${selectedOrder.brand} (${selectedOrder.product})`;
  } else if (declaredBrand && declaredBrand !== orderBrand) {
    mismatchEvidence = `Customer states they are returning a ${declaredBrand.toUpperCase()} item but the order is ${selectedOrder.brand} (${selectedOrder.product})`;
  } else if (!photoNotApplicable && photoCategoryMismatch) {
    mismatchEvidence = photoClassifiedLabel
      ? `Photo appears to show a "${photoClassifiedLabel}", which doesn't match the expected ${selectedOrder.category} item (${selectedOrder.product})`
      : `Photo does not appear to match the expected ${selectedOrder.category} item (${selectedOrder.product})`;
  }

  // Invoice cross-checks (any retailer)
  const invoiceFlags = [];
  if (invoiceAttached && invoiceOCRData.total !== null) {
    const diffPct = Math.abs(invoiceOCRData.total - value) / Math.max(value, 0.01);
    if (diffPct > 0.15) {
      invoiceFlags.push(`Invoice total (${fmtMoney2(invoiceOCRData.total)}) differs from order record (${fmtMoney2(value)}) by ${(diffPct * 100).toFixed(0)}%`);
    }
  }
  if (invoiceAttached && invoiceOCRData.retailer) {
    invoiceFlags.push(`Invoice issued by ${invoiceOCRData.retailer.toUpperCase()} — third-party receipt attached to this claim (verify purchase channel)`);
  }

  // ---- Agents 1 & 2 as before ----
  let pScore = 0; const pFlags = [];
  const isHighValueCat = HIGH_VALUE.has(selectedOrder.category);
  if (isHighValueCat && value > 300) { pScore += 15; pFlags.push(`High-value item return (${fmtMoney2(value)}, ${selectedOrder.category})`); }
  if (days <= 1 && reason === 'Item never arrived') { pScore += 15; pFlags.push('Non-arrival claimed unusually fast after delivery scan'); }
  if (days > 30) { pScore += 10; pFlags.push(`Return requested ${days} days after delivery — outside typical window`); }
  const nlp = analyzeConversationIntent(portalChatLog);
  // img was already computed above (before the backend attempt) — reusing it
  // here avoids calling analyzePortalPhoto() twice, which would double-count
  // this photo's hash in seenImageHashes and falsely flag it as a duplicate
  // on the customer's next submission.
  if (exceedsReturnRate) {
    if (promptExchange) {
      pFlags.push(`Return frequency ${(returnRate * 100).toFixed(0)}% (${projectedReturnsFiled}/${TOTAL_CUSTOMER_ORDERS} orders) would normally exceed the ${(FRAUD_RULES.returnRateThreshold * 100).toFixed(0)}% threshold, but this is a prompt size exchange (returned within ${FRAUD_RULES.lateReturnDays} days) — not counted against the account`);
    } else {
      pScore += 30;
      pFlags.push(`Return frequency ${(returnRate * 100).toFixed(0)}% (${projectedReturnsFiled}/${TOTAL_CUSTOMER_ORDERS} orders) exceeds the ${(FRAUD_RULES.returnRateThreshold * 100).toFixed(0)}% threshold for this account`);
    }
  }
  if (isRepeatLowValueAbuse && !promptExchange) {
    pScore += 20;
    pFlags.push(`Repeat low-value return pattern — the ${ordinal(projectedLowValueReturns)} return under ${fmtMoney2(FRAUD_RULES.lowValueThreshold)} from this account`);
  }
  if (staleReturn) {
    pScore += 35;
    pFlags.push(`Return initiated ${days} days after delivery — beyond the ${FRAUD_RULES.lateReturnDays}-day prompt-return window; recommend full multi-agent investigation (pattern, chat, photo, ML, and decision review)`);
  }
  if (portalChatRejected) {
    pScore += 25;
    pFlags.push('Support chat flagged this conversation as suspicious during intake');
  }

  // ---- Blend, with product mismatch as a decisive override ----
  let prob = 0.03;
  prob += (pScore / 100) * 0.35;
  prob += ((100 - nlp.trust) / 100) * 0.25;
  prob += ((100 - img.score) / 100) * 0.15;
  prob += invoiceFlags.length * 0.05;
  if (days <= 1) prob += 0.06;
  if (reason === 'Item never arrived') prob += 0.08;
  if (mismatchEvidence) prob = Math.max(prob, 0.92);   // wrong product = near-certain fraud/abuse
  if ((exceedsReturnRate || isRepeatLowValueAbuse) && !promptExchange) prob = Math.max(prob, 0.42);
  if (staleReturn) prob = Math.max(prob, 0.55);        // held too long before returning — thorough review, not an outright reject
  if (portalChatRejected) prob = Math.max(prob, 0.90);
  prob = Math.min(0.98, Math.max(0.01, prob));

  const allFlags = [];
  if (serialMismatchFired) allFlags.push(`SERIAL MISMATCH: ${mismatchEvidence}`);
  else if (mismatchEvidence) allFlags.push(`PRODUCT MISMATCH: ${mismatchEvidence}`);
  if (serialInconclusive) allFlags.push('Serial number photo provided but not clearly readable — verified manually');
  allFlags.push(...pFlags, ...nlp.flags, ...img.flags, ...invoiceFlags);

  let riskTier, recommendation;
  if (serialMismatchFired) {
    riskTier = 'HIGH';
    recommendation = 'Reject return — photographed serial number does not match the order on file. Possible swapped or counterfeit item; escalate to fraud investigation team.';
  } else if (mismatchEvidence) {
    riskTier = 'HIGH';
    recommendation = 'Reject return — returned item does not match the ordered product. Flag account for wrong-item-return abuse pattern.';
  } else if (portalChatRejected) {
    riskTier = 'HIGH';
    recommendation = 'Reject return — support chat flagged suspicious activity during intake. Escalate to fraud review team.';
  } else if (prob >= 0.75) { riskTier = 'HIGH'; recommendation = 'Reject return. Escalate to fraud investigation team.'; }
  else if (prob >= 0.40) {
    riskTier = 'MEDIUM';
    recommendation = staleReturn
      ? `Hold for thorough investigation — item was held ${days} days before being returned, beyond the expected prompt-return window. Review pattern, chat/NLP, photo, and ML signals together before deciding.`
      : 'Hold for manual review before approving or rejecting.';
  }
  else { riskTier = 'LOW'; recommendation = 'Approve return through standard automated processing.'; }

  // Inconclusive OCR isn't proof of anything — just floor at MEDIUM for a
  // human to check, same "can't confirm, can't silently approve" philosophy
  // as this pipeline's other zero-evidence handling. Never lowers a tier
  // something else already forced to HIGH.
  if (serialInconclusive && riskTier === 'LOW') {
    riskTier = 'MEDIUM';
    recommendation = 'Hold for manual review — could not clearly verify the serial number from the submitted photo.';
  }

  // Every submitted return counts toward this account's tracked frequency,
  // regardless of outcome — matches how return_frequency is computed
  // server-side in backend/main.py (a count of returns filed, not approved).
  recordCustomerReturn(customerId, { isLowValue: isLowValueOrder });

  // Capture the actual images (not just metadata) so analysts in the Company
  // Dashboard can see exactly what the customer submitted. JPEG re-encode
  // keeps a full-resolution camera capture from bloating memory across the
  // 200-case rolling queue. PDF invoices have no canvas to capture from —
  // renderDetail() falls back to a plain "PDF attached" note for those.
  const photoDataUrl = (img.provided && pCanvas.width) ? pCanvas.toDataURL('image/jpeg', 0.72) : null;
  const invoiceDataUrl = (invoiceAttached && pInvCanvas.width) ? pInvCanvas.toDataURL('image/jpeg', 0.72) : null;

  portalCounter += 1;
  const caseId = `RET-CUST-${String(portalCounter).padStart(4, '0')}`;
  const newCase = {
    return_id: caseId,
    customer_id: customerId,
    order_id: selectedOrder.order_id,
    category: selectedOrder.category,
    purchase_value: value,
    reason,
    product_ordered: selectedOrder.product,
    item_declared: itemReturned || '(not stated)',
    photo_data_url: photoDataUrl,
    invoice_attached: invoiceAttached,
    invoice_data_url: invoiceDataUrl,
    invoice_ocr: invoiceOCRData.raw ? {
      retailer: invoiceOCRData.retailer, total: invoiceOCRData.total, brand: invoiceOCRData.brand,
    } : null,
    ground_truth_is_fraud: null,
    suspicious_pattern_score: Math.min(mismatchEvidence ? pScore + 40 : pScore, 100),
    customer_trust_score: nlp.trust,
    image_authenticity_score: mismatchEvidence ? Math.min(img.score, 25) : img.score,
    fraud_probability_pct: Math.round(prob * 1000) / 10,
    risk_tier: riskTier,
    reasons: allFlags.length ? allFlags : ['No significant risk indicators detected at intake.'],
    top_model_drivers: shapImportance.slice(0, 5).map(s => `${s.feature} (impact: ${s.importance})`),
    recommendation,
    warehouse_review_note: (img.score < 50 && pScore < 30 && !mismatchEvidence)
      ? 'Item/photo inconsistency without matching customer-side risk signals — recommend checking warehouse handling/fulfillment logs for this SKU as a routine review step.' : null,
    chat_transcript: chatTranscript,
    timestamp: new Date().toISOString(),
    source: 'customer',
  };
  cases.unshift(newCase);
  cases = cases.slice(0, 200);
  renderKPIs();
  renderQueue(true);
  logAudit('case', `${caseId} submitted — ${riskTier} risk (${selectedOrder.product}, ${fmtMoney2(value)})`, customerNameAndId(customerId));

  // ---- Customer-facing response ----
  // Rejections (mismatch / chat-flagged / score-accumulated HIGH) now show a
  // categorized reasons list — image match, reason/description, invoice/cost,
  // return frequency — via buildCustomerRejectionReasons(). Deliberately
  // categorical rather than exact scores/thresholds: enough for the customer
  // to understand the decision without handing a bad actor a precise dial to
  // tune around. A pending MEDIUM review isn't a final decision, so it still
  // gets no reasons — there's nothing final to explain yet.
  function buildCustomerRejectionReasons() {
    const reasons = [];
    if (serialMismatchFired) {
      reasons.push("The serial number on the item you photographed doesn't match the serial number associated with this order.");
    } else if (mismatchEvidence) {
      reasons.push("The photo and/or invoice provided doesn't match the item that was ordered.");
    } else if (img.flags.length) {
      reasons.push("The photo provided didn't clearly verify the item's condition (blurry, too dark, or matched a previous submission).");
    }
    if (portalChatRejected || nlp.flags.length) {
      reasons.push("The reason and details provided about this return didn't hold up under review.");
    }
    if (invoiceFlags.length) {
      reasons.push("The order value didn't match the receipt/invoice provided.");
    }
    if (exceedsReturnRate) {
      reasons.push('This account has returned an unusually high share of its recent orders.');
    }
    if (isRepeatLowValueAbuse) {
      reasons.push('This account has a repeated pattern of low-value item returns.');
    }
    if (!reasons.length) reasons.push("Multiple factors in this request didn't meet our automatic approval criteria.");
    return reasons;
  }

  function rejectionReasonsHTML() {
    const reasons = buildCustomerRejectionReasons();
    return `
      <div style="margin-top:14px; text-align:left;">
        <div style="font-size:11px; color:var(--white-faint); text-transform:uppercase; letter-spacing:0.5px; margin-bottom:6px;">Why this was declined</div>
        <ul style="list-style:none;">
          ${reasons.map(r => `<li style="font-size:13px; color:var(--white-dim); padding:5px 0 5px 18px; position:relative;"><span style="position:absolute; left:0; color:var(--risk-high);">•</span>${r}</li>`).join('')}
        </ul>
      </div>`;
  }

  const statusEl = document.getElementById('portal-status');
  const formCard = document.getElementById('portal-form-card');
  if (mismatchEvidence) {
    statusEl.innerHTML = `
      <div class="status-icon" style="color:var(--risk-high);">${ICONS.error}</div>
      <h3>We can't accept this return</h3>
      <p>The item in this return doesn't match your original order — <b>${selectedOrder.product}</b> (${selectedOrder.order_id}). Only the item that was purchased on the order can be returned for a refund.</p>
      ${rejectionReasonsHTML()}
      <p style="margin-top:8px;">If you believe this is a mistake, please contact support and our team will take a look.</p>
      <div class="case-ref">Reference: ${caseId}</div>`;
  } else if (riskTier === 'HIGH') {
    statusEl.innerHTML = `
      <div class="status-icon" style="color:var(--risk-high);">${ICONS.error}</div>
      <h3>We're unable to approve this return</h3>
      <p>After reviewing your submission for <b>${selectedOrder.product}</b>, we're not able to process this return automatically.</p>
      ${rejectionReasonsHTML()}
      <p style="margin-top:8px;">If you believe this is a mistake, please contact support and our team will take another look.</p>
      <div class="case-ref">Reference: ${caseId}</div>`;
  } else if (riskTier === 'LOW' && isHighValueOrder) {
    statusEl.innerHTML = `
      <div class="status-icon" style="color:var(--risk-low);">${ICONS.success}</div>
      <h3>Your return is accepted</h3>
      <p>Because <b>${selectedOrder.product}</b> (<b>${fmtMoney2(value)}</b>) is a high-value item, please return it to your nearest warehouse or drop-off location instead of shipping it — we've emailed you the nearest location. Your refund of <b>${fmtMoney2(value)}</b> will be issued once it's received and inspected.</p>
      <div class="case-ref">Reference: ${caseId}</div>`;
  } else if (riskTier === 'LOW' && isLeniedLowValue) {
    statusEl.innerHTML = `
      <div class="status-icon" style="color:var(--risk-low);">${ICONS.success}</div>
      <h3>Your return is approved — keep the item</h3>
      <p>Since <b>${selectedOrder.product}</b> is under <b>${fmtMoney2(FRAUD_RULES.lowValueThreshold)}</b>, there's no need to send it back. Your refund of <b>${fmtMoney2(value)}</b> has been issued.</p>
      <div class="case-ref">Reference: ${caseId}</div>`;
  } else if (riskTier === 'LOW') {
    statusEl.innerHTML = `
      <div class="status-icon" style="color:var(--risk-low);">${ICONS.success}</div>
      <h3>Your return is approved</h3>
      <p>We've emailed your prepaid shipping label for <b>${selectedOrder.product}</b>. Drop the package at any carrier location within 14 days and your refund of <b>${fmtMoney2(value)}</b> will be issued once it's scanned.</p>
      <div class="case-ref">Reference: ${caseId}</div>`;
  } else {
    statusEl.innerHTML = `
      <div class="status-icon" style="color:var(--risk-med);">${ICONS.pending}</div>
      <h3>We're reviewing your request</h3>
      <p>Thanks — we've received your return request for <b>${selectedOrder.product}</b> (<b>${fmtMoney2(value)}</b>). Our team is taking a closer look and you'll hear back within 24 hours. No action is needed from you right now.</p>
      <div class="case-ref">Reference: ${caseId}</div>`;
  }
  statusEl.classList.add('show');
  formCard.style.display = 'none';
  stopPortalStream();
  stopInvStream();
  stopSerialStream();
  appendSubmitAnotherButton(statusEl, formCard);
});

// ---------------- Init ----------------
renderKPIs();
renderQueue(false);
renderModelTable();
renderShap();
renderImpact();
seedPortalChat();
initBackend();

// ---------------- PWA: installable + basic offline app-shell ----------------
// Registered last and best-effort — a failure here (unsupported browser,
// blocked by an extension, file:// context) shouldn't affect anything else;
// the dashboard works identically with or without it, this only adds
// "Add to Home Screen" install support and an offline-open fallback.
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((err) => {
      console.warn('Service worker registration failed (PWA install/offline support unavailable):', err);
    });
  });
}
