"""
Agent 4 — Fraud Prediction Model
Trains and benchmarks Random Forest, XGBoost, LightGBM, and CatBoost on the
engineered feature table, then selects the best model by F1 score and
computes SHAP values for explainability.
"""
import json
from pathlib import Path

import joblib
import numpy as np
import pandas as pd
import shap
from catboost import CatBoostClassifier
from sklearn.ensemble import RandomForestClassifier
from sklearn.metrics import (accuracy_score, f1_score, precision_score,
                              recall_score, roc_auc_score, confusion_matrix)
from sklearn.model_selection import train_test_split

# XGBoost's and LightGBM's native libs both require the OpenMP runtime
# (libomp), which isn't installed on every machine (e.g. no Homebrew on
# macOS). Degrade to skipping whichever candidate is unavailable rather than
# fail the whole training run — RandomForest/CatBoost don't need it.
try:
    from xgboost import XGBClassifier
except Exception as _xgb_err:
    XGBClassifier = None
    print(f"XGBoost unavailable, skipping this candidate: {_xgb_err}")

try:
    from lightgbm import LGBMClassifier
except Exception as _lgbm_err:
    LGBMClassifier = None
    print(f"LightGBM unavailable, skipping this candidate: {_lgbm_err}")

from features.feature_engineering import build_feature_table
from features.feature_contract import FEATURE_COLUMNS, mask_intake_unknown

REPO_ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = REPO_ROOT / "models"


def fit_and_select(X_train, y_train, X_test, y_test):
    """Constructs the candidate models, fits each on (X_train, y_train),
    scores each on (X_test, y_test), and picks the best by F1. Shared by the
    from-scratch CLI training path (train_and_compare, below) and the weekly
    analyst-feedback retrain path (models/retrain.py) so the candidate set
    and selection rule can never silently drift between the two."""
    models = {
        "Random Forest": RandomForestClassifier(
            n_estimators=300, max_depth=8, class_weight="balanced", random_state=42, n_jobs=-1),
        "CatBoost": CatBoostClassifier(
            iterations=300, depth=6, learning_rate=0.08,
            auto_class_weights="Balanced", random_state=42, verbose=False),
    }
    if XGBClassifier is not None:
        models["XGBoost"] = XGBClassifier(
            n_estimators=300, max_depth=5, learning_rate=0.08,
            scale_pos_weight=(y_train == 0).sum() / max((y_train == 1).sum(), 1),
            eval_metric="logloss", random_state=42, use_label_encoder=False)
    if LGBMClassifier is not None:
        models["LightGBM"] = LGBMClassifier(
            n_estimators=300, max_depth=6, learning_rate=0.08,
            class_weight="balanced", random_state=42, verbosity=-1)

    results = {}
    fitted = {}
    for name, model in models.items():
        model.fit(X_train, y_train)
        preds = model.predict(X_test)
        probs = model.predict_proba(X_test)[:, 1]
        cm = confusion_matrix(y_test, preds).tolist()
        results[name] = {
            "accuracy": round(accuracy_score(y_test, preds), 4),
            "precision": round(precision_score(y_test, preds, zero_division=0), 4),
            "recall": round(recall_score(y_test, preds, zero_division=0), 4),
            "f1": round(f1_score(y_test, preds, zero_division=0), 4),
            "roc_auc": round(roc_auc_score(y_test, probs), 4),
            "confusion_matrix": cm,  # [[TN, FP], [FN, TP]]
        }
        fitted[name] = model
        print(f"{name}: {results[name]}")

    best_name = max(results, key=lambda n: results[n]["f1"])
    best_model = fitted[best_name]
    print(f"\nBest model by F1: {best_name}")
    return best_model, best_name, results


def train_and_compare():
    df = build_feature_table()
    # Mask the 10 columns the live Customer Portal has no real data for, on a
    # random subset of training rows, so the model doesn't overfit to always
    # having GPS/address/payment-method/account-age/prior-fraud signal that
    # won't exist at live intake time (see features/feature_contract.py).
    df = mask_intake_unknown(df, mask_prob=0.3)
    X = df[FEATURE_COLUMNS]
    y = df["is_fraud"].astype(int)

    X_train, X_test, y_train, y_test = train_test_split(
        X, y, test_size=0.2, random_state=42, stratify=y)

    best_model, best_name, results = fit_and_select(X_train, y_train, X_test, y_test)

    joblib.dump(best_model, f"{MODEL_DIR}/best_model.joblib")
    with open(f"{MODEL_DIR}/model_comparison.json", "w") as f:
        json.dump({"results": results, "best_model": best_name}, f, indent=2)

    # SHAP explainability on a sample of the test set
    explainer_sample = X_test.sample(n=min(300, len(X_test)), random_state=42)
    explainer = shap.TreeExplainer(best_model)
    sv = explainer.shap_values(explainer_sample)
    if isinstance(sv, list):
        sv = sv[1] if len(sv) > 1 else sv[0]
    sv = np.array(sv)
    if sv.ndim == 3:  # (n_samples, n_features, n_classes)
        sv = sv[:, :, 1] if sv.shape[2] > 1 else sv[:, :, 0]

    mean_abs_shap = np.abs(sv).mean(axis=0).flatten()
    importance = sorted(
        zip(FEATURE_COLUMNS, mean_abs_shap.tolist()),
        key=lambda x: x[1], reverse=True)
    with open(f"{MODEL_DIR}/shap_feature_importance.json", "w") as f:
        json.dump([{"feature": f, "importance": round(v, 5)} for f, v in importance], f, indent=2)

    print("\nTop SHAP features:")
    for f, v in importance[:8]:
        print(f"  {f}: {v:.4f}")

    # Business impact estimate (based on test set + typical AOV)
    best = results[best_name]
    n_returns_per_year = 2_000_000  # illustrative scale assumption, stated explicitly
    fraud_rate = float(y.mean())
    avg_fraud_value = float(df.loc[df["is_fraud"] == 1, "purchase_value"].mean())
    est_fraud_cases_per_year = n_returns_per_year * fraud_rate
    fraud_caught = est_fraud_cases_per_year * best["recall"]
    fraud_value_prevented = fraud_caught * avg_fraud_value
    false_positive_rate = best["confusion_matrix"][0][1] / max(sum(best["confusion_matrix"][0]), 1)
    legit_returns_per_year = n_returns_per_year * (1 - fraud_rate)
    false_positives_per_year = legit_returns_per_year * false_positive_rate
    review_minutes_saved = est_fraud_cases_per_year * best["recall"] * 12  # 12 min manual review avoided

    business_impact = {
        "assumptions": {
            "illustrative_annual_return_volume": n_returns_per_year,
            "observed_fraud_rate_in_data": round(fraud_rate, 4),
            "avg_fraudulent_return_value_usd": round(avg_fraud_value, 2),
        },
        "estimated_annual_fraud_value_prevented_usd": round(fraud_value_prevented, 2),
        "estimated_false_positive_cases_per_year": round(false_positives_per_year),
        "estimated_manual_review_minutes_saved_per_year": round(review_minutes_saved),
        "model_used_for_estimate": best_name,
    }
    with open(f"{MODEL_DIR}/business_impact.json", "w") as f:
        json.dump(business_impact, f, indent=2)

    print("\nBusiness impact estimate:")
    print(json.dumps(business_impact, indent=2))

    return results, best_name


if __name__ == "__main__":
    train_and_compare()
