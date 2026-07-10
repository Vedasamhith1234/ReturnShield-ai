# ReturnShield AI — Multi-Agent Fraud Detection Platform

A working prototype for detecting and explaining shipment-return fraud in real
time, built as five cooperating agents feeding a fraud-prediction model and a
live dashboard.

> All data in this project is **synthetically generated** (via Faker + seeded
> randomness) for demo purposes. No real customer or order data is used.

## Architecture

```
Customer Return Event
        │
        ▼
Data Ingestion (data/generate_data.py) — orders, returns, chats, image metadata
        │
        ▼
Feature Engineering (features/feature_engineering.py)
        │
   ┌────────────┬──────────────┬──────────────┐
   ▼            ▼              ▼
Agent 1:     Agent 2:       Agent 3:
Pattern      NLP Trust      Vision
(agents/     (agents/       (agents/
pattern_     nlp_agent.py)  vision_agent.py)
agent.py)
   │            │              │
   └────────────┼──────────────┘
                ▼
     Agent 4: Fraud Prediction Model (models/train_models.py)
     Random Forest / XGBoost / LightGBM / CatBoost — auto-compared, best kept
                ▼
        SHAP Explainability
                ▼
     Agent 5: Decision Agent (agents/decision_agent.py)
                ▼
     Dashboard (dashboard/index.html) — dark blue/black/white glassmorphism UI
```

## Quick start — run locally with working camera (recommended)

```bash
python serve.py
```
opens http://localhost:3000 automatically. **The camera works here** because
localhost is a secure context. The Agent 3 vision panel does REAL client-side
image analysis: perceptual-hash duplicate detection (submit the same photo
twice to see it flagged), brightness, sharpness/blur, and resolution checks.

## Quick start — view the dashboard right now

The dashboard is a **fully self-contained HTML file** with 150 pre-computed
real cases (run through all 5 agents) embedded directly in it. Just open:

```
dashboard/index.html
```

in any browser. No server required. It includes:
- Live case queue with risk scoring, sortable by fraud probability
- Full agent-by-agent decision trace for every case (click any row)
- Real model comparison table (actual Precision/Recall/F1/ROC-AUC from training)
- SHAP feature importance chart
- Business impact estimates
- A "Simulate incoming return" button that generates new cases live in-browser
  (auto-runs every ~12s too), running a JS mirror of the same agent logic
- A working Agent 3 (image verification) demo panel — opens your camera or
  accepts an upload and scores the photo

