"""
Weekly analyst-feedback retraining cycle.

Analyst approve/reject decisions on live Customer Portal cases (recorded via
backend/main.py::add_comment into the labeled_outcomes table) become new
training examples here, appended (weighted, see LABEL_WEIGHT) to the
synthetic dataset's training split. A retrain only replaces
models/best_model.joblib if its F1 on a FIXED held-out synthetic test set is
at least as good as the current production model's — evaluated fresh every
cycle, never off a stale stored number — so a bad week of noisy analyst
labels can't silently regress production. Non-promoted candidates are
archived, never discarded.

Triggered from backend/main.py two ways: an in-process hourly check (best-
effort — a Fly.io machine scaled to zero won't run it) and POST
/api/admin/retrain (used by the GitHub Actions weekly cron so this actually
fires every week regardless of machine sleep state). Both call
run_retrain_cycle(); the "is a week actually up" decision lives in exactly
one place so it can't drift between the two triggers.
"""
import json
import os
import time
from datetime import datetime, timezone
from pathlib import Path

import joblib
import pandas as pd
from sklearn.metrics import f1_score
from sklearn.model_selection import train_test_split

from backend import db
from features.feature_contract import FEATURE_COLUMNS, mask_intake_unknown
from features.feature_engineering import build_feature_table
from models.train_models import fit_and_select

REPO_ROOT = Path(__file__).resolve().parent.parent
MODEL_DIR = Path(os.environ.get("RETURNSHIELD_MODEL_DIR", REPO_ROOT / "models"))
REGISTRY_PATH = MODEL_DIR / "registry.json"
CANDIDATES_DIR = MODEL_DIR / "candidates"
LOCK_PATH = MODEL_DIR / ".retrain.lock"
BEST_MODEL_PATH = MODEL_DIR / "best_model.joblib"

RETRAIN_INTERVAL_DAYS = 7
LOCK_STALE_SECONDS = 30 * 60
DEFAULT_MIN_NEW_LABELS = int(os.environ.get("RETRAIN_MIN_NEW_LABELS", "3"))
LABEL_WEIGHT = 3  # duplicate each analyst-labeled row this many times in training


class AlreadyRunningError(Exception):
    pass


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _load_registry() -> list:
    if not REGISTRY_PATH.exists():
        return []
    with open(REGISTRY_PATH) as f:
        return json.load(f)


def _save_registry(entries: list):
    MODEL_DIR.mkdir(parents=True, exist_ok=True)
    with open(REGISTRY_PATH, "w") as f:
        json.dump(entries, f, indent=2)


def _last_completed_run(registry: list):
    for entry in reversed(registry):
        if entry.get("status") == "completed":
            return entry
    return None


