const DATA = JSON.parse(document.getElementById('data-bundle').textContent);
let cases = DATA.cases.slice();
const modelComparison = DATA.model_comparison;
const shapImportance = DATA.shap_importance;
const businessImpact = DATA.business_impact;

const fmtMoney = (n) => '$' + Number(n).toLocaleString(undefined, {maximumFractionDigits: 0});
const fmtMoney2 = (n) => '$' + Number(n).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});
const riskColor = {HIGH: 'var(--risk-high)', MEDIUM: 'var(--risk-med)', LOW: 'var(--risk-low)'};

let selectedId = null;

// ---------------- KPI + queue rendering ----------------
function renderKPIs() {
  const total = cases.length;
  const high = cases.filter(c => c.risk_tier === 'HIGH').length;
  const med = cases.filter(c => c.risk_tier === 'MEDIUM').length;
  const avg = total ? (cases.reduce((s, c) => s + c.fraud_probability_pct, 0) / total) : 0;
  const valueAtRisk = cases.filter(c => c.risk_tier !== 'LOW').reduce((s, c) => s + c.purchase_value, 0);

  document.getElementById('kpi-total').textContent = total;
  document.getElementById('kpi-high').textContent = high;
  document.getElementById('kpi-high-sub').textContent = `+ ${med} medium risk`;
  document.getElementById('kpi-avg').textContent = avg.toFixed(1) + '%';
  document.getElementById('kpi-value').textContent = fmtMoney(valueAtRisk);

  const best = modelComparison.best_model;
  document.getElementById('kpi-model').textContent = best;
  document.getElementById('kpi-model-sub').textContent = `F1 = ${modelComparison.results[best].f1}`;
  if (typeof refreshXrayCaseSelect === 'function') refreshXrayCaseSelect();
}

function caseRowHTML(c, isNew) {
  return `<div class="case-row ${c.return_id === selectedId ? 'selected' : ''} ${isNew ? 'new-case' : ''}" data-id="${c.return_id}">
    <span class="risk-chip ${c.risk_tier}">${c.risk_tier}</span>
    <div class="case-main">
      <div class="rid">${c.return_id} · ${c.category}${c.source === 'customer' ? '<span class="source-tag">CUSTOMER</span>' : ''}</div>
      <div class="meta"><b>${c.reason}</b></div>
    </div>
    <div class="case-prob" style="color:${riskColor[c.risk_tier]}">${c.fraud_probability_pct}%</div>
    <div class="case-value">${fmtMoney(c.purchase_value)}</div>
  </div>`;
}

// ---------------- Queue filters (company) ----------------
const queueFilter = { text: '', tier: 'ALL', customerOnly: false };

function caseMatchesFilter(c) {
  if (queueFilter.tier !== 'ALL' && c.risk_tier !== queueFilter.tier) return false;
  if (queueFilter.customerOnly && c.source !== 'customer') return false;
  if (queueFilter.text) {
    const hay = [
      c.return_id, c.customer_id, c.order_id, c.category, c.reason,
      c.product_ordered || '', c.item_declared || '', c.chat_transcript || '',
      (c.reasons || []).join(' '),
    ].join(' ').toLowerCase();
    if (!hay.includes(queueFilter.text)) return false;
  }
  return true;
}

function renderQueue(newestIsNew) {
  const list = document.getElementById('case-list');
  const filtered = cases.filter(caseMatchesFilter);
  document.getElementById('queue-count').textContent =
    (queueFilter.text || queueFilter.tier !== 'ALL' || queueFilter.customerOnly)
      ? `${filtered.length} of ${cases.length} cases`
      : `${cases.length} cases`;
  if (!filtered.length) {
    list.innerHTML = '<div class="no-results">No cases match these filters. Try clearing the search or choosing "All".</div>';
    return;
  }
  list.innerHTML = filtered.map((c, i) => caseRowHTML(c, newestIsNew && i === 0 && c === cases[0])).join('');
  list.querySelectorAll('.case-row').forEach(row => {
    row.addEventListener('click', () => {
      selectedId = row.dataset.id;
      renderQueue(false);
      renderDetail();
    });
  });
}

// Wire up the queue toolbar
document.getElementById('queue-search').addEventListener('input', (e) => {
  queueFilter.text = e.target.value.trim().toLowerCase();
  renderQueue(false);
});
document.querySelectorAll('.filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    if (chip.dataset.source === 'customer') {
      queueFilter.customerOnly = !queueFilter.customerOnly;
      chip.classList.toggle('active', queueFilter.customerOnly);
    } else {
      queueFilter.tier = chip.dataset.tier;
      document.querySelectorAll('.filter-chip[data-tier]').forEach(c =>
        c.classList.toggle('active', c.dataset.tier === queueFilter.tier));
    }
    renderQueue(false);
  });
});

