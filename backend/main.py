"""
ReturnShield AI — Backend API
Run with:  uvicorn backend.main:app --reload --port 8000
"""
import json
import random
from datetime import datetime

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.pipeline import run_case
from data.generate_data import make_customer, make_order, make_chat, make_image_meta

DATA_DIR = "/home/claude/returnshield/data"
MODEL_DIR = "/home/claude/returnshield/models"

app = FastAPI(title="ReturnShield AI API")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

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

# Pre-compute a rolling case feed (most recent N returns), newest first
_CASE_CACHE = []


def _compute_case(return_row):
    order_row = ORDERS[return_row["order_id"]]
    chat_row = CHATS[return_row["return_id"]]
    image_row = IMAGES[return_row["return_id"]]
    freq = RETURN_FREQ.get(return_row["customer_id"], 1)
    return run_case(return_row, order_row, chat_row, image_row, freq)


def _init_cache(n=150):
    global _CASE_CACHE
    subset = sorted(RETURNS, key=lambda r: r["return_date"], reverse=True)[:n]
    _CASE_CACHE = [_compute_case(r) for r in subset]


_init_cache()


@app.get("/api/health")
def health():
    return {"status": "ok", "time": datetime.utcnow().isoformat()}


@app.get("/api/cases")
def get_cases(limit: int = 50):
    return _CASE_CACHE[:limit]


@app.get("/api/case/{return_id}")
def get_case(return_id: str):
    for c in _CASE_CACHE:
        if c["return_id"] == return_id:
            return c
    ret = next((r for r in RETURNS if r["return_id"] == return_id), None)
    if not ret:
        return {"error": "not found"}
    return _compute_case(ret)


@app.get("/api/stats")
def get_stats():
    tiers = {"HIGH": 0, "MEDIUM": 0, "LOW": 0}
    total_value_at_risk = 0.0
    for c in _CASE_CACHE:
        tiers[c["risk_tier"]] = tiers.get(c["risk_tier"], 0) + 1
        if c["risk_tier"] in ("HIGH", "MEDIUM"):
            total_value_at_risk += c["purchase_value"]
    avg_fraud_prob = sum(c["fraud_probability_pct"] for c in _CASE_CACHE) / max(len(_CASE_CACHE), 1)
    return {
        "total_cases": len(_CASE_CACHE),
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
    the full 5-agent pipeline — used to demo real-time scoring on the dashboard."""
    new_id = random.randint(100000, 999999)
    fraud_ring = random.random() < 0.15
    customer = make_customer(new_id, fraud_ring)
    order = make_order(new_id, customer)
    ORDERS[order["order_id"]] = order

    fraud_roll = random.random() < (0.6 if fraud_ring else 0.05)
    from datetime import timedelta
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
    _CASE_CACHE.insert(0, case)
    del _CASE_CACHE[200:]
    return case
