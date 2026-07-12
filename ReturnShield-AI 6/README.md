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

## Running the full backend (real persistence — recommended)

`dashboard/index.html` works fully standalone (see above) — everything is
computed client-side and resets on refresh, since there's nowhere to save it.
Running the backend alongside it upgrades the same dashboard to real,
durable storage: **SQLite** (`backend/returnshield.db`, created automatically
— no separate database server to install). Customer Portal submissions,
analyst comments, fraud-rule edits, and the audit log all survive restarts,
other tabs, and other devices once the backend is up. The dashboard detects
this automatically (a "Backend connected" / "Offline demo" pill in the
header) — no configuration needed, just have both running:

```bash
pip install -r requirements.txt   # or use a venv

# Terminal 1 — the dashboard
python serve.py                              # http://localhost:3000

# Terminal 2 — the backend (SQLite-persisted)
uvicorn backend.main:app --reload --port 8000
```

The first backend startup seeds `returnshield.db` with the 150 synthetic
cases (one time only — subsequent restarts read real persisted data, not the
seed set). To regenerate the ML model itself:

```bash
python3 data/generate_data.py          # synthetic orders/returns/chats/images
python3 -m features.feature_engineering
python3 -m models.train_models          # trains + compares 4 models, computes SHAP
```

API endpoints (once running):
| Endpoint | Description |
|---|---|
| `GET /api/cases?limit=200&risk_tier=&source=&q=` | Persisted return cases, filterable |
| `GET /api/case/{return_id}` | Full agent breakdown for one case |
| `GET /api/stats` | Aggregate KPIs for the dashboard |
| `POST /api/submit-return` | Customer Portal intake — scores + persists a return |
| `GET/POST /api/case/{return_id}/comments` | Analyst review comments |
| `GET /api/audit-log` | Who did what, when (submissions, decisions, rule changes) |
| `GET/PUT /api/fraud-rules` | Tunable thresholds (return-rate flag, low/high-value, etc.) |
| `POST /api/analyze-conversation` | Agent 2 as a service — score a structured chat |
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
  manipulation detection on real chat transcripts (see `USE_LLM_NLP` below for
  a working example of exactly this swap, already wired in for the Customer
  Portal)
- `agents/vision_agent.py` → replace `analyze_image_meta` with real output
  from YOLOv8 / OpenCV / GPT-4 Vision / Gemini Vision
- `agents/decision_agent.py` → replace the template logic with an LLM call
  that narrates the same structured inputs

## The trained ML model now scores live Customer Portal submissions

Previously, `POST /api/submit-return` never touched the trained model
(`models/best_model.joblib`) — every live return was scored by a hand-tuned
weighted formula in `backend/customer_pipeline.py`, while only the 150
synthetic seed cases went through the real RandomForest/CatBoost model. That
train/serve gap is closed:

- `features/feature_contract.py` is the single place both the training
  pipeline (`features/feature_engineering.py`, `models/train_models.py`) and
  the live serving path (`backend/main.py`) build the model's 14-column
  feature vector — one function, `build_features()`, one set of
  category/payment/warehouse encoders (persisted to `models/encoders.json`).
- `backend/main.py` loads `models/best_model.joblib` at startup and calls
  `predict_proba` for every live submission. Every persisted case (visible to
  analysts via `GET /api/case/{id}` and the Company Dashboard, not shown to
  the customer) is tagged `scoring_engine: "model"`. If the model file is
  ever missing or fails to load, the app doesn't crash — it falls back to the
  original hand-tuned blend and tags the case `scoring_engine:
  "rules_fallback"` instead, with a startup warning logged.
- Rule-based checks (product/brand mismatch, invoice cross-checks,
  return-frequency abuse, wardrobing/stale-return detection, chat NLP) still
  run on every submission and still populate `reasons`/`all_flags` — they're
  evidence for the analyst and the customer-facing rejection reasons, not the
  probability itself. Two overrides apply regardless of which engine set the
  probability, because they aren't things a static trained model can be
  trusted to represent: a product/brand mismatch is a plain fact, not a
  prediction, and forces a HIGH-risk reject; and a submission with literally
  no photo, invoice, or chat evidence can never auto-approve as LOW risk.
