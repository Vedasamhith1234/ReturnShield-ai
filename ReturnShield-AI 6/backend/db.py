"""
SQLite persistence for ReturnShield AI.

File-based (backend/returnshield.db) — no database server to install or run,
but genuinely durable: restarting `uvicorn` no longer resets cases, comments,
the audit log, customer return history, or fraud rule edits. Replaces the
in-memory _CASE_CACHE / _COMMENTS dicts that used to reset on every restart.
"""
import json
import os
import sqlite3
from contextlib import contextmanager
from pathlib import Path

_DEFAULT_DB_PATH = Path(__file__).resolve().parent / "returnshield.db"
DB_PATH = Path(os.environ["RETURNSHIELD_DB_PATH"]) if os.environ.get("RETURNSHIELD_DB_PATH") else _DEFAULT_DB_PATH

SCHEMA = """
CREATE TABLE IF NOT EXISTS cases (
    return_id TEXT PRIMARY KEY,
    customer_id TEXT,
    customer_name TEXT,
    scoring_engine TEXT,
    nlp_engine TEXT,
    order_id TEXT,
    category TEXT,
    purchase_value REAL,
    reason TEXT,
    product_ordered TEXT,
    item_declared TEXT,
    photo_data_url TEXT,
    serial_photo_data_url TEXT,
    serial_ocr TEXT,
    invoice_attached INTEGER,
    invoice_data_url TEXT,
    invoice_ocr TEXT,
    ground_truth_is_fraud INTEGER,
    suspicious_pattern_score REAL,
    customer_trust_score REAL,
    image_authenticity_score REAL,
    fraud_probability_pct REAL,
    risk_tier TEXT,
    reasons TEXT,
    top_model_drivers TEXT,
    recommendation TEXT,
    warehouse_review_note TEXT,
    chat_transcript TEXT,
    timestamp TEXT,
    source TEXT
);

CREATE TABLE IF NOT EXISTS customer_history (
    customer_id TEXT PRIMARY KEY,
    returns_filed INTEGER NOT NULL DEFAULT 0,
    low_value_returns_filed INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    return_id TEXT NOT NULL,
    author TEXT,
    text TEXT,
    action TEXT,
    timestamp TEXT
);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT,
    type TEXT,
    text TEXT,
    actor TEXT
);

CREATE TABLE IF NOT EXISTS fraud_rules (
    key TEXT PRIMARY KEY,
    value REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS labeled_outcomes (
    return_id TEXT PRIMARY KEY,
    is_fraud INTEGER NOT NULL,
    feature_json TEXT NOT NULL,
    action TEXT NOT NULL,
    labeled_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);
"""

# Mirrors dashboard/app.js's FRAUD_RULES defaults exactly.
DEFAULT_FRAUD_RULES = {
    "return_rate_threshold": 0.30,
    "low_value_threshold": 10.0,
    "low_value_free_passes": 2,
    "high_value_dropoff_threshold": 500.0,
    "repeat_return_flag_count": 3,
    "late_return_days": 7,
}

JSON_FIELDS = ("reasons", "top_model_drivers")


@contextmanager
def get_conn():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    # WAL mode lets a brief background read (e.g. the weekly retrain job
    # scanning cases/comments/labeled_outcomes) proceed concurrently with a
    # live write (a customer submitting a return) instead of blocking on it.
    conn.execute("PRAGMA journal_mode=WAL")
    try:
        yield conn
        conn.commit()
    finally:
        conn.close()


