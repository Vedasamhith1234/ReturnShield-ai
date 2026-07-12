"""
Customer-portal return scoring for live submissions.

Two scoring engines:
- "model": backend/main.py loaded the trained RandomForest/CatBoost
  (models/best_model.joblib) and passes its predicted probability in as
  `model_probability`. This is the normal path.
- "rules_fallback": the trained model was missing/failed to load, so this
  module falls back to the original hand-tuned weighted blend (unchanged from
  before the model was wired in) so the endpoint keeps working, just less
  accurately, with the gap made visible via the returned `scoring_engine` key.

Either way, every rule-based check below (product/brand mismatch, invoice
cross-checks, return-frequency/low-value/stale-return account rules, chat NLP)
still runs and still populates `all_flags`/`reasons_for_customer` — these are
evidence for the analyst and the customer-safe rejection reasons, not the
probability itself once a trained model is available. Two hard overrides
apply regardless of engine: a product/brand mismatch forces a HIGH-risk
reject (it's a fact, not a prediction), and a zero-evidence submission is
never allowed to score as an automatic LOW-risk approval.
"""
import json
import re
from pathlib import Path

from agents.llm_nlp import analyze_conversation_llm
from agents.nlp_agent import analyze_conversation

REPO_ROOT = Path(__file__).resolve().parent.parent
with open(REPO_ROOT / "models" / "thresholds.json") as _f:
    THRESHOLDS = json.load(_f)

HIGH_VALUE_CATEGORIES = {"Electronics", "Phones", "Laptops", "Jewelry"}

KNOWN_BRANDS = [
    "nike", "puma", "adidas", "reebok", "new balance", "under armour",
    "apple", "samsung", "sony", "lg", "levis", "levi's", "gucci", "zara",
    "h&m", "converse", "vans", "asics",
]

# Matches the demo customer account's fixed order history size in
# dashboard/app.js (CUSTOMER_ORDERS.length) — the denominator for the
# return-rate-threshold check. A real deployment would use each customer's
# actual lifetime order count instead of this fixed demo constant.
TOTAL_CUSTOMER_ORDERS = 7


def detect_brand(text: str):
    lower = (text or "").lower()
    for b in KNOWN_BRANDS:
        if b in lower:
            return b.replace("levi's", "levis")
    return None


def _normalize_serial(s: str) -> str:
    """Uppercase + alphanumerics-only, kept in lockstep by hand with
    dashboard/app.js::normalizeSerial (same existing precedent as
    detect_brand/detectBrand living in both places) — so "SN-4F82-K93X" and
    "sn4f82k93x" compare equal regardless of which side introduced the
    formatting difference."""
    return re.sub(r"[^A-Z0-9]", "", (s or "").upper())


def is_prompt_exchange(reason: str, days_since_delivery: int, late_return_days: float) -> bool:
    """A same-day/next-few-days exchange for the wrong size is normal
    shopping (order two sizes, keep the one that fits), not return-frequency
    abuse — even 2-3 times in a row. It only stops being benign once the item
    sits around past late_return_days before being sent back."""
    return reason == "Wrong size / needs exchange" and days_since_delivery <= late_return_days


def _run_nlp(turns: list, excuse_history_count: int):
    """Regex agent is the always-on default; USE_LLM_NLP=1 swaps it for a
    real Claude call, falling back to regex automatically and visibly
    (nlp_engine) on any failure — missing key, network error, bad JSON."""
    if not turns:
        return {"customer_trust_score": 100, "flags": []}, "regex_fallback"
    llm_result = analyze_conversation_llm(turns, excuse_history_count)
    if llm_result is not None:
        return llm_result, "llm"
    return analyze_conversation(turns, excuse_history_count), "regex_fallback"


def _recommendation_for_tier(risk_tier: str, stale_return: bool, zero_evidence: bool,
                              days_since_delivery: int, late_return_days: float) -> str:
    if risk_tier == "HIGH":
        return "Reject return. Escalate to fraud investigation team."
    if risk_tier == "MEDIUM":
        if stale_return:
            return (
                f"Hold for thorough investigation — item was held {days_since_delivery} days before being "
                f"returned, beyond the {late_return_days:.0f}-day prompt-return window. Review pattern, "
                f"chat/NLP, photo, and ML signals together before deciding."
            )
        if zero_evidence:
            return "No verifying evidence (photo, invoice, or conversation) was provided with this request — hold for manual review."
        return "Hold for manual review before approving or rejecting."
    return "Approve return through standard automated processing."