function scoreColor(score, inverted) {
  const v = inverted ? 100 - score : score;
  if (v >= 65) return 'var(--risk-high)';
  if (v >= 35) return 'var(--risk-med)';
  return 'var(--risk-low)';
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
        <div class="rid" style="font-family:'JetBrains Mono',monospace; color:var(--white-faint); font-size:12px;">${c.return_id} · ${c.customer_id}</div>
        <div style="font-size:15px; margin-top:4px; font-weight:600;">${c.category} · ${fmtMoney2(c.purchase_value)}</div>
        <div style="font-size:12.5px; color:var(--white-faint); margin-top:2px;">Reason: ${c.reason}</div>
        ${c.product_ordered ? `<div style="font-size:12px; color:var(--white-dim); margin-top:6px;">Ordered: <b>${c.product_ordered}</b> · Customer returning: <b>${c.item_declared}</b></div>` : ''}
        ${c.invoice_attached ? `<div style="font-size:11.5px; color:var(--blue-cyan); margin-top:4px; font-family:'JetBrains Mono',monospace;">📎 Invoice attached${c.invoice_ocr ? ` — ${c.invoice_ocr.retailer ? c.invoice_ocr.retailer.toUpperCase() + ' · ' : ''}${c.invoice_ocr.total !== null && c.invoice_ocr.total !== undefined ? 'total ' + fmtMoney2(c.invoice_ocr.total) : 'no total read'}` : ''}</div>` : ''}
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
      <span>${c.risk_tier === 'HIGH' ? '⛔' : c.risk_tier === 'MEDIUM' ? '⚠️' : '✅'}</span>
      <span><b>Agent 5 · Decision:</b> ${c.recommendation}</span>
    </div>

    ${c.warehouse_review_note ? `<div class="warehouse-note">🏬 <b>Routine fulfillment check suggested:</b> ${c.warehouse_review_note}</div>` : ''}

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
}

// ---------------- Analyst comments (review workflow) ----------------
// In-memory store for the standalone dashboard. When the FastAPI backend is
// running, these map 1:1 to POST/GET /api/case/{id}/comments.
const commentStore = {};

