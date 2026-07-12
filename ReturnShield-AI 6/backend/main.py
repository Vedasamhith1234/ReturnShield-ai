"""
ReturnShield AI — Backend API
Run with:  uvicorn backend.main:app --reload --port 8000

Persistence: SQLite via backend/db.py (backend/returnshield.db) — cases,
comments, the audit log, per-customer return history, and fraud-rule edits
all survive a restart. The synthetic seed dataset is loaded from data/*.json
and used only once, to seed the cases table on first run.
"""
import asyncio
import json
import os
from datetime import datetime, timedelta
from pathlib import Path

import joblib
from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from backend import db, pipeline as pipeline_module
from backend.customer_pipeline import score_customer_return
from backend.pipeline import run_case
from data.generate_data import make_customer, make_order, make_chat, make_image_meta
from features.feature_contract import build_features
from models import retrain as retrain_module

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"
# Reuses backend/pipeline.py's already-resolved MODEL_DIR (which also does
# the first-boot bootstrap-copy from the repo's committed models/* onto a
# fresh persistent volume) rather than recomputing it — pipeline.py is
# imported above and needs the file at import time, so its resolution runs
# first regardless; duplicating the bootstrap here would just double-copy.
MODEL_DIR = pipeline_module.MODEL_DIR


def _load_customer_model():
    """Loaded independently from backend/pipeline.py's own copy (used for
    the synthetic dataset) so a missing/corrupt model file degrades the live
    customer-portal scoring path only — it never prevents the app from
    starting. score_customer_return() falls back to its rules_fallback blend
    and marks the case with scoring_engine="rules_fallback" when this is
    None. Also used to hot-reload after a promoted weekly retrain."""
    try:
        model = joblib.load(MODEL_DIR / "best_model.joblib")
        print(f"Customer-portal scoring: loaded trained model from {MODEL_DIR / 'best_model.joblib'}")
        return model
    except Exception as _model_err:
        print(f"WARNING: could not load models/best_model.joblib for live customer scoring — "
              f"falling back to the rules-based engine: {_model_err}")
        return None


_CUSTOMER_MODEL = _load_customer_model()


def _reload_models_after_promotion():
    """Called after run_retrain_cycle() reports promoted=True. Reassigns
    both this module's _CUSTOMER_MODEL and backend/pipeline.py's _model —
    per design, a promoted retrain should apply to both the live Customer
    Portal and the synthetic dataset's seeding/Simulate button, since both
    load the exact same models/best_model.joblib file. A single pointer
    swap on each, safe under the GIL with no extra locking needed; keeps the
    previous model on failure rather than leaving either side with none."""
    global _CUSTOMER_MODEL
    reloaded = _load_customer_model()
    if reloaded is not None:
        _CUSTOMER_MODEL = reloaded
    pipeline_module.reload_model()

