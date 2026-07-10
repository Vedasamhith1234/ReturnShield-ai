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
