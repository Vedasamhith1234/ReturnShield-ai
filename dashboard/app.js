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
  document.getElementById('queue-count').textContent = `${total} cases`;
}

function caseRowHTML(c, isNew) {
  return `<div class="case-row ${c.return_id === selectedId ? 'selected' : ''} ${isNew ? 'new-case' : ''}" data-id="${c.return_id}">
    <span class="risk-chip ${c.risk_tier}">${c.risk_tier}</span>
    <div class="case-main">
      <div class="rid">${c.return_id} · ${c.category}</div>
      <div class="meta"><b>${c.reason}</b></div>
    </div>
    <div class="case-prob" style="color:${riskColor[c.risk_tier]}">${c.fraud_probability_pct}%</div>
    <div class="case-value">${fmtMoney(c.purchase_value)}</div>
  </div>`;
}

function renderQueue(newestIsNew) {
  const list = document.getElementById('case-list');
  list.innerHTML = cases.map((c, i) => caseRowHTML(c, newestIsNew && i === 0)).join('');
  list.querySelectorAll('.case-row').forEach(row => {
    row.addEventListener('click', () => {
      selectedId = row.dataset.id;
      renderQueue(false);
      renderDetail();
    });
  });
}

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

// ---------------- Init ----------------
renderKPIs();
renderQueue(false);
renderModelTable();
renderShap();
renderImpact();