def init_db():
    with get_conn() as conn:
        conn.executescript(SCHEMA)
        # Lightweight migration: CREATE TABLE IF NOT EXISTS above won't add
        # new columns to a cases table that already exists from before this
        # column was introduced — add it if missing so an existing
        # returnshield.db from an earlier run of this app keeps working.
        existing_cols = {row["name"] for row in conn.execute("PRAGMA table_info(cases)")}
        if "customer_name" not in existing_cols:
            conn.execute("ALTER TABLE cases ADD COLUMN customer_name TEXT")
        if "scoring_engine" not in existing_cols:
            conn.execute("ALTER TABLE cases ADD COLUMN scoring_engine TEXT")
        if "nlp_engine" not in existing_cols:
            conn.execute("ALTER TABLE cases ADD COLUMN nlp_engine TEXT")
        if "model_features" not in existing_cols:
            conn.execute("ALTER TABLE cases ADD COLUMN model_features TEXT")
        if "model_probability" not in existing_cols:
            conn.execute("ALTER TABLE cases ADD COLUMN model_probability REAL")
        if "serial_photo_data_url" not in existing_cols:
            conn.execute("ALTER TABLE cases ADD COLUMN serial_photo_data_url TEXT")
        if "serial_ocr" not in existing_cols:
            conn.execute("ALTER TABLE cases ADD COLUMN serial_ocr TEXT")
        existing = {row["key"] for row in conn.execute("SELECT key FROM fraud_rules")}
        for key, value in DEFAULT_FRAUD_RULES.items():
            if key not in existing:
                conn.execute("INSERT INTO fraud_rules (key, value) VALUES (?, ?)", (key, value))


def case_count() -> int:
    with get_conn() as conn:
        return conn.execute("SELECT COUNT(*) AS n FROM cases").fetchone()["n"]


def _row_to_case(row) -> dict:
    d = dict(row)
    d["invoice_attached"] = bool(d["invoice_attached"])
    if d["ground_truth_is_fraud"] is not None:
        d["ground_truth_is_fraud"] = bool(d["ground_truth_is_fraud"])
    d["invoice_ocr"] = json.loads(d["invoice_ocr"]) if d["invoice_ocr"] else None
    if "serial_ocr" in d:
        d["serial_ocr"] = json.loads(d["serial_ocr"]) if d["serial_ocr"] else None
    # Nullable JSON object, not a list — stays None when absent rather than
    # defaulting to [] like JSON_FIELDS below (that default is right for a
    # "list of flags", wrong for "the feature vector this case was scored
    # with", where None means "not available for retraining", not "empty").
    if "model_features" in d:
        d["model_features"] = json.loads(d["model_features"]) if d["model_features"] else None
    for field in JSON_FIELDS:
        d[field] = json.loads(d[field]) if d[field] else []
    return d


def insert_case(case: dict):
    """Upserts a case (INSERT OR REPLACE) — used both for seeding and for
    live customer/simulated submissions, so resubmitting the same return_id
    (shouldn't normally happen) doesn't crash on a PK collision."""
    row = dict(case)
    row["invoice_attached"] = int(bool(row.get("invoice_attached")))
    gtf = row.get("ground_truth_is_fraud")
    row["ground_truth_is_fraud"] = None if gtf is None else int(bool(gtf))
    row["invoice_ocr"] = json.dumps(row["invoice_ocr"]) if row.get("invoice_ocr") else None
    if "serial_ocr" in row:
        row["serial_ocr"] = json.dumps(row["serial_ocr"]) if row.get("serial_ocr") else None
    if "model_features" in row:
        row["model_features"] = json.dumps(row["model_features"]) if row.get("model_features") else None
    for field in JSON_FIELDS:
        row[field] = json.dumps(row.get(field) or [])
    cols = list(row.keys())
    placeholders = ", ".join("?" for _ in cols)
    with get_conn() as conn:
        conn.execute(
            f"INSERT OR REPLACE INTO cases ({', '.join(cols)}) VALUES ({placeholders})",
            [row[c] for c in cols],
        )


def get_cases(limit: int = 200, risk_tier: str = None, source: str = None, q: str = None) -> list:
    query = "SELECT * FROM cases WHERE 1=1"
    params = []
    if risk_tier:
        query += " AND risk_tier = ?"
        params.append(risk_tier)
    if source == "customer":
        query += " AND source = 'customer'"
    elif source == "synthetic":
        query += " AND (source IS NULL OR source != 'customer')"
    if q:
        query += " AND (return_id LIKE ? OR customer_id LIKE ? OR reason LIKE ? OR chat_transcript LIKE ?)"
        like = f"%{q}%"
        params += [like, like, like, like]
    query += " ORDER BY timestamp DESC LIMIT ?"
    params.append(limit)
    with get_conn() as conn:
        return [_row_to_case(r) for r in conn.execute(query, params)]


def get_case(return_id: str):
    with get_conn() as conn:
        row = conn.execute("SELECT * FROM cases WHERE return_id = ?", (return_id,)).fetchone()
        return _row_to_case(row) if row else None