function renderComments(returnId) {
  const list = document.getElementById('comments-list');
  if (!list) return;
  const comments = commentStore[returnId] || [];
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

function submitComment(returnId) {
  const text = document.getElementById('comment-text').value.trim();
  const author = document.getElementById('comment-author').value.trim() || 'Analyst';
  const action = document.getElementById('comment-action').value;
  if (!text) return;
  (commentStore[returnId] = commentStore[returnId] || []).push({
    author, text, action, timestamp: new Date().toISOString(),
  });
  document.getElementById('comment-text').value = '';
  renderComments(returnId);

  // Sync analyst decisions back to the customer's "My returns" tracker
  const mine = myReturns.find(r => r.reference === returnId);
  if (mine) {
    if (action === 'approve') mine.status = 'approved';
    if (action === 'reject') mine.status = 'declined';
    renderMyReturns();
  }
}

// ---------------- Customer "My returns" tracker ----------------
// Filterable list of everything this customer has submitted, with live status.
// Statuses update when the company approves/rejects via the comments workflow.
const myReturns = [];
let myReturnsFilterText = '';

const STATUS_LABEL = {
  approved: { text: 'APPROVED', cls: 'approved' },
  review: { text: 'UNDER REVIEW', cls: 'review' },
  declined: { text: 'NOT ACCEPTED', cls: 'declined' },
};

function renderMyReturns() {
  const card = document.getElementById('my-returns-card');
  const list = document.getElementById('my-returns-list');
  if (!card || !list) return;
  if (!myReturns.length) { card.style.display = 'none'; return; }
  card.style.display = '';
  const q = myReturnsFilterText;
  const filtered = myReturns.filter(r => {
    if (!q) return true;
    return [r.reference, r.product, r.reason, STATUS_LABEL[r.status].text]
      .join(' ').toLowerCase().includes(q);
  });
  if (!filtered.length) {
    list.innerHTML = '<div class="no-results">No returns match that search.</div>';
    return;
  }
  list.innerHTML = filtered.map(r => `
    <div class="my-returns-item">
      <div>
        <div style="font-weight:600;">${r.product}</div>
        <div class="ref">${r.reference} · ${r.reason} · ${new Date(r.date).toLocaleDateString()}</div>
      </div>
      <div style="font-family:'JetBrains Mono',monospace; font-size:12.5px;">${fmtMoney2(r.value)}</div>
      <span class="status-pill ${STATUS_LABEL[r.status].cls}">${STATUS_LABEL[r.status].text}</span>
    </div>`).join('');
}

const myReturnsSearchEl = document.getElementById('my-returns-search');
if (myReturnsSearchEl) {
  myReturnsSearchEl.addEventListener('input', (e) => {
    myReturnsFilterText = e.target.value.trim().toLowerCase();
    renderMyReturns();
  });
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

document.getElementById('reset-btn').addEventListener('click', () => {
  cases = DATA.cases.slice();
  selectedId = null;
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

document.getElementById('analyze-transcript-btn').addEventListener('click', () => {
  const transcript = document.getElementById('transcript-input').value;
  const excuseCount = parseInt(document.getElementById('excuse-count').value) || 0;
  if (!transcript.trim()) return;

  let trust = 100; const flags = [];
  const lower = transcript.toLowerCase();

  if (NON_ARRIVAL_RE.test(transcript) && DELIVERED_RE.test(transcript)) {
    trust -= 35; flags.push('Contradiction detected: claims non-arrival while tracking shows delivered');
  }
  const abusiveHits = ABUSIVE_RE.filter(r => r.test(transcript)).length;
  if (abusiveHits) { trust -= 10 * abusiveHits; flags.push(`Abusive/hostile language detected (${abusiveHits} instance(s))`); }
  const manipHits = MANIP_RE.filter(r => r.test(transcript)).length;
  if (manipHits) { trust -= 8 * manipHits; flags.push(`Emotional-manipulation / urgency-pressure language detected (${manipHits} instance(s))`); }
  if (COPY_PASTE_TEMPLATES.some(t => lower.includes(t))) {
    trust -= 15; flags.push('Copy-paste excuse template matched across prior tickets');
  }
  if (excuseCount >= 5) { trust -= 15; flags.push(`Same excuse pattern reused ${excuseCount} times historically`); }

  trust = Math.max(0, Math.min(100, trust));
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

// ---------------- Demo authentication ----------------
// Prototype auth: two demo accounts, session held in memory (reload = logout).
// In production this is replaced by real identity (OAuth/SSO + roles).
const DEMO_USERS = {
  'customer@demo.com': { password: 'customer123', role: 'customer', name: 'Alex Morgan' },
  'admin@returnshield.ai': { password: 'admin123', role: 'company', name: 'Ops Admin' },
};
let currentUser = null;

// Demo customer's order history (what they actually bought)
const CUSTOMER_ORDERS = [
  { order_id: 'ORD-1001', product: 'Nike Air Max 90 Sneakers', brand: 'Nike', category: 'Shoes', value: 129.99, days_ago: 4, icon: '👟' },
  { order_id: 'ORD-1002', product: 'Apple AirPods Pro 2', brand: 'Apple', category: 'Electronics', value: 249.00, days_ago: 7, icon: '🎧' },
  { order_id: 'ORD-1003', product: 'Samsung Galaxy Watch 6', brand: 'Samsung', category: 'Electronics', value: 299.99, days_ago: 12, icon: '⌚' },
  { order_id: 'ORD-1004', product: "Levi's 501 Original Jeans", brand: 'Levis', category: 'Apparel', value: 89.50, days_ago: 3, icon: '👖' },
  { order_id: 'ORD-1005', product: 'Adidas Ultraboost Light', brand: 'Adidas', category: 'Shoes', value: 189.99, days_ago: 20, icon: '👟' },
];
let selectedOrder = null;

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
  document.body.classList.toggle('role-customer', currentUser.role === 'customer');
  document.getElementById('user-chip').innerHTML =
    `<div class="comment-avatar">${currentUser.name.slice(0, 2).toUpperCase()}</div><span>${currentUser.name} · ${currentUser.role}</span>`;
  if (currentUser.role === 'customer') {
    document.getElementById('view-switch-wrap').style.display = 'none';
    setView('customer');
    renderOrderPicker();
    renderMyReturns();
  } else {
    document.getElementById('view-switch-wrap').style.display = '';
    setView('company');
  }
}
document.getElementById('login-btn').addEventListener('click', doLogin);
document.getElementById('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.querySelectorAll('.fill-link').forEach(link => {
  link.addEventListener('click', () => {
    if (link.dataset.fill === 'customer') {
      document.getElementById('login-email').value = 'customer@demo.com';
      document.getElementById('login-password').value = 'customer123';
    } else {
      document.getElementById('login-email').value = 'admin@returnshield.ai';
      document.getElementById('login-password').value = 'admin123';
    }
  });
});
document.getElementById('logout-btn').addEventListener('click', () => {
  currentUser = null;
  document.body.classList.remove('authed', 'role-customer', 'customer-mode');
  document.getElementById('login-password').value = '';
  stopStream(); stopPortalStream(); stopInvStream();
});

// ---------------- Order picker (customer account history) ----------------
function renderOrderPicker() {
  const el = document.getElementById('order-picker');
  el.innerHTML = CUSTOMER_ORDERS.map(o => `
    <div class="order-select-card ${selectedOrder && selectedOrder.order_id === o.order_id ? 'selected' : ''}" data-oid="${o.order_id}">
      <div class="thumb">${o.icon}</div>
      <div class="info">
        <div class="pname">${o.product}</div>
        <div class="pmeta">${o.order_id} · ${o.category} · delivered ${o.days_ago} day${o.days_ago === 1 ? '' : 's'} ago</div>
      </div>
      <div class="price">${fmtMoney2(o.value)}</div>
    </div>`).join('');
  el.querySelectorAll('.order-select-card').forEach(card => {
    card.addEventListener('click', () => {
      selectedOrder = CUSTOMER_ORDERS.find(o => o.order_id === card.dataset.oid);
      renderOrderPicker();
    });
  });
}

// ---------------- View switcher: Customer Portal vs Company Dashboard ----------------
const tabCustomer = document.getElementById('tab-customer');
const tabCompany = document.getElementById('tab-company');

function setView(mode) {
  // HARD role guard: a customer session can never open the company view.
  if (currentUser && currentUser.role === 'customer') mode = 'customer';
  document.body.classList.toggle('customer-mode', mode === 'customer');
  tabCustomer.classList.toggle('active', mode === 'customer');
  tabCompany.classList.toggle('active', mode === 'company');
  document.getElementById('simulate-btn').style.display = mode === 'customer' ? 'none' : '';
  document.getElementById('reset-btn').style.display = mode === 'customer' ? 'none' : '';
  document.getElementById('live-pill').style.display = mode === 'customer' ? 'none' : '';
  if (mode === 'customer') stopStream();
  if (mode === 'company') { stopPortalStream(); stopInvStream(); }
}
tabCustomer.addEventListener('click', () => setView('customer'));
tabCompany.addEventListener('click', () => setView('company'));

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

// ---------------- Customer portal: submission through the full pipeline ----------------
function analyzePortalPhoto() {
  // Runs the same real image checks (duplicate hash, brightness, sharpness)
  if (!portalPhotoTaken || !pCanvas.width) return { score: 100, flags: [], provided: false };
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

function analyzePortalText(text, reason) {
  // Runs the same NLP trust rules on the customer's own description
  let trust = 100; const flags = [];
  if (!text.trim()) return { trust, flags };
  if (NON_ARRIVAL_RE.test(text) && DELIVERED_RE.test(text)) {
    trust -= 35; flags.push('Contradiction in customer description: claims non-arrival while referencing delivered tracking');
  }
  const abusiveHits = ABUSIVE_RE.filter(r => r.test(text)).length;
  if (abusiveHits) { trust -= 10 * abusiveHits; flags.push(`Hostile language in customer description (${abusiveHits} instance(s))`); }
  const manipHits = MANIP_RE.filter(r => r.test(text)).length;
  if (manipHits) { trust -= 8 * manipHits; flags.push(`Urgency-pressure language in customer description (${manipHits} instance(s))`); }
  if (COPY_PASTE_TEMPLATES.some(t => text.toLowerCase().includes(t))) {
    trust -= 15; flags.push('Customer description matches a known copy-paste excuse template');
  }
  return { trust: Math.max(0, Math.min(100, trust)), flags };
}

let portalCounter = 0;

document.getElementById('p-submit-btn').addEventListener('click', () => {
  const matchResultEl = document.getElementById('p-match-result');
  matchResultEl.className = 'match-result';

  if (!selectedOrder) {
    matchResultEl.classList.add('show', 'bad');
    matchResultEl.textContent = 'Please select which order you are returning (step 1).';
    return;
  }
  const reason = document.getElementById('p-reason').value;
  const itemReturned = document.getElementById('p-item-returned').value.trim();
  const description = document.getElementById('p-description').value;
  const value = selectedOrder.value;
  const days = selectedOrder.days_ago;
  const orderBrand = selectedOrder.brand.toLowerCase().replace("levi's", 'levis');

  // ============ PRODUCT MATCH VERIFICATION (Agent 3 upgrade) ============
  // Three evidence sources, strongest wins:
  //   1. Brand text OCR'd from the item photo
  //   2. Brand on the attached invoice
  //   3. Brand in the customer's own declaration
  let mismatchEvidence = null;
  const declaredBrand = detectBrand(itemReturned);
  if (photoDetectedBrand && photoDetectedBrand !== orderBrand) {
    mismatchEvidence = `Photo shows "${photoDetectedBrand.toUpperCase()}" branding but the order is ${selectedOrder.brand} (${selectedOrder.product})`;
  } else if (invoiceOCRData.brand && invoiceOCRData.brand !== orderBrand) {
    mismatchEvidence = `Attached invoice is for a ${invoiceOCRData.brand.toUpperCase()} product but the order is ${selectedOrder.brand} (${selectedOrder.product})`;
  } else if (declaredBrand && declaredBrand !== orderBrand) {
    mismatchEvidence = `Customer states they are returning a ${declaredBrand.toUpperCase()} item but the order is ${selectedOrder.brand} (${selectedOrder.product})`;
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
  const nlp = analyzePortalText(description, reason);
  const img = analyzePortalPhoto();
  if (!img.provided && (reason === 'Item arrived damaged' || reason === 'Defective / stopped working')) {
    pScore += 10; pFlags.push('Damage/defect claimed but no photo provided');
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
  prob = Math.min(0.98, Math.max(0.01, prob));

  const allFlags = [];
  if (mismatchEvidence) allFlags.push(`PRODUCT MISMATCH: ${mismatchEvidence}`);
  allFlags.push(...pFlags, ...nlp.flags, ...img.flags, ...invoiceFlags);

  let riskTier, recommendation;
  if (mismatchEvidence) {
    riskTier = 'HIGH';
    recommendation = 'Reject return — returned item does not match the ordered product. Flag account for wrong-item-return abuse pattern.';
  } else if (prob >= 0.75) { riskTier = 'HIGH'; recommendation = 'Reject return. Escalate to fraud investigation team.'; }
  else if (prob >= 0.40) { riskTier = 'MEDIUM'; recommendation = 'Hold for manual review before approving or rejecting.'; }
  else { riskTier = 'LOW'; recommendation = 'Approve return through standard automated processing.'; }

  portalCounter += 1;
  const caseId = `RET-CUST-${String(portalCounter).padStart(4, '0')}`;
  const newCase = {
    return_id: caseId,
    customer_id: currentUser ? currentUser.email : 'guest-customer',
    order_id: selectedOrder.order_id,
    category: selectedOrder.category,
    purchase_value: value,
    reason,
    product_ordered: selectedOrder.product,
    item_declared: itemReturned || '(not stated)',
    invoice_attached: invoiceAttached,
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
    chat_transcript: description ? `Customer (return form): ${description}` : '(no description provided)',
    timestamp: new Date().toISOString(),
    source: 'customer',
  };
  cases.unshift(newCase);
  cases = cases.slice(0, 200);
  renderKPIs();
  renderQueue(true);

  // Record in the customer's own tracker
  myReturns.unshift({
    reference: caseId,
    product: selectedOrder.product,
    reason,
    value,
    date: new Date().toISOString(),
    status: mismatchEvidence ? 'declined' : (riskTier === 'LOW' ? 'approved' : 'review'),
  });
  renderMyReturns();
  // A product mismatch gets a factual denial (safe to state: it's verifiable
  // and non-accusatory). Everything else keeps fraud detection invisible.
  const statusEl = document.getElementById('portal-status');
  const formCard = document.getElementById('portal-form-card');
  if (mismatchEvidence) {
    statusEl.innerHTML = `
      <div class="status-icon">❌</div>
      <h3>We can't accept this return</h3>
      <p>The item in this return doesn't match your original order — <b>${selectedOrder.product}</b> (${selectedOrder.order_id}). Only the item that was purchased on the order can be returned for a refund.</p>
      <p style="margin-top:8px;">If you believe this is a mistake, please contact support and our team will take a look.</p>
      <div class="case-ref">Reference: ${caseId}</div>`;
  } else if (riskTier === 'LOW') {
    statusEl.innerHTML = `
      <div class="status-icon">✅</div>
      <h3>Your return is approved</h3>
      <p>We've emailed your prepaid shipping label for <b>${selectedOrder.product}</b>. Drop the package at any carrier location within 14 days and your refund of <b>${fmtMoney2(value)}</b> will be issued once it's scanned.</p>
      <div class="case-ref">Reference: ${caseId}</div>`;
  } else {
    statusEl.innerHTML = `
      <div class="status-icon">🕐</div>
      <h3>We're reviewing your request</h3>
      <p>Thanks — we've received your return request for <b>${selectedOrder.product}</b> (<b>${fmtMoney2(value)}</b>). Our team is taking a closer look and you'll hear back within 24 hours. No action is needed from you right now.</p>
      <div class="case-ref">Reference: ${caseId}</div>`;
  }
  statusEl.classList.add('show');
  formCard.style.display = 'none';
  stopPortalStream();
  stopInvStream();

  // Offer to file another return
  const again = document.createElement('button');
  again.className = 'ghost';
  again.style.marginTop = '16px';
  again.textContent = 'Submit another return';
  again.addEventListener('click', () => {
    statusEl.classList.remove('show');
    formCard.style.display = '';
    document.getElementById('p-description').value = '';
    document.getElementById('p-item-returned').value = '';
    document.getElementById('p-match-result').className = 'match-result';
    portalPhotoTaken = false;
    photoDetectedBrand = null;
    invoiceAttached = false;
    invoiceOCRData = { retailer: null, total: null, brand: null, raw: null };
    pPhotoStatus.textContent = '';
    pInvStatus.textContent = '';
    document.getElementById('p-photo-ocr').textContent = '';
    document.getElementById('p-inv-ocr').textContent = '';
    pPhotoWrap.classList.remove('show');
    pInvWrap.classList.remove('show');
    selectedOrder = null;
    renderOrderPicker();
  });
  statusEl.appendChild(again);
});

// ---------------- Agent 7: Warehouse Intake — X-Ray & Weight Verification ----------------
// Catches item substitution: buy a $1000 shoe, return a $30 knockoff (or a
// brick). Real logic: measured weight/dims vs the product catalog. The X-ray
// view is a simulated scanner rendering for the prototype; in production it
// ingests real X-ray/CT imagery + scale telemetry from the intake line.

// Product catalog: shipping weight (grams) and boxed dimensions (cm)
const PRODUCT_CATALOG = {
  'Nike Air Max 90 Sneakers': { weight_g: 1150, dims: [35, 25, 13], shape: 'shoe' },
  'Apple AirPods Pro 2': { weight_g: 350, dims: [12, 10, 6], shape: 'small' },
  'Samsung Galaxy Watch 6': { weight_g: 420, dims: [14, 12, 9], shape: 'small' },
  "Levi's 501 Original Jeans": { weight_g: 750, dims: [30, 22, 6], shape: 'soft' },
  'Adidas Ultraboost Light': { weight_g: 1100, dims: [34, 24, 13], shape: 'shoe' },
};
const CATEGORY_WEIGHTS = {
  Shoes: 1100, Electronics: 550, Phones: 420, Laptops: 2600, Apparel: 650,
  'Home & Kitchen': 1400, Beauty: 320, Toys: 700, 'Sporting Goods': 1200, Jewelry: 180,
};

function expectedForCase(c) {
  if (c.product_ordered && PRODUCT_CATALOG[c.product_ordered]) {
    return { product: c.product_ordered, ...PRODUCT_CATALOG[c.product_ordered] };
  }
  const w = CATEGORY_WEIGHTS[c.category] || 800;
  return { product: `${c.category} item (catalog est.)`, weight_g: w, dims: [30, 22, 12], shape: c.category === 'Shoes' ? 'shoe' : 'small' };
}

let xrayCase = null;
let xrayLastResult = null;

function refreshXrayCaseSelect() {
  const sel = document.getElementById('xray-case-select');
  if (!sel) return;
  const current = sel.value;
  const options = cases.slice(0, 40).map(c =>
    `<option value="${c.return_id}">${c.return_id} · ${c.product_ordered || c.category} · ${fmtMoney(c.purchase_value)}${c.source === 'customer' ? ' · CUSTOMER' : ''}</option>`);
  sel.innerHTML = '<option value="">— select an arriving return —</option>' + options.join('');
  if (current) sel.value = current;
}

document.getElementById('xray-case-select').addEventListener('change', (e) => {
  xrayCase = cases.find(c => c.return_id === e.target.value) || null;
  const box = document.getElementById('xray-expected');
  document.getElementById('xray-apply-btn').style.display = 'none';
  document.getElementById('xray-result').innerHTML = '';
  if (!xrayCase) { box.style.display = 'none'; return; }
  const exp = expectedForCase(xrayCase);
  box.style.display = '';
  box.innerHTML = `
    <div class="exp-title">Expected from catalog</div>
    ${exp.product} — sold for <b>${fmtMoney2(xrayCase.purchase_value)}</b><br>
    Shipping weight: <b>${exp.weight_g} g</b> · Boxed dims: <b>${exp.dims.join('×')} cm</b>`;
  drawXray(null, exp, 0);
});

document.getElementById('xray-weight').addEventListener('input', () => {
  if (!xrayCase) return;
  const exp = expectedForCase(xrayCase);
  const measured = parseFloat(document.getElementById('xray-weight').value) || 0;
  if (measured <= 0) { document.getElementById('xray-deviation').style.display = 'none'; return; }
  const dev = Math.abs(measured - exp.weight_g) / exp.weight_g;
  document.getElementById('xray-deviation').style.display = '';
  document.getElementById('xray-dev-pct').textContent =
    `${measured < exp.weight_g ? '-' : '+'}${(dev * 100).toFixed(0)}% (${measured}g vs ${exp.weight_g}g)`;
  const bar = document.getElementById('xray-dev-bar');
  bar.style.width = Math.min(dev * 100, 100) + '%';
  bar.style.background = dev > 0.20 ? 'var(--risk-high)' : dev > 0.08 ? 'var(--risk-med)' : 'var(--risk-low)';
});

// ---- X-ray canvas rendering ----
function drawXray(measuredRatio, exp, progress) {
  const cv = document.getElementById('xray-canvas');
  const ctx = cv.getContext('2d');
  if (!ctx || !ctx.clearRect) return; // headless test stub
  const W = cv.width, H = cv.height;
  ctx.clearRect(0, 0, W, H);

  // grid
  ctx.strokeStyle = 'rgba(34,211,238,0.06)';
  ctx.lineWidth = 1;
  for (let x = 0; x < W; x += 32) { ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke(); }
  for (let y = 0; y < H; y += 32) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke(); }

  // package outline
  const bx = W * 0.18, by = H * 0.22, bw = W * 0.64, bh = H * 0.56;
  ctx.strokeStyle = 'rgba(34,211,238,0.55)';
  ctx.lineWidth = 2;
  ctx.setLineDash([]);
  ctx.strokeRect(bx, by, bw, bh);
  ctx.fillStyle = 'rgba(34,211,238,0.03)';
  ctx.fillRect(bx, by, bw, bh);

  // expected silhouette (dashed outline)
  ctx.setLineDash([6, 5]);
  ctx.strokeStyle = 'rgba(59,130,246,0.55)';
  drawSilhouette(ctx, bx + bw / 2, by + bh / 2, bw * 0.75, bh * 0.6, exp.shape, false);
  ctx.setLineDash([]);

  // detected contents (filled, scaled by weight ratio)
  if (measuredRatio !== null) {
    const scale = Math.max(0.12, Math.min(measuredRatio, 1.15));
    const density = measuredRatio < 0.5 ? 'rgba(255,84,112,0.35)' : measuredRatio < 0.85 ? 'rgba(255,180,84,0.35)' : 'rgba(61,220,151,0.30)';
    ctx.fillStyle = density;
    ctx.strokeStyle = measuredRatio < 0.5 ? 'rgba(255,84,112,0.9)' : measuredRatio < 0.85 ? 'rgba(255,180,84,0.9)' : 'rgba(61,220,151,0.9)';
    ctx.lineWidth = 2;
    const shape = measuredRatio < 0.6 ? 'small' : exp.shape;   // substituted items scan as smaller/denser blobs
    drawSilhouette(ctx, bx + bw / 2, by + bh / 2 + bh * (1 - scale) * 0.18, bw * 0.75 * scale, bh * 0.6 * scale, shape, true);
  }

  // scan line
  if (progress > 0 && progress < 1) {
    const y = by + bh * progress;
    const grad = ctx.createLinearGradient(0, y - 22, 0, y + 22);
    grad.addColorStop(0, 'rgba(34,211,238,0)');
    grad.addColorStop(0.5, 'rgba(34,211,238,0.35)');
    grad.addColorStop(1, 'rgba(34,211,238,0)');
    ctx.fillStyle = grad;
    ctx.fillRect(bx, y - 22, bw, 44);
    ctx.strokeStyle = 'rgba(34,211,238,0.95)';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(bx, y); ctx.lineTo(bx + bw, y); ctx.stroke();
  }
}

function drawSilhouette(ctx, cx, cy, w, h, shape, fill) {
  ctx.beginPath();
  if (shape === 'shoe') {
    // stylized sneaker profile
    ctx.moveTo(cx - w / 2, cy + h / 4);
    ctx.quadraticCurveTo(cx - w / 2, cy - h / 3, cx - w / 6, cy - h / 3);
    ctx.quadraticCurveTo(cx + w / 8, cy - h / 3, cx + w / 4, cy);
    ctx.quadraticCurveTo(cx + w / 2.1, cy + h / 8, cx + w / 2, cy + h / 4);
    ctx.lineTo(cx + w / 2, cy + h / 2.4);
    ctx.lineTo(cx - w / 2, cy + h / 2.4);
    ctx.closePath();
  } else if (shape === 'soft') {
    ctx.ellipse(cx, cy, w / 2, h / 2.4, 0, 0, Math.PI * 2);
  } else {
    const r = Math.min(w, h) * 0.12;
    ctx.roundRect ? ctx.roundRect(cx - w / 2, cy - h / 2, w, h, r) : ctx.rect(cx - w / 2, cy - h / 2, w, h);
  }
  if (fill) ctx.fill();
  ctx.stroke();
}

// ---- Run scan ----
document.getElementById('xray-scan-btn').addEventListener('click', () => {
  const resultEl = document.getElementById('xray-result');
  if (!xrayCase) {
    resultEl.innerHTML = '<div class="reasons-block"><ul><li>Select an arriving return first.</li></ul></div>';
    return;
  }
  const measured = parseFloat(document.getElementById('xray-weight').value) || 0;
  if (measured <= 0) {
    resultEl.innerHTML = '<div class="reasons-block"><ul><li>Enter the scale reading (measured weight in grams) before scanning.</li></ul></div>';
    return;
  }
  const exp = expectedForCase(xrayCase);
  const ratio = measured / exp.weight_g;
  const dev = Math.abs(1 - ratio);

  // dims check (optional)
  let dimFlag = null;
  const dimsRaw = document.getElementById('xray-dims').value.trim();
  if (dimsRaw) {
    const parts = dimsRaw.toLowerCase().split(/[x×,\s]+/).map(Number).filter(n => n > 0);
    if (parts.length === 3) {
      const expVol = exp.dims[0] * exp.dims[1] * exp.dims[2];
      const gotVol = parts[0] * parts[1] * parts[2];
      const vdev = Math.abs(gotVol - expVol) / expVol;
      if (vdev > 0.35) dimFlag = `Package volume ${gotVol.toFixed(0)}cm³ vs expected ${expVol.toFixed(0)}cm³ (${(vdev * 100).toFixed(0)}% off)`;
    }
  }

  // animate the scan
  const start = performance.now();
  const DURATION = 1600;
  function frame(now) {
    const p = Math.min((now - start) / DURATION, 1);
    drawXray(p < 1 ? null : ratio, exp, p);
    if (p < 1) { requestAnimationFrame(frame); return; }
    drawXray(ratio, exp, 0);
    finishScan();
  }
  requestAnimationFrame(frame);
  // headless/test fallback: complete synchronously if rAF never fires
  setTimeout(() => { if (!xrayLastResult || xrayLastResult.case_id !== xrayCase.return_id) { drawXray(ratio, exp, 0); finishScan(); } }, DURATION + 400);

  function finishScan() {
    document.getElementById('xr-density').textContent = `DENSITY: ${ratio < 0.5 ? 'LOW — inconsistent' : ratio < 0.85 ? 'PARTIAL' : 'NOMINAL'}`;
    document.getElementById('xr-mass').textContent = `EST. MASS: ${measured}g / ${exp.weight_g}g`;
    let verdict, cls, flags = [];
    if (dev > 0.20) {
      verdict = 'CONTENTS MISMATCH'; cls = 'SUSPECT';
      flags.push(`Package weighs ${measured}g but ${exp.product} ships at ${exp.weight_g}g (${measured < exp.weight_g ? '-' : '+'}${(dev * 100).toFixed(0)}%) — contents do not match the sold product (probable item substitution)`);
      if (ratio < 0.5) flags.push(`X-ray density profile shows a much smaller/denser object than a ${exp.shape === 'shoe' ? 'footwear' : 'catalog'} silhouette`);
    } else if (dev > 0.08) {
      verdict = 'PARTIAL MATCH'; cls = 'REVIEW';
      flags.push(`Weight is ${(dev * 100).toFixed(0)}% off catalog (${measured}g vs ${exp.weight_g}g) — possible missing accessories/parts; open-box inspection recommended`);
    } else {
      verdict = 'CONTENTS VERIFIED'; cls = 'VERIFIED';
      flags.push(`Weight within tolerance (${measured}g vs ${exp.weight_g}g) and density silhouette consistent with ${exp.product}`);
    }
    if (dimFlag) { flags.push(dimFlag); if (cls === 'VERIFIED') { cls = 'REVIEW'; verdict = 'PARTIAL MATCH'; } }
    document.getElementById('xr-match').textContent = `MATCH: ${verdict}`;

    xrayLastResult = { case_id: xrayCase.return_id, verdict, cls, flags, measured, expected: exp.weight_g, dev };
    resultEl.innerHTML = `
      <span class="verdict-chip ${cls}">${verdict}</span>
      <div class="reasons-block"><ul>${flags.map(f => `<li>${f}</li>`).join('')}</ul></div>`;
    document.getElementById('xray-apply-btn').style.display = cls === 'VERIFIED' ? 'none' : '';
  }
});

// ---- Apply intake result to the case ----
document.getElementById('xray-apply-btn').addEventListener('click', () => {
  if (!xrayLastResult || !xrayCase) return;
  const c = cases.find(x => x.return_id === xrayLastResult.case_id);
  if (!c) return;
  c.reasons = [`WAREHOUSE INTAKE (${xrayLastResult.verdict}): ${xrayLastResult.flags[0]}`, ...(xrayLastResult.flags.slice(1)), ...c.reasons];
  if (xrayLastResult.cls === 'SUSPECT') {
    c.risk_tier = 'HIGH';
    c.fraud_probability_pct = Math.max(c.fraud_probability_pct, 95);
    c.image_authenticity_score = Math.min(c.image_authenticity_score, 15);
    c.recommendation = 'Do not refund — package contents do not match the sold product (item substitution). Retain package as evidence and escalate to investigations.';
    const mine = myReturns.find(r => r.reference === c.return_id);
    if (mine) { mine.status = 'declined'; renderMyReturns(); }
  } else if (xrayLastResult.cls === 'REVIEW' && c.risk_tier === 'LOW') {
    c.risk_tier = 'MEDIUM';
    c.fraud_probability_pct = Math.max(c.fraud_probability_pct, 45);
    c.recommendation = 'Hold refund pending open-box inspection — intake weight deviation detected.';
  }
  selectedId = c.return_id;
  renderKPIs();
  renderQueue(false);
  renderDetail();
  document.getElementById('xray-result').innerHTML +=
    '<div style="font-size:12px; color:var(--blue-cyan); margin-top:8px;">✓ Applied to case — see the updated decision trace above.</div>';
  document.getElementById('xray-apply-btn').style.display = 'none';
});

// ---------------- Init ----------------
renderKPIs();
renderQueue(false);
renderModelTable();
renderShap();
renderImpact();
