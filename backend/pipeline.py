"""
Multi-agent orchestration: runs a single return case through
Pattern Agent -> NLP Agent -> Vision Agent -> ML Fraud Model -> Decision Agent.
"""
import json
import random
from datetime import datetime, timedelta

import joblib
import pandas as pd

from agents.decision_agent import decide
from agents.nlp_agent import analyze_transcript
from agents.pattern_agent import pattern_score
from agents.vision_agent import analyze_image_meta
from features.feature_engineering import FEATURE_COLUMNS, CATEGORY_MAP, PAYMENT_MAP, WAREHOUSE_MAP

MODEL_PATH = "/home/claude/returnshield/models/best_model.joblib"
SHAP_PATH = "/home/claude/returnshield/models/shap_feature_importance.json"

_model = joblib.load(MODEL_PATH)
with open(SHAP_PATH) as f:
    _shap_importance = json.load(f)

HOLIDAY_MONTHS = {11, 12, 1}


def run_case(return_row: dict, order_row: dict, chat_row: dict, image_row: dict, return_frequency: int) -> dict:
    features = {
        "account_age_days": return_row["account_age_days"],
        "purchase_value": order_row["purchase_value"],
        "return_frequency": return_frequency,
        "category_enc": CATEGORY_MAP.get(order_row["category"], 0),
        "days_before_return": return_row["days_before_return"],
        "shipping_distance_km": order_row["shipping_distance_km"],
        "payment_type_enc": PAYMENT_MAP.get(order_row["payment_type"], 0),
        "prior_fraud_flags": return_row["prior_fraud_flags"],
        "coupon_used": int(order_row["coupon_used"]),
        "warehouse_enc": WAREHOUSE_MAP.get(order_row["warehouse"], 0),
        "delivery_time_days": order_row["delivery_time_days"],
        "gps_mismatch_km": return_row["gps_mismatch_km"],
        "addresses_used": return_row["addresses_used"],
        "payment_methods_used": return_row["payment_methods_used"],
    }
    X = pd.DataFrame([features])[FEATURE_COLUMNS]
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
