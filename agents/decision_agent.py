"""
Agent 5 — Decision Agent
Synthesizes Pattern Score, Trust Score, Image Score, ML Fraud Probability, and
SHAP-driven reasons into a final natural-language recommendation.

Reference implementation is template-based so it runs fully offline and
deterministically for the demo. In production, swap `decide` to call an LLM
(Claude) with the same structured inputs for richer, more nuanced narrative
summaries — the function signature is already shaped for that swap.
"""


def decide(fraud_probability: float, pattern_result: dict, trust_result: dict,
           image_result: dict, top_shap_reasons: list) -> dict:
    all_flags = []
    all_flags.extend(pattern_result.get("flags", []))
    all_flags.extend(trust_result.get("flags", []))
    all_flags.extend(image_result.get("flags", []))

    if fraud_probability >= 0.75:
        recommendation = "Reject return. Escalate to fraud investigation team."
        risk_tier = "HIGH"
    elif fraud_probability >= 0.40:
        recommendation = "Hold for manual review before approving or rejecting."
        risk_tier = "MEDIUM"
    else:
        recommendation = "Approve return through standard automated processing."
        risk_tier = "LOW"

    # Warehouse-involvement heuristic: flagged for human review only, never auto-accused
    warehouse_flag = None
    if image_result.get("image_authenticity_score", 100) < 50 and pattern_result.get("suspicious_pattern_score", 0) < 30:
        warehouse_flag = ("Item/photo inconsistency without matching customer-side risk signals — "
                           "recommend checking warehouse handling/fulfillment logs for this SKU as a routine review step.")

    return {
        "fraud_probability_pct": round(fraud_probability * 100, 1),
        "risk_tier": risk_tier,
        "reasons": all_flags if all_flags else ["No significant risk indicators detected."],
        "top_model_drivers": top_shap_reasons,
        "recommendation": recommendation,
        "warehouse_review_note": warehouse_flag,
    }