class _RetrainLock:
    """Cross-process advisory lock via atomic file creation — guards the
    in-process hourly timer racing an externally-triggered API call.
    Recovers from a crashed prior run via a staleness timeout instead of
    hanging forever on a stale lock file."""

    def __enter__(self):
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        if LOCK_PATH.exists():
            age = time.time() - LOCK_PATH.stat().st_mtime
            if age < LOCK_STALE_SECONDS:
                raise AlreadyRunningError()
            LOCK_PATH.unlink()  # stale — a prior run crashed without releasing it
        fd = os.open(LOCK_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        os.close(fd)
        return self

    def __exit__(self, *exc_info):
        LOCK_PATH.unlink(missing_ok=True)


def _reconstruct_labeled_frame(outcomes: list):
    """outcomes: list of {feature_json: {...14 cols...}, is_fraud: bool, ...}
    from db.get_labeled_outcomes(). Each row is duplicated LABEL_WEIGHT times
    — a cheap stand-in for a real sample-weight vector, matching the 3x
    inspiration from the original feedback-loop spec."""
    rows, labels = [], []
    for o in outcomes:
        for _ in range(LABEL_WEIGHT):
            rows.append(o["feature_json"])
            labels.append(int(o["is_fraud"]))
    if not rows:
        return pd.DataFrame(columns=FEATURE_COLUMNS), pd.Series(dtype=int)
    return pd.DataFrame(rows)[FEATURE_COLUMNS], pd.Series(labels)


def run_retrain_cycle(trigger: str, force: bool = False, min_new_labels: int = None) -> dict:
    """trigger: "in_process_timer" | "api" | "manual" — recorded in the
    registry, not otherwise behavior-affecting. force=True bypasses both the
    7-day gate and the minimum-new-labels gate (used by the admin endpoint
    for on-demand/manual runs and by tests)."""
    min_new_labels = DEFAULT_MIN_NEW_LABELS if min_new_labels is None else min_new_labels
    started_at = _now_iso()

    try:
        with _RetrainLock():
            registry = _load_registry()
            last_run = _last_completed_run(registry)

            if not force and last_run is not None:
                elapsed_days = (datetime.now(timezone.utc) - datetime.fromisoformat(last_run["finished_at"])).days
                if elapsed_days < RETRAIN_INTERVAL_DAYS:
                    return {"status": "skipped", "reason": "not_due", "trigger": trigger}

            since = last_run["finished_at"] if last_run else None
            new_count = db.count_labeled_outcomes(since=since)
            total_count = db.count_labeled_outcomes()

            if not force and new_count < min_new_labels:
                entry = {
                    "run_id": started_at, "trigger": trigger,
                    "started_at": started_at, "finished_at": _now_iso(),
                    "status": "skipped", "skipped_reason": "insufficient_new_labels",
                    "labeled_outcome_count_total": total_count,
                    "new_labeled_outcome_count": new_count,
                    "promoted": False,
                }
                registry.append(entry)
                _save_registry(registry)
                return entry

            # Fixed synthetic split — same random_state every cycle, so the
            # held-out test rows (and therefore F1 comparisons) stay
            # consistent week over week.
            df = build_feature_table()
            df = mask_intake_unknown(df, mask_prob=0.3)
            X = df[FEATURE_COLUMNS]
            y = df["is_fraud"].astype(int)
            X_train, X_test, y_train, y_test = train_test_split(
                X, y, test_size=0.2, random_state=42, stratify=y)

            # Augment TRAINING ONLY with analyst-labeled outcomes — never the
            # test split. Labeled data is scarce/valuable; the test set must
            # stay fixed for a fair week-over-week comparison.
            outcomes = db.get_labeled_outcomes()
            X_labeled, y_labeled = _reconstruct_labeled_frame(outcomes)
            if len(X_labeled):
                X_train_aug = pd.concat([X_train, X_labeled], ignore_index=True)
                y_train_aug = pd.concat([y_train, y_labeled], ignore_index=True)
            else:
                X_train_aug, y_train_aug = X_train, y_train

            candidate_model, candidate_name, candidate_results = fit_and_select(
                X_train_aug, y_train_aug, X_test, y_test)
            candidate_f1 = candidate_results[candidate_name]["f1"]

            # Re-score the CURRENT production model fresh, on this same test
            # split — never trust a stale stored metric.
            if BEST_MODEL_PATH.exists():
                production_model = joblib.load(BEST_MODEL_PATH)
                # Rounded to match candidate_f1's precision (fit_and_select
                # rounds to 4 decimals) — comparing a rounded value against
                # an unrounded one would make "promoted" spuriously false
                # for two models of genuinely identical performance.
                production_f1 = round(f1_score(y_test, production_model.predict(X_test), zero_division=0), 4)
            else:
                production_f1 = -1.0  # bootstrap: nothing to beat yet, always promote

            CANDIDATES_DIR.mkdir(parents=True, exist_ok=True)
            candidate_path = CANDIDATES_DIR / f"{started_at.replace(':', '-')}.joblib"
            joblib.dump(candidate_model, candidate_path)

            promoted = candidate_f1 >= production_f1
            if promoted:
                tmp_path = MODEL_DIR / ".best_model.joblib.tmp"
                joblib.dump(candidate_model, tmp_path)
                os.replace(tmp_path, BEST_MODEL_PATH)  # atomic — no reader ever sees a torn file

            entry = {
                "run_id": started_at, "trigger": trigger,
                "started_at": started_at, "finished_at": _now_iso(),
                "status": "completed", "skipped_reason": None,
                "labeled_outcome_count_total": total_count,
                "new_labeled_outcome_count": new_count,
                "candidate_model": candidate_name,
                "candidate_f1": candidate_f1,
                "production_f1_before": production_f1,
                "promoted": promoted,
                "candidate_path": str(candidate_path),
                "promoted_model_path": str(BEST_MODEL_PATH) if promoted else None,
                "error": None,
            }
            registry.append(entry)
            _save_registry(registry)
            return entry
    except AlreadyRunningError:
        return {"status": "skipped", "reason": "already_running", "trigger": trigger}
    except Exception as e:
        registry = _load_registry()
        entry = {
            "run_id": started_at, "trigger": trigger,
            "started_at": started_at, "finished_at": _now_iso(),
            "status": "error", "error": str(e), "promoted": False,
        }
        registry.append(entry)
        _save_registry(registry)
        raise