- **Known limitation, not hidden:** the live `CustomerReturnIn` payload has no
  real equivalent for 10 of the model's 14 trained features (no GPS mismatch,
  prior-fraud-flag count, address/payment-method count, account age,
  shipping distance, payment type, warehouse, delivery time, or coupon-used
  data at self-service intake time). Those default to documented neutral
  values (`features/feature_contract.py::INTAKE_UNKNOWN_DEFAULTS`), and
  `models/train_models.py` retrains with those same columns randomly masked
  to their defaults on ~30% of rows so the model learns not to over-rely on
  data it won't have live. Only `category`, `purchase_value`,
  `days_since_delivery`, and `return_frequency` are real live signals. The
  **98.6% accuracy / 95% precision reported in `models/model_comparison.json`
  reflects the earlier, unmasked training run on full synthetic data — after
  masking, the retrained model's held-out F1 is materially lower (see the
  current `model_comparison.json`)**, and that's the honest ceiling for what
  this model can actually do on live customer-portal traffic given the
  features available at intake, not a bug.
- A second, separately-gated swap: set `USE_LLM_NLP=1` and `ANTHROPIC_API_KEY`
  to route the Customer Portal's chat-trust scoring through a real Claude
  call (`agents/llm_nlp.py`, model `claude-sonnet-5`) instead of the regex
  lexicon in `agents/nlp_agent.py`, with automatic fallback to the regex
  agent on any error (missing key, network failure, malformed response) —
  visible via each case's `nlp_engine` field (`"llm"` vs `"regex_fallback"`).
  Off by default so the demo stays fully offline. This only affects the live
  Customer Portal — the synthetic dataset's Agent 2 scoring in
  `backend/pipeline.py` never imports this module.

Deliberately out of scope for this pass (a natural follow-up, not attempted
here): calibrating/re-sweeping the 0.40/0.75 tier thresholds in
`models/thresholds.json` against precision/recall targets, and a time-based
train/test split.

## Weekly automatic retraining from analyst feedback

An analyst's **approve**/**reject** decision on a live Customer Portal case
(`POST /api/case/{id}/comments`) becomes a new labeled training example —
`note`/`escalate` aren't clear-cut labels and are skipped. Once a week, the
model retrains itself on the synthetic dataset plus everything analysts have
labeled since the last run, and only replaces `models/best_model.joblib` if
the new candidate is at least as good as production on a **fixed held-out
test set, re-scored fresh every cycle** — never a stale stored number — so a
week of noisy analyst decisions can never silently make the model worse.
Candidates that don't win are archived to `models/candidates/`, not
discarded. Every cycle (run, skip, or error) is logged to
`models/registry.json`.

Two independent triggers, because they cover different failure modes:
- An in-process hourly check inside the running server (`backend/main.py`) —
  free, no setup, but best-effort: if the deployed backend is scaled to zero
  (`fly.toml`'s `min_machines_running = 0`), this simply doesn't run until
  something else wakes the machine.
- `POST /api/admin/retrain` (header `X-Retrain-Secret`, a **separate** secret
  from the demo's `SITE_ACCESS_PASSPHRASE` — this one guards a destructive
  action, not just page access, refused entirely if unset) plus a GitHub
  Actions cron (`.github/workflows/weekly-retrain.yml`, Monday 06:00 UTC)
  that calls it — this is what actually guarantees a weekly retrain in
  production, cold-starting a sleeping machine if needed.

Both funnel through the exact same gating function
(`models/retrain.py::run_retrain_cycle`), so "is a retrain actually due"
lives in one place. A promotion hot-reloads the model used by both the live
Customer Portal and the synthetic dataset's seeding/Simulate button in the
running process — no restart needed.