def score_customer_return(body, rules: dict, history: dict, model_probability: float = None) -> dict:
    """body is the CustomerReturnIn pydantic model from backend/main.py.
    rules is db.get_fraud_rules(); history is db.get_customer_history(...)
    BEFORE this submission is recorded (i.e. counts filed so far).
    model_probability: the trained model's predict_proba output (0-1), or
    None if backend/main.py couldn't load the model — triggers the
    rules_fallback blend below instead."""
    order_brand = (body.order_brand or "").lower().replace("levi's", "levis")
    declared_brand = detect_brand(body.item_declared)

    # ---- Serial-number verification: the strongest signal available — an
    # exact identifier disagreement, not a fuzzy brand/category guess — so
    # it's checked before anything else below and wins the cascade outright.
    # Skipped for a self-added order (no inventory record exists to check
    # against) and never escalates to a confirmed mismatch on a low-
    # confidence (non-keyword-anchored) OCR read: that's inconclusive, not
    # proof (see dashboard/app.js::extractSerialNumber for why a keyword-less
    # fallback read can't be trusted as fact — it could just as easily be a
    # barcode digit string or model number sharing the same label).
    mismatch_evidence = None
    serial_mismatch = False
    serial_inconclusive = False
    if not body.is_new_order and body.order_known_serial:
        if not body.detected_serial or not body.serial_confident:
            serial_inconclusive = bool(body.serial_photo_provided)
        elif _normalize_serial(body.detected_serial) != _normalize_serial(body.order_known_serial):
            serial_mismatch = True
            mismatch_evidence = (
                f'Photographed serial number "{body.detected_serial.upper()}" does not match '
                f"this order's serial number on file ({body.order_known_serial})"
            )

    # ---- Product-match verification: three evidence sources, strongest wins ----
    if mismatch_evidence:
        pass  # serial check already won — skip the rest of the cascade
    elif body.photo_detected_brand and body.photo_detected_brand.lower() != order_brand:
        mismatch_evidence = (
            f'Photo shows "{body.photo_detected_brand.upper()}" branding but the order '
            f'is {body.order_brand} ({body.product_ordered})'
        )
    elif body.invoice_brand and body.invoice_brand.lower() != order_brand:
        mismatch_evidence = (
            f'Attached invoice is for a {body.invoice_brand.upper()} product but the order '
            f'is {body.order_brand} ({body.product_ordered})'
        )
    elif declared_brand and declared_brand != order_brand:
        mismatch_evidence = (
            f'Customer states they are returning a {declared_brand.upper()} item but the order '
            f'is {body.order_brand} ({body.product_ordered})'
        )
    elif body.photo_category_mismatch:
        # photo_classified_label is only ever sent when the client-side
        # classifier was confident enough to name a specific object (see
        # dashboard/app.js::checkPhotoAgainstCategory) — a low-confidence
        # guess isn't asserted as fact, just reported as a plain mismatch.
        if body.photo_classified_label:
            mismatch_evidence = (
                f'Photo appears to show a "{body.photo_classified_label}", which doesn\'t match the expected '
                f'{body.category} item ({body.product_ordered})'
            )
        else:
            mismatch_evidence = (
                f'Photo does not appear to match the expected {body.category} item ({body.product_ordered})'
            )

    # ---- Invoice cross-checks ----
    invoice_flags = []
    if body.invoice_attached and body.invoice_total is not None:
        diff_pct = abs(body.invoice_total - body.purchase_value) / max(body.purchase_value, 0.01)
        if diff_pct > 0.15:
            invoice_flags.append(
                f"Invoice total (${body.invoice_total:.2f}) differs from order record "
                f"(${body.purchase_value:.2f}) by {diff_pct * 100:.0f}%"
            )
    if body.invoice_attached and body.invoice_retailer:
        invoice_flags.append(
            f"Invoice issued by {body.invoice_retailer.upper()} — third-party receipt "
            f"attached to this claim (verify purchase channel)"
        )

    # ---- Account-level history: return frequency + repeat low-value pattern ----
    is_low_value = body.purchase_value < rules["low_value_threshold"]
    is_high_value = body.purchase_value > rules["high_value_dropoff_threshold"]
    projected_returns = history["returns_filed"] + 1
    return_rate = projected_returns / TOTAL_CUSTOMER_ORDERS
    exceeds_return_rate = return_rate > rules["return_rate_threshold"]
    projected_low_value = history["low_value_returns_filed"] + (1 if is_low_value else 0)
    is_lenient_low_value = is_low_value and projected_low_value <= rules["low_value_free_passes"]
    is_repeat_low_value_abuse = is_low_value and projected_low_value > rules["low_value_free_passes"]
    prompt_exchange = is_prompt_exchange(body.reason, body.days_since_delivery, rules["late_return_days"])
    stale_return = body.days_since_delivery > rules["late_return_days"]

    # ---- Chat/NLP (Agent 2) ----
    turns = body.chat_turns or ([body.chat_transcript] if body.chat_transcript else [])
    nlp, nlp_engine = _run_nlp(turns, 0)  # matches pre-existing behavior: excuse-history count wasn't threaded in here before either

    # ---- Pattern signals (Agent 1) — always computed as evidence/flags,
    # regardless of which engine sets the final probability. ----
    p_score = 0
    p_flags = []
    if body.category in HIGH_VALUE_CATEGORIES and body.purchase_value > 300:
        p_score += 15
        p_flags.append(f"High-value item return (${body.purchase_value:.2f}, {body.category})")
    if body.days_since_delivery <= 1 and body.reason == "Item never arrived":
        p_score += 15
        p_flags.append("Non-arrival claimed unusually fast after delivery scan")
    if body.days_since_delivery > 30:
        p_score += 10
        p_flags.append(f"Return requested {body.days_since_delivery} days after delivery — outside typical window")
    if exceeds_return_rate:
        if prompt_exchange:
            p_flags.append(
                f"Return frequency {return_rate * 100:.0f}% ({projected_returns}/{TOTAL_CUSTOMER_ORDERS} orders) "
                f"would normally exceed the {rules['return_rate_threshold'] * 100:.0f}% threshold, but this is a "
                f"prompt size exchange (returned within {rules['late_return_days']:.0f} days) — not counted against the account"
            )
        else:
            p_score += 30
            p_flags.append(
                f"Return frequency {return_rate * 100:.0f}% ({projected_returns}/{TOTAL_CUSTOMER_ORDERS} orders) "
                f"exceeds the {rules['return_rate_threshold'] * 100:.0f}% threshold for this account"
            )
    if is_repeat_low_value_abuse and not prompt_exchange:
        p_score += 20
        p_flags.append(
            f"Repeat low-value return pattern — the {projected_low_value} return under "
            f"${rules['low_value_threshold']:.2f} from this account"
        )
    if stale_return:
        p_score += 35
        p_flags.append(
            f"Return initiated {body.days_since_delivery} days after delivery — beyond the "
            f"{rules['late_return_days']:.0f}-day prompt-return window; recommend full multi-agent "
            f"investigation (pattern, chat, photo, ML, and decision review)"
        )

    # ---- Probability: trained model if available, else the legacy hand-tuned blend ----
    if model_probability is not None:
        scoring_engine = "model"
        prob = model_probability
    else:
        scoring_engine = "rules_fallback"
        prob = 0.03
        prob += (p_score / 100) * 0.35
        prob += ((100 - nlp["customer_trust_score"]) / 100) * 0.25
        prob += ((100 - body.photo_score) / 100) * 0.15
        prob += len(invoice_flags) * 0.05
        if body.days_since_delivery <= 1:
            prob += 0.06
        if body.reason == "Item never arrived":
            prob += 0.08

    # ---- Business-policy overrides applied regardless of engine ----
    # These aren't things the trained model can be trusted to represent:
    # mismatch_evidence is a ground-truth fact; the return-rate/low-value
    # thresholds are dynamically configurable per the Fraud Rule Management
    # panel; and — critically — the synthetic training data's fraud archetype
    # for days_before_return is the OPPOSITE of wardrobing (its fraud cases
    # are fast/immediate returns, e.g. non-arrival scams, not held-too-long
    # returns), so the trained model's raw probability actively trends DOWN
    # as days_before_return grows. Without this override, "held past the
    # prompt-return window" — a real signal the customer portal was built to
    # catch — would be silently undetectable once the model engine is active.
    if mismatch_evidence:
        prob = max(prob, 0.92)
    if (exceeds_return_rate or is_repeat_low_value_abuse) and not prompt_exchange:
        prob = max(prob, 0.42)
    if stale_return:
        prob = max(prob, 0.55)
    prob = min(0.98, max(0.01, prob))

    all_flags = []
    if serial_mismatch:
        all_flags.append(f"SERIAL MISMATCH: {mismatch_evidence}")
    elif mismatch_evidence:
        all_flags.append(f"PRODUCT MISMATCH: {mismatch_evidence}")
    if serial_inconclusive:
        all_flags.append("Serial number photo provided but not clearly readable — needs manual verification")
    all_flags += p_flags + nlp["flags"] + list(body.photo_flags) + invoice_flags

    zero_evidence = not body.photo_provided and not body.invoice_attached and not turns

    if serial_mismatch:
        risk_tier = "HIGH"
        recommendation = "Reject return — photographed serial number does not match the order on file. Possible swapped or counterfeit item; escalate to fraud investigation team."
    elif mismatch_evidence:
        risk_tier = "HIGH"
        recommendation = "Reject return — returned item does not match the ordered product. Flag account for wrong-item-return abuse pattern."
    elif prob >= THRESHOLDS["high"]:
        risk_tier = "HIGH"
        recommendation = _recommendation_for_tier(risk_tier, stale_return, zero_evidence,
                                                    body.days_since_delivery, rules["late_return_days"])
    elif prob >= THRESHOLDS["medium"]:
        risk_tier = "MEDIUM"
        recommendation = _recommendation_for_tier(risk_tier, stale_return, zero_evidence,
                                                    body.days_since_delivery, rules["late_return_days"])
    else:
        risk_tier = "LOW"
        recommendation = _recommendation_for_tier(risk_tier, stale_return, zero_evidence,
                                                    body.days_since_delivery, rules["late_return_days"])

    # Inconclusive serial OCR isn't proof of anything — floor at MEDIUM for a
    # human to check, same "can't confirm, can't silently approve" philosophy
    # as the zero-evidence floor below. Never lowers a tier something else
    # already forced to HIGH.
    if serial_inconclusive and risk_tier == "LOW":
        risk_tier = "MEDIUM"
        recommendation = "Hold for manual review — could not clearly verify the serial number from the submitted photo."

    # Hard override, regardless of engine: never let a zero-evidence
    # submission auto-approve as LOW risk.
    if zero_evidence and risk_tier == "LOW":
        risk_tier = "MEDIUM"
        recommendation = _recommendation_for_tier(risk_tier, stale_return, zero_evidence,
                                                    body.days_since_delivery, rules["late_return_days"])

    # ---- Customer-facing rejection reasons (categorical, not exact scores) ----
    reasons_for_customer = []
    if risk_tier == "HIGH":
        if serial_mismatch:
            reasons_for_customer.append(
                "The serial number on the item you photographed doesn't match the serial number associated with this order."
            )
        elif mismatch_evidence:
            reasons_for_customer.append("The photo and/or invoice provided doesn't match the item that was ordered.")
        elif body.photo_flags:
            reasons_for_customer.append(
                "The photo provided didn't clearly verify the item's condition (blurry, too dark, or matched a previous submission)."
            )
        if nlp["flags"]:
            reasons_for_customer.append("The reason and details provided about this return didn't hold up under review.")
        if invoice_flags:
            reasons_for_customer.append("The order value didn't match the receipt/invoice provided.")
        if exceeds_return_rate and not prompt_exchange:
            reasons_for_customer.append("This account has returned an unusually high share of its recent orders.")
        if is_repeat_low_value_abuse and not prompt_exchange:
            reasons_for_customer.append("This account has a repeated pattern of low-value item returns.")
        if stale_return:
            reasons_for_customer.append("This item was held for a while before being returned.")
        if not reasons_for_customer:
            reasons_for_customer.append("Multiple factors in this request didn't meet our automatic approval criteria.")

    return {
        "fraud_probability_pct": round(prob * 1000) / 10,
        "risk_tier": risk_tier,
        "recommendation": recommendation,
        "all_flags": all_flags if all_flags else ["No significant risk indicators detected at intake."],
        "customer_trust_score": nlp["customer_trust_score"],
        "suspicious_pattern_score": min(p_score + (40 if mismatch_evidence else 0), 100),
        "image_authenticity_score": min(body.photo_score, 25) if mismatch_evidence else body.photo_score,
        "is_low_value": is_low_value,
        "is_high_value": is_high_value,
        "is_lenient_low_value": is_lenient_low_value,
        "reasons_for_customer": reasons_for_customer,
        "mismatch_evidence": mismatch_evidence,
        "scoring_engine": scoring_engine,
        "nlp_engine": nlp_engine,
    }