app = FastAPI(title="ReturnShield AI API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Optional demo-site gate: unset by default (local dev / this repo's tests
# run wide open, unchanged). Set SITE_ACCESS_PASSPHRASE when deploying this
# prototype somewhere publicly reachable so it isn't wide open to anyone who
# finds the domain — this is a shared-secret speed bump, not real auth (the
# frontend has to embed the same value to send it, so it's visible to anyone
# who reads the page source or the request headers). For real access control
# put this behind an edge auth layer (e.g. Cloudflare Access) that gates
# requests before they ever reach this server.
_SITE_PASSPHRASE = os.environ.get("SITE_ACCESS_PASSPHRASE")


@app.middleware("http")
async def site_passphrase_gate(request: Request, call_next):
    if not _SITE_PASSPHRASE:
        return await call_next(request)
    if request.method == "OPTIONS":  # let CORS preflight through unauthenticated
        return await call_next(request)
    if request.headers.get("x-site-passphrase") != _SITE_PASSPHRASE:
        return JSONResponse(status_code=401, content={"error": "Site passphrase required"})
    return await call_next(request)

with open(f"{DATA_DIR}/customers.json") as f:
    CUSTOMERS = json.load(f)
with open(f"{DATA_DIR}/orders.json") as f:
    ORDERS = {o["order_id"]: o for o in json.load(f)}
with open(f"{DATA_DIR}/returns.json") as f:
    RETURNS = json.load(f)
with open(f"{DATA_DIR}/chats.json") as f:
    CHATS = {c["return_id"]: c for c in json.load(f)}
with open(f"{DATA_DIR}/images.json") as f:
    IMAGES = {i["return_id"]: i for i in json.load(f)}

RETURN_FREQ = {}
for r in RETURNS:
    RETURN_FREQ[r["customer_id"]] = RETURN_FREQ.get(r["customer_id"], 0) + 1

CUSTOMERS_BY_ID = {c["customer_id"]: c for c in CUSTOMERS}
CUSTOMER_NAMES = {c["customer_id"]: c["name"] for c in CUSTOMERS}


def _compute_case(return_row):
    order_row = ORDERS[return_row["order_id"]]
    chat_row = CHATS[return_row["return_id"]]
    image_row = IMAGES[return_row["return_id"]]
    freq = RETURN_FREQ.get(return_row["customer_id"], 1)
    case = run_case(return_row, order_row, chat_row, image_row, freq)
    case["source"] = "synthetic"
    return case


def _seed_db_if_empty(n: int = 150):
    """Seeds the cases table from the synthetic dataset on first run only —
    every run after that reads real persisted data, so restarting the server
    no longer wipes the queue back to the seed set."""
    if db.case_count() > 0:
        return
    subset = sorted(RETURNS, key=lambda r: r["return_date"], reverse=True)[:n]
    for r in subset:
        db.insert_case(_compute_case(r))


db.init_db()
_seed_db_if_empty()


@app.get("/api/health")
def health():
    return {"status": "ok", "time": datetime.utcnow().isoformat()}


@app.get("/api/cases")
def get_cases(limit: int = 200, risk_tier: str = None, source: str = None, q: str = None):
    return db.get_cases(limit=limit, risk_tier=risk_tier, source=source, q=q)


@app.get("/api/case/{return_id}")
def get_case(return_id: str):
    case = db.get_case(return_id)
    return case if case else {"error": "not found"}


@app.get("/api/customer-names")
def customer_names():
    """Name lookup for the synthetic seed customers — mirrors what
    dashboard/build.py bakes into the standalone demo's data bundle."""
    return CUSTOMER_NAMES


@app.get("/api/stats")
def get_stats():
    cases = db.get_cases(limit=100000)
    tiers = {"HIGH": 0, "MEDIUM": 0, "LOW": 0}
    total_value_at_risk = 0.0
    for c in cases:
        tiers[c["risk_tier"]] = tiers.get(c["risk_tier"], 0) + 1
        if c["risk_tier"] in ("HIGH", "MEDIUM"):
            total_value_at_risk += c["purchase_value"]
    avg_fraud_prob = sum(c["fraud_probability_pct"] for c in cases) / max(len(cases), 1)
    return {
        "total_cases": len(cases),
        "risk_tier_counts": tiers,
        "avg_fraud_probability_pct": round(avg_fraud_prob, 1),
        "total_value_at_risk_usd": round(total_value_at_risk, 2),
    }


@app.get("/api/model-comparison")
def model_comparison():
    with open(f"{MODEL_DIR}/model_comparison.json") as f:
        return json.load(f)


@app.get("/api/business-impact")
def business_impact():
    with open(f"{MODEL_DIR}/business_impact.json") as f:
        return json.load(f)


@app.get("/api/shap-importance")
def shap_importance():
    with open(f"{MODEL_DIR}/shap_feature_importance.json") as f:
        return json.load(f)


@app.post("/api/simulate")
def simulate_new_case():
    """Generates one new synthetic incoming return and runs it live through
    the full 5-agent pipeline — used to demo real-time scoring on the
    dashboard. Persisted like any other case."""
    import random
    new_id = random.randint(100000, 999999)
    fraud_ring = random.random() < 0.15
    customer = make_customer(new_id, fraud_ring)
    order = make_order(new_id, customer)
    ORDERS[order["order_id"]] = order

    fraud_roll = random.random() < (0.6 if fraud_ring else 0.05)
    return_date = datetime.fromisoformat(order["delivery_date"]) + timedelta(
        days=random.randint(0, 3) if fraud_roll else random.randint(1, 21))
    reason = "Item never arrived" if (fraud_roll and random.random() < 0.5) else random.choice(
        ["Item arrived damaged", "Wrong item sent", "Changed my mind", "Defective / stopped working"])

    return_row = {
        "return_id": f"RET-SIM-{new_id}",
        "order_id": order["order_id"],
        "customer_id": customer["customer_id"],
        "reason": reason,
        "return_date": return_date.isoformat(),
        "days_before_return": (return_date - datetime.fromisoformat(order["delivery_date"])).days,
        "gps_mismatch_km": round(random.uniform(300, 3000), 1) if (fraud_roll and random.random() < 0.6) else round(random.uniform(0, 40), 1),
        "account_age_days": customer["account_age_days"],
        "prior_fraud_flags": customer["prior_fraud_flags"],
        "addresses_used": customer["addresses_used"],
        "payment_methods_used": customer["payment_methods_used"],
        "is_fraud": fraud_roll,
    }
    chat = make_chat(fraud_roll, reason)
    image_meta = make_image_meta(fraud_roll)
    CHATS[return_row["return_id"]] = {"return_id": return_row["return_id"], **chat}
    IMAGES[return_row["return_id"]] = {"return_id": return_row["return_id"], **image_meta}
    RETURN_FREQ[customer["customer_id"]] = RETURN_FREQ.get(customer["customer_id"], 0) + 1

    case = _compute_case(return_row)
    db.insert_case(case)
    db.add_audit_entry("case", f"{case['return_id']} simulated — {case['risk_tier']} risk", "System")
    return case


# ---------------------------------------------------------------------------
# Analyst comments, audit log, fraud rule management
# ---------------------------------------------------------------------------

class CommentIn(BaseModel):
    author: str = "Analyst"
    text: str
    action: str = "note"  # note | approve | reject | escalate


@app.get("/api/case/{return_id}/comments")
def get_comments(return_id: str):
    return db.get_comments(return_id)


@app.post("/api/case/{return_id}/comments")
def add_comment(return_id: str, comment: CommentIn):
    timestamp = datetime.utcnow().isoformat()
    db.add_comment(return_id, comment.author, comment.text, comment.action, timestamp)
    db.add_audit_entry(
        "decision",
        f"{comment.action.upper()} on {return_id}: \"{comment.text[:80]}\"",
        comment.author,
        timestamp,
    )
    # Feed the weekly retrain loop (models/retrain.py): an analyst's
    # approve/reject on a live customer case is real-world ground truth for
    # the exact feature vector that case was scored with. note/escalate
    # aren't clear-cut labels, so they're skipped; a case with no stored
    # model_features (synthetic cases, or customer cases from before this
    # shipped) is skipped too rather than guessed at.
    if comment.action in ("approve", "reject"):
        case = db.get_case(return_id)
        if case and case.get("source") == "customer" and case.get("model_features"):
            db.insert_labeled_outcome(
                return_id, is_fraud=(comment.action == "reject"),
                feature_row=case["model_features"], action=comment.action, timestamp=timestamp,
            )
        elif case and case.get("source") == "customer":
            print(f"Skipping label for {return_id}: no stored model_features (submitted before this feature shipped?)")
    return {"ok": True, "comments": db.get_comments(return_id)}


@app.get("/api/audit-log")
def get_audit_log(limit: int = 200):
    return db.get_audit_log(limit=limit)


@app.get("/api/fraud-rules")
def get_fraud_rules():
    return db.get_fraud_rules()


class FraudRuleUpdate(BaseModel):
    key: str
    value: float
    actor: str = "Admin"


@app.put("/api/fraud-rules")
def update_fraud_rule(body: FraudRuleUpdate):
    rules = db.get_fraud_rules()
    if body.key not in rules:
        return {"error": f"Unknown rule key: {body.key}"}
    old_value = rules[body.key]
    db.set_fraud_rule(body.key, body.value)
    db.add_audit_entry(
        "rule", f"{body.key} changed from {old_value} to {body.value}", body.actor, datetime.utcnow().isoformat()
    )
    return db.get_fraud_rules()


# ---------------------------------------------------------------------------
# Weekly retraining from analyst feedback (models/retrain.py)
# ---------------------------------------------------------------------------
# Deliberately a SEPARATE secret from SITE_ACCESS_PASSPHRASE above — that one
# is documented as a speed bump meant to live in frontend JS (visible to
# anyone reading page source), which is fine for gating demo access but not
# for an endpoint that can overwrite the production model. Unset by default
# means REFUSED (503) — the opposite default from the passphrase gate, since
# "open by default" is a much bigger blast radius here.
_RETRAIN_ADMIN_SECRET = os.environ.get("RETRAIN_ADMIN_SECRET")


@app.post("/api/admin/retrain")
async def trigger_retrain(request: Request, force: bool = False):
    """Manually/externally trigger a retrain cycle — used by the weekly
    GitHub Actions cron (see .github/workflows/weekly-retrain.yml) so this
    actually fires every week even if the deployed machine is scaled to zero
    and the in-process scheduler below never got a chance to run. force=true
    (as a query param, e.g. ?force=true) bypasses the 7-day-since-last-run
    and minimum-new-labels gates — used for manual/on-demand runs and tests."""
    if not _RETRAIN_ADMIN_SECRET:
        return JSONResponse(status_code=503, content={"error": "Retrain endpoint not configured (RETRAIN_ADMIN_SECRET unset)"})
    if request.headers.get("x-retrain-secret") != _RETRAIN_ADMIN_SECRET:
        return JSONResponse(status_code=401, content={"error": "Invalid retrain secret"})
    result = await asyncio.to_thread(retrain_module.run_retrain_cycle, trigger="api", force=force)
    if result.get("promoted"):
        _reload_models_after_promotion()
    return result


async def _retrain_scheduler_loop():
    """Best-effort in-process supplement to the GitHub Actions cron above —
    wakes hourly and asks run_retrain_cycle() whether a week has actually
    passed; that gating logic lives in exactly one place (models/retrain.py)
    so this loop and the API endpoint above can never disagree about when a
    retrain is actually due. Runs the CPU-bound fit via a thread pool so it
    doesn't block the event loop from serving live requests meanwhile."""
    while True:
        await asyncio.sleep(3600)
        try:
            result = await asyncio.to_thread(retrain_module.run_retrain_cycle, trigger="in_process_timer")
            if result.get("promoted"):
                _reload_models_after_promotion()
        except Exception as e:
            print(f"In-process retrain scheduler check failed (will retry next hour): {e}")


@app.on_event("startup")
async def _start_retrain_scheduler():
    # Disabled for tests (set alongside RETURNSHIELD_DB_PATH) so the test
    # suite doesn't spawn a real background retrain loop.
    if os.environ.get("RETURNSHIELD_DISABLE_SCHEDULER"):
        return
    asyncio.create_task(_retrain_scheduler_loop())


# ---------------------------------------------------------------------------
# Agent 2 / Agent 6 as standalone live services
# ---------------------------------------------------------------------------
from agents.invoice_agent import verify_invoice
from agents.nlp_agent import analyze_conversation, analyze_transcript


class TranscriptIn(BaseModel):
    transcript: str
    excuse_history_count: int = 0


@app.post("/api/analyze-transcript")
def analyze_transcript_endpoint(body: TranscriptIn):
    """Agent 2 as a live service: paste any real chat transcript and get
    an instant trust analysis."""
    return analyze_transcript(body.transcript, body.excuse_history_count)


class ConversationIn(BaseModel):
    turns: list[str]
    excuse_history_count: int = 0


@app.post("/api/analyze-conversation")
def analyze_conversation_endpoint(body: ConversationIn):
    """Agent 2 as a live service for a structured multi-turn chat — mirrors
    /api/analyze-transcript but scores a real conversation (a list of
    customer turns) instead of one pasted string, which catches cross-turn
    contradictions and vague non-answers a single string can't."""
    return analyze_conversation(body.turns, body.excuse_history_count)


class InvoiceIn(BaseModel):
    order_id: str
    invoice_number: str = ""
    invoice_amount: float = 0.0
    invoice_date: str = ""       # ISO date
    merchant_name: str = ""
    order_id_on_invoice: str = ""
    document_hash: str = ""      # hash of the uploaded file bytes


@app.post("/api/verify-invoice")
def verify_invoice_endpoint(body: InvoiceIn):
    """Agent 6 as a live service: cross-check extracted invoice fields against
    the order record. In production the fields come from OCR on the uploaded
    document; the client sends the document hash for duplicate detection."""
    order = ORDERS.get(body.order_id)
    if not order:
        return {"error": f"Order {body.order_id} not found"}
    return verify_invoice(body.model_dump(), order)


# ---------------------------------------------------------------------------
# Customer-portal return submission
# ---------------------------------------------------------------------------

class CustomerReturnIn(BaseModel):
    """Customer-portal return submission. Camera capture, OCR text
    extraction, and image-quality analysis (blur/brightness/duplicate-hash)
    all require browser APIs and stay client-side — this payload carries
    their already-computed results so the server can fold them into the
    final scoring decision alongside its own checks (return frequency, chat
    NLP, product-match verification)."""
    order_id: str = ""
    email: str = ""
    category: str = "Electronics"
    purchase_value: float = 0.0
    reason: str = "Changed my mind"
    days_since_delivery: int = 3
    description: str = ""
    chat_transcript: str = ""       # full "Customer: ... / Agent: ..." transcript, for storage/display
    chat_turns: list[str] = []      # customer-only turns, for analyze_conversation
    product_ordered: str = ""
    item_declared: str = ""
    order_brand: str = ""
    photo_provided: bool = False
    photo_data_url: str = ""
    photo_score: float = 100.0
    photo_flags: list[str] = []
    photo_detected_brand: str = ""
    photo_category_mismatch: bool = False  # client already checked classification against the order's category
    photo_classified_label: str = ""       # the specific predicted label, for the customer-safe rejection reason
    invoice_attached: bool = False
    invoice_data_url: str = ""
    invoice_total: float | None = None
    invoice_retailer: str = ""
    invoice_brand: str = ""
    serial_photo_provided: bool = False
    serial_photo_data_url: str = ""
    detected_serial: str = ""       # client-OCR'd; not yet normalized server-side
    serial_confident: bool = False  # True only for a keyword-anchored OCR read — see dashboard/app.js::extractSerialNumber
    order_known_serial: str = ""    # the order's serial "on file" (demo: from CUSTOMER_ORDERS), sent by the client
    is_new_order: bool = False      # self-added order — no inventory record exists, so no known serial to check


@app.post("/api/submit-return")
def submit_customer_return(body: CustomerReturnIn):
    """Customer-facing intake: scores the submission (backend/customer_pipeline.py),
    persists it for the Company Dashboard, and returns ONLY a customer-safe
    status — no score/tier, though a rejected return does get a categorical
    (not exact-score) breakdown of why, matching the standalone demo's UX."""
    import uuid as _uuid

    sim_id = _uuid.uuid4().hex[:8]
    now = datetime.utcnow()
    customer_id = body.email or "guest-customer"

    rules = db.get_fraud_rules()
    history = db.get_customer_history(customer_id)

    # Computed unconditionally (cheap, no model dependency) so the feature
    # vector is always stored on the case — that's what lets a later analyst
    # approve/reject decision become a labeled training example in
    # models/retrain.py, even on a submission scored by the rules_fallback
    # engine. Only predict_proba stays conditional on the model being loaded.
    feature_row = build_features(
        order={"category": body.category, "purchase_value": body.purchase_value},
        return_event={"days_before_return": body.days_since_delivery},
        customer_history={"return_frequency": history["returns_filed"]},
    )
    model_features = feature_row.iloc[0].to_dict()
    model_probability = None
    if _CUSTOMER_MODEL is not None:
        model_probability = float(_CUSTOMER_MODEL.predict_proba(feature_row)[0][1])

    result = score_customer_return(body, rules, history, model_probability=model_probability)
    is_low_value = result["is_low_value"]

    history_after = db.record_customer_return(customer_id, is_low_value)

    case = {
        "return_id": f"RET-CUST-{sim_id}",
        "customer_id": customer_id,
        "order_id": body.order_id or f"ORD-CUST-{sim_id}",
        "category": body.category,
        "purchase_value": max(body.purchase_value, 0.01),
        "reason": body.reason,
        "product_ordered": body.product_ordered,
        "item_declared": body.item_declared or "(not stated)",
        "photo_data_url": body.photo_data_url or None,
        "serial_photo_data_url": body.serial_photo_data_url or None,
        "serial_ocr": {
            "detected": body.detected_serial or None,
            "known": body.order_known_serial or None,
            "confident": body.serial_confident,
        } if body.serial_photo_provided else None,
        "invoice_attached": body.invoice_attached,
        "invoice_data_url": body.invoice_data_url or None,
        "invoice_ocr": {
            "retailer": body.invoice_retailer or None,
            "total": body.invoice_total,
            "brand": body.invoice_brand or None,
        } if body.invoice_attached else None,
        "ground_truth_is_fraud": None,
        "suspicious_pattern_score": result["suspicious_pattern_score"],
        "customer_trust_score": result["customer_trust_score"],
        "image_authenticity_score": result["image_authenticity_score"],
        "fraud_probability_pct": result["fraud_probability_pct"],
        "risk_tier": result["risk_tier"],
        "reasons": result["all_flags"],
        "top_model_drivers": [],
        "recommendation": result["recommendation"],
        "warehouse_review_note": None,
        "chat_transcript": body.chat_transcript or "(no conversation with the support assistant)",
        "timestamp": now.isoformat(),
        "source": "customer",
        "scoring_engine": result["scoring_engine"],
        "nlp_engine": result["nlp_engine"],
        "model_features": model_features,
        "model_probability": model_probability,
    }
    db.insert_case(case)
    db.add_audit_entry(
        "case",
        f"{case['return_id']} submitted — {result['risk_tier']} risk ({body.product_ordered}, ${case['purchase_value']:.2f})",
        customer_id,
        now.isoformat(),
    )

    risk_tier = result["risk_tier"]
    if risk_tier == "HIGH":
        return {
            "status": "rejected",
            "message": "We're unable to approve this return automatically.",
            "reasons": result["reasons_for_customer"],
            "reference": case["return_id"],
        }
    if risk_tier == "MEDIUM":
        return {
            "status": "under_review",
            "message": "Thanks — we've received your return request. Our team will get back to you within 24 hours.",
            "reference": case["return_id"],
        }
    if result["is_high_value"]:
        return {
            "status": "approved",
            "message": "Your return is accepted. Please return it to your nearest warehouse or drop-off location instead of shipping it — we've emailed the nearest location.",
            "reference": case["return_id"],
        }
    if result["is_lenient_low_value"]:
        return {
            "status": "approved",
            "message": "Your return is approved — since this item is under the low-value threshold, there's no need to send it back. Your refund has been issued.",
            "reference": case["return_id"],
        }
    return {
        "status": "approved",
        "message": "Your return is approved. A prepaid shipping label has been emailed to you.",
        "reference": case["return_id"],
    }
