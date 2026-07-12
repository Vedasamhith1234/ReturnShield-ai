"""
Single feature contract shared by both scoring pipelines:

- Pipeline A (backend/pipeline.py::run_case, models/train_models.py) scores/trains
  on the synthetic dataset, where every one of the 14 FEATURE_COLUMNS is always
  present on the raw order/return rows.
- Pipeline B (backend/main.py::submit_customer_return, the live Customer Portal)
  only has real data for 4 of the 14: category, purchase_value, days_before_return
  (days since delivery), and return_frequency (from stored customer history). The
  other 10 have no live equivalent at intake time and fall back to
  INTAKE_UNKNOWN_DEFAULTS.

build_features() is the ONLY place either pipeline should construct a feature row
— this is what keeps training and serving from silently drifting apart.
"""
import json
from pathlib import Path

import pandas as pd

REPO_ROOT = Path(__file__).resolve().parent.parent
ENCODERS_PATH = REPO_ROOT / "models" / "encoders.json"

FEATURE_COLUMNS = [
    "account_age_days", "purchase_value", "return_frequency", "category_enc",
    "days_before_return", "shipping_distance_km", "payment_type_enc",
    "prior_fraud_flags", "coupon_used", "warehouse_enc", "delivery_time_days",
    "gps_mismatch_km", "addresses_used", "payment_methods_used",
]

CATEGORY_MAP = {c: i for i, c in enumerate(
    ["Electronics", "Phones", "Laptops", "Apparel", "Shoes",
     "Home & Kitchen", "Beauty", "Toys", "Sporting Goods", "Jewelry"])}
PAYMENT_MAP = {c: i for i, c in enumerate(
    ["credit_card", "debit_card", "paypal", "gift_card", "buy_now_pay_later"])}
WAREHOUSE_MAP = {c: i for i, c in enumerate(["DFW1", "ATL2", "ORD3", "LAX4", "JFK5", "SEA6"])}

# The 10 columns with no live-intake equivalent, and what they default to when
# missing. Not all zero: zero would misrepresent "1 address used" or "1 payment
# method used" as suspicious-looking absence-of-data. account_age_days,
# shipping_distance_km, and delivery_time_days use the synthetic dataset's
# median (data/feature_table.parquet); payment_type_enc/warehouse_enc use the
# most frequent encoded value; coupon_used/prior_fraud_flags/gps_mismatch_km
# default to "none of this happened", which is the correct neutral prior.
INTAKE_UNKNOWN_DEFAULTS = {
    "account_age_days": 1014.0,       # dataset median
    "shipping_distance_km": 2015.7,   # dataset median
    "payment_type_enc": 4,            # most frequent payment_type, encoded
    "prior_fraud_flags": 0,
    "coupon_used": 0,                 # dataset mode
    "warehouse_enc": 3,                # most frequent warehouse, encoded
    "delivery_time_days": 4.0,        # dataset median
    "gps_mismatch_km": 0.0,
    "addresses_used": 1,              # realistic single-address case, not 0
    "payment_methods_used": 1,        # realistic single-payment-method case, not 0
}

# Columns intentionally NOT in INTAKE_UNKNOWN_DEFAULTS have real live data:
# purchase_value, category_enc, days_before_return, return_frequency.
LIVE_UNKNOWN_COLUMNS = list(INTAKE_UNKNOWN_DEFAULTS.keys())


def _write_encoders_if_missing():
    if ENCODERS_PATH.exists():
        return
    ENCODERS_PATH.parent.mkdir(parents=True, exist_ok=True)
    with open(ENCODERS_PATH, "w") as f:
        json.dump(
            {"category": CATEGORY_MAP, "payment_type": PAYMENT_MAP, "warehouse": WAREHOUSE_MAP},
            f, indent=2,
        )


_write_encoders_if_missing()


def build_features(order: dict, return_event: dict, customer_history: dict) -> pd.DataFrame:
    """order/return_event/customer_history are loosely-typed dicts. Training
    callers pass rows that already carry every raw field (synthetic dataset).
    The live serving caller (backend/main.py) passes only what a customer
    submission and stored history actually provide — everything else is
    filled from INTAKE_UNKNOWN_DEFAULTS, never left missing or guessed ad hoc.
    """
    row = {
        "account_age_days": return_event.get("account_age_days", INTAKE_UNKNOWN_DEFAULTS["account_age_days"]),
        "purchase_value": order.get("purchase_value", 0.0),
        "return_frequency": customer_history.get("return_frequency", 0),
        "category_enc": CATEGORY_MAP.get(order.get("category"), 0),
        "days_before_return": return_event.get("days_before_return", 0),
        "shipping_distance_km": order.get("shipping_distance_km", INTAKE_UNKNOWN_DEFAULTS["shipping_distance_km"]),
        "payment_type_enc": PAYMENT_MAP.get(order.get("payment_type"), INTAKE_UNKNOWN_DEFAULTS["payment_type_enc"]),
        "prior_fraud_flags": return_event.get("prior_fraud_flags", INTAKE_UNKNOWN_DEFAULTS["prior_fraud_flags"]),
        "coupon_used": int(order.get("coupon_used", INTAKE_UNKNOWN_DEFAULTS["coupon_used"])),
        "warehouse_enc": WAREHOUSE_MAP.get(order.get("warehouse"), INTAKE_UNKNOWN_DEFAULTS["warehouse_enc"]),
        "delivery_time_days": order.get("delivery_time_days", INTAKE_UNKNOWN_DEFAULTS["delivery_time_days"]),
        "gps_mismatch_km": return_event.get("gps_mismatch_km", INTAKE_UNKNOWN_DEFAULTS["gps_mismatch_km"]),
        "addresses_used": return_event.get("addresses_used", INTAKE_UNKNOWN_DEFAULTS["addresses_used"]),
        "payment_methods_used": return_event.get("payment_methods_used", INTAKE_UNKNOWN_DEFAULTS["payment_methods_used"]),
    }
    return pd.DataFrame([row])[FEATURE_COLUMNS]


def mask_intake_unknown(df: pd.DataFrame, mask_prob: float = 0.3, random_state: int = 42) -> pd.DataFrame:
    """Training-only helper: for a random subset of rows, overwrite the 10
    no-live-signal columns with their INTAKE_UNKNOWN_DEFAULTS value, so the
    trained model learns not to over-rely on data that's always absent at
    live customer-portal intake time. Applied before the train/test split in
    models/train_models.py."""
    import numpy as np
    rng = np.random.RandomState(random_state)
    df = df.copy()
    mask = rng.rand(len(df)) < mask_prob
    for col in LIVE_UNKNOWN_COLUMNS:
        if col in df.columns:
            df.loc[mask, col] = INTAKE_UNKNOWN_DEFAULTS[col]
    return df