**Camera note:** browsers only allow camera access on secure contexts
(https:// or localhost). Opening `index.html` via `file://` blocks the camera —
the dashboard detects this and shows exact instructions. Fix: `python serve.py`
(localhost) or the live Netlify URL (https). Upload always works everywhere.

## Running the full backend (real-time API + regenerating data/models)

```bash
pip install -r requirements.txt --break-system-packages   # or use a venv

# 1. Generate synthetic data (orders, returns, chats, image metadata)
python3 data/generate_data.py

# 2. Build the feature table
python3 -m features.feature_engineering

# 3. Train & compare Random Forest / XGBoost / LightGBM / CatBoost,
#    compute SHAP importances and business-impact estimates
python3 -m models.train_models

# 4. Launch the live API
uvicorn backend.main:app --reload --port 8000
```

API endpoints (once running):
| Endpoint | Description |
|---|---|
| `GET /api/cases?limit=50` | Recent return cases, fully scored by all 5 agents |
| `GET /api/case/{return_id}` | Full agent breakdown for one case |
| `GET /api/stats` | Aggregate KPIs for the dashboard |
| `GET /api/model-comparison` | Precision/Recall/F1/ROC-AUC for all 4 models |
| `GET /api/business-impact` | Estimated fraud $ prevented, review time saved |
| `GET /api/shap-importance` | SHAP feature importance ranking |
| `POST /api/simulate` | Generates one new synthetic return and scores it live |

## Where each requirement is met

| Deliverable | Location |
|---|---|
| Working prototype | `dashboard/index.html` (standalone) + `backend/` (live API) |
| Data ingestion | `data/generate_data.py` |
| ML model pipeline | `features/feature_engineering.py`, `models/train_models.py` |
| Dashboard | `dashboard/index.html` |
| Fraud risk visualization | Case queue, agent score bars, SHAP chart in dashboard |
| Precision/Recall metrics | `models/model_comparison.json`, rendered in dashboard |
| Business impact | `models/business_impact.json`, rendered in dashboard |






## Agent 7 — Warehouse Intake: X-Ray & Weight Verification (v6)

Catches **item substitution** — the "buy a $1,000 shoe, return a $30 knockoff
(or a brick) in the box" scam that costs retailers like Amazon heavily, since
the swap is invisible until someone opens the package.

How it works (company dashboard → Warehouse Intake panel):
1. Operator selects the arriving return (case queue feeds the selector;
   customer-submitted cases are tagged)
2. The product catalog shows the expected shipping weight and boxed dimensions
   (e.g., Nike Air Max 90: 1,150g, 35×25×13cm)
3. Operator enters the actual scale reading and optional measured dims
4. **Run X-ray scan** — an animated scanner view renders the package outline,
   the expected product silhouette (dashed), and the detected contents scaled
   by the weight ratio, with density readouts
5. Verdict: CONTENTS VERIFIED / PARTIAL MATCH (missing parts — open-box
   inspection) / CONTENTS MISMATCH (probable substitution)
6. **Apply to case** — mismatch escalates the case to HIGH / 95%+, prepends
   the intake evidence, flips the recommendation to "Do not refund — retain
   package as evidence", and the customer's My Returns status becomes
   NOT ACCEPTED.

Weight/dimension verification against the catalog is real logic; the X-ray
imagery is a simulated scanner rendering for the prototype — in production
the panel ingests real X-ray/CT frames and scale telemetry from the intake
line, with silhouette comparison via a vision model.

Demo: select the Nike case → enter weight 310 → Run X-ray scan → watch the
mismatch verdict → Apply to case.

## Role security, filters & return tracking (v5)

**Hard role enforcement:** a customer session can never open the company
dashboard — enforced twice: a guard inside `setView()` plus `!important` CSS
rules keyed on a `role-customer` body class. The test suite includes an
attempted forced `setView('company')` from a customer session and asserts the
company view stays hidden.

**Company queue filters:** full-text search (case ID, customer, order, product,
reason, description, evidence flags) + one-tap chips for High/Medium/Low risk
and Customer-submitted only, with live result counts and a no-results state.

**Customer "My Returns" tracker:** every submission appears in a searchable
list (reference / product / status) with live status pills — APPROVED, UNDER
REVIEW, NOT ACCEPTED. When an analyst approves or rejects the case via the
comments workflow on the company side, the customer's tracker status updates.

## Login, product-match verification & universal invoices (v4)

**Demo accounts** (shown on the login screen; prototype auth, not production):
| Role | Email | Password |
|---|---|---|
| Customer | customer@demo.com | customer123 |
| Company | admin@returnshield.ai | admin123 |

**Product-match verification (buy Nike, return Puma → DENIED):**
The customer picks the order being returned from their real order history
(demo account has 5 seeded orders: Nike, Apple, Samsung, Levi's, Adidas).
Three evidence sources are checked against the ordered product's brand:
1. Brand text OCR'd from the item photo (Tesseract.js, lazy-loaded)
2. Brand read from the attached invoice
3. Brand in the customer's own "item you're sending back" declaration
Any mismatch → the customer gets a factual denial ("the item doesn't match
your original order"), and the company queue gets a HIGH-risk case flagged
PRODUCT MISMATCH with the evidence and a reject recommendation.

**Invoice attach/capture from any retailer:**
Customers can capture (camera) or upload (image/PDF) an invoice from anywhere —
Amazon, Walmart, Target, Best Buy, Costco, etc. OCR extracts the retailer name,
total amount, and any brand mentions; totals are cross-checked against the
order record and third-party receipts are flagged for the ops team.

OCR notes: Tesseract.js loads from CDN on first use. If unavailable (offline,
file:// restrictions), everything gracefully falls back to the typed
declaration matching — the mismatch check still works.

## Two-sided application (v3)

The app now serves both sides of the return flow, switchable via the header tabs:

**Customer Portal** — public-facing return intake:
- Return form: order ID, category, value, reason, days since delivery, description
- Photo attachment via camera or upload (photos run through the real image checks)
- Customer-safe responses only: instant "approved" for low-risk returns, a
  friendly "we're reviewing, hear back in 24h" for flagged ones — fraud scores
  and reasons are NEVER shown to the customer (anti-fraud design: don't teach
  bad actors what triggers review)
- Backend: `POST /api/submit-return`

**Company Dashboard** — internal ops view:
- Customer submissions appear at the top of the case queue instantly, tagged
  CUSTOMER, with the full agent breakdown (fraud probability, all flags,
  contradiction detection on the customer's own description, photo analysis)
- Everything else: model comparison, SHAP, comments workflow, invoice
  verification, transcript analyzer, business impact

## Enterprise features (v2)

| Feature | Where | Notes |
|---|---|---|
| **Analyst comments & review workflow** | Case detail panel in dashboard; `POST/GET /api/case/{id}/comments` in backend | Notes, approve/reject/escalate tags, author + timestamp per comment |
| **Agent 6 — Invoice verification** | Upload panel in dashboard; `agents/invoice_agent.py` + `POST /api/verify-invoice` | Amount mismatch, duplicate-document detection (SHA-256 hash), date-timeline checks, order-ID cross-check |
| **Live chat transcript analyzer** | Paste-and-analyze panel in dashboard; `POST /api/analyze-transcript` | Run Agent 2 on any real transcript: contradiction, abuse, manipulation, copy-paste excuse detection |

In the standalone dashboard these run fully in-browser (JS mirrors of the
Python agents; comments stored in-memory per session). With the FastAPI
backend running, the same features are served by the API for persistence
across users.

## Notes on the "warehouse employee involved" signal

This is intentionally implemented as a **routine-review flag**, not an
automated accusation: it only surfaces when image/product evidence looks
inconsistent *without* matching customer-side risk signals, and is phrased as
a suggestion to check fulfillment logs — never a determination of guilt.

## Swapping in real LLM/Vision models

Agents 2, 3, and 5 currently use transparent rule-based logic so the whole
system runs offline and deterministically for this demo. Each has a clearly
marked integration point to swap in a real model:
- `agents/nlp_agent.py` → replace with a Claude/GPT call for contradiction &
  manipulation detection on real chat transcripts
- `agents/vision_agent.py` → replace `analyze_image_meta` with real output
  from YOLOv8 / OpenCV / GPT-4 Vision / Gemini Vision
- `agents/decision_agent.py` → replace the template logic with an LLM call
  that narrates the same structured inputs
