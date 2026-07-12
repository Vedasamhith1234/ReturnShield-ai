"""
Multi-agent orchestration: runs a single return case through
Pattern Agent -> NLP Agent -> Vision Agent -> ML Fraud Model -> Decision Agent.
"""
import json
import os
import random
import shutil
from datetime import datetime, timedelta
from pathlib import Path

import joblib

from agents.decision_agent import decide
from agents.nlp_agent import analyze_transcript
from agents.pattern_agent import pattern_score
from agents.vision_agent import analyze_image_meta
from features.feature_contract import build_features

REPO_ROOT = Path(__file__).resolve().parent.parent
_REPO_MODEL_DIR = REPO_ROOT / "models"
# Overridable to point at a persistent volume in production (see
# fly.toml/Dockerfile's RETURNSHIELD_MODEL_DIR) — this file's _model and
# backend/main.py's _CUSTOMER_MODEL both load the same best_model.joblib, so
# a promoted weekly retrain must be able to hot-reload both from the same
# place (see reload_model() below). This module is the first thing that
# needs the file at import time (backend/main.py imports this module before
# it does its own model handling), so the first-boot bootstrap-copy from the
# repo's committed models/* lives here, not in main.py.
MODEL_DIR = Path(os.environ.get("RETURNSHIELD_MODEL_DIR", _REPO_MODEL_DIR))
if MODEL_DIR != _REPO_MODEL_DIR:
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    if not (MODEL_DIR / "best_model.joblib").exists():
        # Only the model artifacts, not this directory's .py source files
        # (train_models.py/retrain.py/__init__.py) — the volume is data
        # storage, not a code deployment target.
        for item in _REPO_MODEL_DIR.iterdir():
            if item.is_file() and item.suffix != ".py":
                shutil.copy2(item, MODEL_DIR / item.name)
MODEL_PATH = MODEL_DIR / "best_model.joblib"
SHAP_PATH = REPO_ROOT / "models" / "shap_feature_importance.json"

_model = joblib.load(MODEL_PATH)
with open(SHAP_PATH) as f:
    _shap_importance = json.load(f)


def reload_model():
    """Called by backend/main.py after models/retrain.py promotes a new
    model, so the synthetic dataset's seeding/Simulate button picks up the
    same version as live Customer Portal scoring without a restart. Keeps
    the previous model on failure rather than leaving this with none."""
    global _model
    try:
        _model = joblib.load(MODEL_PATH)
    except Exception as e:
        print(f"WARNING: pipeline.py could not reload {MODEL_PATH} after a promoted retrain: {e}")

HOLIDAY_MONTHS = {11, 12, 1}


def run_case(return_row: dict, order_row: dict, chat_row: dict, image_row: dict, return_frequency: int) -> dict:
    X = build_features(order_row, return_row, {"return_frequency": return_frequency})
    fraud_probability = float(_model.predict_proba(X)[0][1])

    order_month = datetime.fromisoformat(order_row["order_date"]).month
    pattern_result = pattern_score(
        return_row, order_row["category"], order_row["purchase_value"],
        return_frequency, order_month in HOLIDAY_MONTHS)

    excuse_history = return_frequency if chat_row.get("used_copy_paste_excuse") else 0
    trust_result = analyze_transcript(chat_row["transcript"], excuse_history)

    image_result = analyze_image_meta(image_row)

    top_reasons = [f"{item['feature']} (impact: {item['importance']})" for item in _shap_importance[:5]]

    decision = decide(fraud_probability, pattern_result, trust_result, image_result, top_reasons)

    return {
        "return_id": return_row["return_id"],
        "customer_id": return_row["customer_id"],
        "order_id": order_row["order_id"],
        "category": order_row["category"],
        "purchase_value": order_row["purchase_value"],
        "reason": return_row["reason"],
        "ground_truth_is_fraud": return_row.get("is_fraud"),
        "suspicious_pattern_score": pattern_result["suspicious_pattern_score"],
        "customer_trust_score": trust_result["customer_trust_score"],
        "image_authenticity_score": image_result["image_authenticity_score"],
        "fraud_probability_pct": decision["fraud_probability_pct"],
        "risk_tier": decision["risk_tier"],
        "reasons": decision["reasons"],
        "top_model_drivers": decision["top_model_drivers"],
        "recommendation": decision["recommendation"],
        "warehouse_review_note": decision["warehouse_review_note"],
        "chat_transcript": chat_row["transcript"],
        "timestamp": return_row["return_date"],
    }
