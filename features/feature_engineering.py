"""
Feature Engineering Pipeline
Joins orders + returns + customers into a single ML-ready feature table.
"""
import json

import pandas as pd

DATA_DIR = "/home/claude/returnshield/data"

CATEGORY_MAP = {c: i for i, c in enumerate(
    ["Electronics", "Phones", "Laptops", "Apparel", "Shoes",
     "Home & Kitchen", "Beauty", "Toys", "Sporting Goods", "Jewelry"])}
PAYMENT_MAP = {c: i for i, c in enumerate(
    ["credit_card", "debit_card", "paypal", "gift_card", "buy_now_pay_later"])}
WAREHOUSE_MAP = {c: i for i, c in enumerate(["DFW1", "ATL2", "ORD3", "LAX4", "JFK5", "SEA6"])}


def load_raw():
    with open(f"{DATA_DIR}/customers.json") as f:
        customers = pd.DataFrame(json.load(f))
    with open(f"{DATA_DIR}/orders.json") as f:
        orders = pd.DataFrame(json.load(f))
    with open(f"{DATA_DIR}/returns.json") as f:
        returns = pd.DataFrame(json.load(f))
    with open(f"{DATA_DIR}/chats.json") as f:
        chats = pd.DataFrame(json.load(f))
    with open(f"{DATA_DIR}/images.json") as f:
        images = pd.DataFrame(json.load(f))
    return customers, orders, returns, chats, images


FEATURE_COLUMNS = [
    "account_age_days", "purchase_value", "return_frequency", "category_enc",
    "days_before_return", "shipping_distance_km", "payment_type_enc",
    "prior_fraud_flags", "coupon_used", "warehouse_enc", "delivery_time_days",
    "gps_mismatch_km", "addresses_used", "payment_methods_used",
]


def build_feature_table() -> pd.DataFrame:
    customers, orders, returns, chats, images = load_raw()

    df = returns.merge(orders, on=["order_id", "customer_id"], suffixes=("", "_order"))

    # return_frequency per customer (as of dataset snapshot)
    freq = returns.groupby("customer_id").size().rename("return_frequency")
    df = df.merge(freq, on="customer_id")

    df["category_enc"] = df["category"].map(CATEGORY_MAP)
    df["payment_type_enc"] = df["payment_type"].map(PAYMENT_MAP)
    df["warehouse_enc"] = df["warehouse"].map(WAREHOUSE_MAP)
    df["coupon_used"] = df["coupon_used"].astype(int)

    feature_df = df[["return_id", "customer_id", "order_id", "reason", "is_fraud"] + FEATURE_COLUMNS].copy()
    return feature_df


if __name__ == "__main__":
    table = build_feature_table()
    table.to_parquet(f"{DATA_DIR}/feature_table.parquet", index=False)
    print(table.shape)
    print(table.head())
