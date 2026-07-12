"""
Feature Engineering Pipeline
Joins orders + returns + customers into a single ML-ready feature table,
via the shared feature_contract.build_features() used by both training and
live serving.
"""
import json
from pathlib import Path

import pandas as pd

from features.feature_contract import build_features

REPO_ROOT = Path(__file__).resolve().parent.parent
DATA_DIR = REPO_ROOT / "data"


def load_raw():
    with open(DATA_DIR / "customers.json") as f:
        customers = pd.DataFrame(json.load(f))
    with open(DATA_DIR / "orders.json") as f:
        orders = pd.DataFrame(json.load(f))
    with open(DATA_DIR / "returns.json") as f:
        returns = pd.DataFrame(json.load(f))
    with open(DATA_DIR / "chats.json") as f:
        chats = pd.DataFrame(json.load(f))
    with open(DATA_DIR / "images.json") as f:
        images = pd.DataFrame(json.load(f))
    return customers, orders, returns, chats, images


def build_feature_table() -> pd.DataFrame:
    customers, orders, returns, chats, images = load_raw()

    df = returns.merge(orders, on=["order_id", "customer_id"], suffixes=("", "_order"))

    # return_frequency per customer (as of dataset snapshot)
    freq = returns.groupby("customer_id").size().rename("return_frequency")
    df = df.merge(freq, on="customer_id")

    rows = []
    for _, r in df.iterrows():
        order = r.to_dict()
        return_event = r.to_dict()
        customer_history = {"return_frequency": r["return_frequency"]}
        feat_row = build_features(order, return_event, customer_history).iloc[0]
        rows.append(feat_row)
    feat_df = pd.DataFrame(rows).reset_index(drop=True)

    meta_df = df[["return_id", "customer_id", "order_id", "reason", "is_fraud"]].reset_index(drop=True)
    feature_df = pd.concat([meta_df, feat_df], axis=1)
    return feature_df


if __name__ == "__main__":
    table = build_feature_table()
    table.to_parquet(DATA_DIR / "feature_table.parquet", index=False)
    print(table.shape)
    print(table.head())
