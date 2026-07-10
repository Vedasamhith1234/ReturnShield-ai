"""
Agent 1 — Pattern Detection Agent
Rule + statistical scoring of behavioral red flags on the customer/account level.
Output: Suspicious Pattern Score (0-100)
"""
from collections import defaultdict


def compute_customer_return_frequency(returns, customer_id):
    return sum(1 for r in returns if r["customer_id"] == customer_id)


def pattern_score(ret: dict, category: str, purchase_value: float,
                   return_frequency: int, is_holiday_period: bool) -> dict:
    score = 0
    flags = []

    # Excessive return frequency
    if return_frequency >= 10:
        score += 30
        flags.append(f"Excessive return frequency ({return_frequency} returns on this account)")
    elif return_frequency >= 5:
        score += 15
        flags.append(f"Elevated return frequency ({return_frequency} returns)")

    # High-value item concentration
    if category in ("Electronics", "Phones", "Laptops", "Jewelry") and purchase_value > 300:
        score += 15
        flags.append(f"Return concentrated on high-value item (${purchase_value:,.2f}, {category})")

    # Holiday abuse window
    if is_holiday_period:
        score += 10
        flags.append("Return filed during known holiday-abuse window")

    # GPS / address mismatch
    if ret["gps_mismatch_km"] > 250:
        score += 20
        flags.append(f"Shipping location mismatch ({ret['gps_mismatch_km']:.0f} km from account home address)")

    # Multiple addresses
    if ret["addresses_used"] >= 3:
        score += 15
        flags.append(f"{ret['addresses_used']} different shipping addresses used on this account")

    # Multiple payment methods
    if ret["payment_methods_used"] >= 3:
        score += 10
        flags.append(f"{ret['payment_methods_used']} different payment methods used")

    # Prior fraud flags
    if ret["prior_fraud_flags"] > 0:
        score += 10 * min(ret["prior_fraud_flags"], 3)
        flags.append(f"{ret['prior_fraud_flags']} prior fraud flag(s) on account")

    score = min(score, 100)
    return {"suspicious_pattern_score": score, "flags": flags}