def get_customer_history(customer_id: str) -> dict:
    with get_conn() as conn:
        row = conn.execute(
            "SELECT returns_filed, low_value_returns_filed FROM customer_history WHERE customer_id = ?",
            (customer_id,),
        ).fetchone()
        if row:
            return dict(row)
        return {"returns_filed": 0, "low_value_returns_filed": 0}


def record_customer_return(customer_id: str, is_low_value: bool) -> dict:
    current = get_customer_history(customer_id)
    returns_filed = current["returns_filed"] + 1
    low_value_returns_filed = current["low_value_returns_filed"] + (1 if is_low_value else 0)
    with get_conn() as conn:
        conn.execute(
            """INSERT INTO customer_history (customer_id, returns_filed, low_value_returns_filed)
               VALUES (?, ?, ?)
               ON CONFLICT(customer_id) DO UPDATE SET
                 returns_filed = excluded.returns_filed,
                 low_value_returns_filed = excluded.low_value_returns_filed""",
            (customer_id, returns_filed, low_value_returns_filed),
        )
    return {"returns_filed": returns_filed, "low_value_returns_filed": low_value_returns_filed}


def get_fraud_rules() -> dict:
    with get_conn() as conn:
        return {row["key"]: row["value"] for row in conn.execute("SELECT key, value FROM fraud_rules")}


def set_fraud_rule(key: str, value: float):
    with get_conn() as conn:
        conn.execute("UPDATE fraud_rules SET value = ? WHERE key = ?", (value, key))


def get_comments(return_id: str) -> list:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT author, text, action, timestamp FROM comments WHERE return_id = ? ORDER BY id",
            (return_id,),
        )
        return [dict(r) for r in rows]


def add_comment(return_id: str, author: str, text: str, action: str, timestamp: str):
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO comments (return_id, author, text, action, timestamp) VALUES (?, ?, ?, ?, ?)",
            (return_id, author, text, action, timestamp),
        )


def add_audit_entry(entry_type: str, text: str, actor: str, timestamp: str):
    with get_conn() as conn:
        conn.execute(
            "INSERT INTO audit_log (timestamp, type, text, actor) VALUES (?, ?, ?, ?)",
            (timestamp, entry_type, text, actor),
        )


def get_audit_log(limit: int = 200) -> list:
    with get_conn() as conn:
        rows = conn.execute(
            "SELECT timestamp, type, text, actor FROM audit_log ORDER BY id DESC LIMIT ?", (limit,)
        )
        return [dict(r) for r in rows]


def insert_labeled_outcome(return_id: str, is_fraud: bool, feature_row: dict, action: str, timestamp: str):
    """Records (or corrects, via INSERT OR REPLACE keyed on return_id) an
    analyst decision as a labeled training example for models/retrain.py.
    Only called from backend/main.py::add_comment for approve/reject actions
    on a customer-sourced case that has a stored feature vector."""
    with get_conn() as conn:
        existing = conn.execute(
            "SELECT labeled_at FROM labeled_outcomes WHERE return_id = ?", (return_id,)
        ).fetchone()
        labeled_at = existing["labeled_at"] if existing else timestamp
        conn.execute(
            """INSERT OR REPLACE INTO labeled_outcomes
               (return_id, is_fraud, feature_json, action, labeled_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?)""",
            (return_id, int(bool(is_fraud)), json.dumps(feature_row), action, labeled_at, timestamp),
        )


def get_labeled_outcomes(since: str = None) -> list:
    query = "SELECT return_id, is_fraud, feature_json, action, labeled_at, updated_at FROM labeled_outcomes"
    params = []
    if since:
        query += " WHERE updated_at > ?"
        params.append(since)
    with get_conn() as conn:
        rows = conn.execute(query, params)
        out = []
        for r in rows:
            d = dict(r)
            d["is_fraud"] = bool(d["is_fraud"])
            d["feature_json"] = json.loads(d["feature_json"])
            out.append(d)
        return out


def count_labeled_outcomes(since: str = None) -> int:
    query = "SELECT COUNT(*) AS n FROM labeled_outcomes"
    params = []
    if since:
        query += " WHERE updated_at > ?"
        params.append(since)
    with get_conn() as conn:
        return conn.execute(query, params).fetchone()["n"]
