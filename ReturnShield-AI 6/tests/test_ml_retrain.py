"""
Tests for the weekly analyst-feedback retraining loop (models/retrain.py).
Run alongside the rest of the suite:

    python3 -m unittest discover -s tests -v

Isolates both the database (RETURNSHIELD_DB_PATH, same trick as
tests/test_ml_serving.py) and the model directory (patching
models.retrain's module-level MODEL_DIR/REGISTRY_PATH/CANDIDATES_DIR/
LOCK_PATH/BEST_MODEL_PATH) so this file never touches the real
backend/returnshield.db or models/best_model.joblib.
"""
import hashlib
import json
import os
import shutil
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest.mock import patch

_TMP_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_TMP_DB.close()
os.environ["RETURNSHIELD_DB_PATH"] = _TMP_DB.name
os.environ["RETURNSHIELD_DISABLE_SCHEDULER"] = "1"

from fastapi.testclient import TestClient
from sklearn.dummy import DummyClassifier

from backend import db
import backend.main as main_module
import models.retrain as retrain
from features.feature_contract import FEATURE_COLUMNS

client = TestClient(main_module.app)


def _file_hash(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _iso(dt) -> str:
    return dt.isoformat()


class RetrainCycleTest(unittest.TestCase):
    """Each test gets its own isolated tmp model dir — patched directly onto
    the models.retrain module (mirrors the patch.object(main_module, ...)
    pattern already used in test_ml_serving.py)."""

    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp()
        self.model_dir = Path(self.tmp_dir)
        self._patches = [
            patch.object(retrain, "MODEL_DIR", self.model_dir),
            patch.object(retrain, "REGISTRY_PATH", self.model_dir / "registry.json"),
            patch.object(retrain, "CANDIDATES_DIR", self.model_dir / "candidates"),
            patch.object(retrain, "LOCK_PATH", self.model_dir / ".retrain.lock"),
            patch.object(retrain, "BEST_MODEL_PATH", self.model_dir / "best_model.joblib"),
        ]
        for p in self._patches:
            p.start()
        # Clear any labeled outcomes left over from a previous test in this file.
        with db.get_conn() as conn:
            conn.execute("DELETE FROM labeled_outcomes")

    def tearDown(self):
        for p in self._patches:
            p.stop()
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def _write_registry(self, entries):
        with open(retrain.REGISTRY_PATH, "w") as f:
            json.dump(entries, f)

    def _dummy_model(self):
        m = DummyClassifier(strategy="constant", constant=0)
        m.fit([[0] * len(FEATURE_COLUMNS)], [0])
        return m

    def test_first_ever_run_always_promotes(self):
        result = retrain.run_retrain_cycle(trigger="manual", force=True)
        self.assertEqual(result["status"], "completed")
        self.assertTrue(result["promoted"])
        self.assertTrue(retrain.BEST_MODEL_PATH.exists())
        self.assertEqual(result["production_f1_before"], -1.0)

    def test_skips_when_not_due(self):
        recent = _iso(datetime.now(timezone.utc) - timedelta(days=1))
        self._write_registry([{"status": "completed", "finished_at": recent}])
        result = retrain.run_retrain_cycle(trigger="in_process_timer")
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(result["reason"], "not_due")
        if retrain.REGISTRY_PATH.exists():
            with open(retrain.REGISTRY_PATH) as f:
                self.assertLessEqual(len(json.load(f)), 1)

    def test_skips_when_insufficient_new_labels(self):
        old = _iso(datetime.now(timezone.utc) - timedelta(days=10))
        self._write_registry([{"status": "completed", "finished_at": old}])
        db.insert_labeled_outcome("RET-A", True, {c: 0 for c in FEATURE_COLUMNS}, "reject", _iso(datetime.now(timezone.utc)))
        result = retrain.run_retrain_cycle(trigger="in_process_timer", min_new_labels=3)
        self.assertEqual(result["status"], "skipped")
        self.assertEqual(result["skipped_reason"], "insufficient_new_labels")
        # unlike the not-due gate, this one IS logged
        with open(retrain.REGISTRY_PATH) as f:
            registry = json.load(f)
        self.assertEqual(len(registry), 2)

    def test_promotion_replaces_production_model(self):
        with patch.object(retrain, "fit_and_select") as mock_fit:
            mock_fit.return_value = (self._dummy_model(), "Dummy", {"Dummy": {"f1": 0.99}})
            result = retrain.run_retrain_cycle(trigger="manual", force=True)
        self.assertTrue(result["promoted"])
        self.assertEqual(result["candidate_f1"], 0.99)
        candidates = list(retrain.CANDIDATES_DIR.glob("*.joblib"))
        self.assertEqual(len(candidates), 1)

    def test_non_promotion_leaves_production_untouched(self):
        # Seed an initial "production" model with a real cycle first.
        first = retrain.run_retrain_cycle(trigger="manual", force=True)
        self.assertTrue(first["promoted"])
        before_hash = _file_hash(retrain.BEST_MODEL_PATH)

        with patch.object(retrain, "fit_and_select") as mock_fit:
            mock_fit.return_value = (self._dummy_model(), "Dummy", {"Dummy": {"f1": 0.0}})
            result = retrain.run_retrain_cycle(trigger="manual", force=True)

        self.assertFalse(result["promoted"])
        after_hash = _file_hash(retrain.BEST_MODEL_PATH)
        self.assertEqual(before_hash, after_hash)
        # still archived even though not promoted
        candidates = list(retrain.CANDIDATES_DIR.glob("*.joblib"))
        self.assertEqual(len(candidates), 2)

    def test_already_running_lock_prevents_concurrent_cycle(self):
        retrain.MODEL_DIR.mkdir(parents=True, exist_ok=True)
        retrain.LOCK_PATH.touch()
        result = retrain.run_retrain_cycle(trigger="manual", force=True)
        self.assertEqual(result, {"status": "skipped", "reason": "already_running", "trigger": "manual"})


class LabelWiringTest(unittest.TestCase):
    def _payload(self, email, **overrides):
        payload = dict(
            order_id="ORD-LABEL", email=email, category="Electronics", purchase_value=99.0,
            reason="Changed my mind", days_since_delivery=3, product_ordered="Widget",
            item_declared="Widget", order_brand="Acme", photo_provided=True, photo_score=90.0,
            photo_flags=[], invoice_attached=False,
        )
        payload.update(overrides)
        return payload

    def test_reject_creates_fraud_label(self):
        resp = client.post("/api/submit-return", json=self._payload("reject-label@example.com"))
        ref = resp.json()["reference"]
        client.post(f"/api/case/{ref}/comments", json={"author": "A", "text": "bad", "action": "reject"})
        outcomes = [o for o in db.get_labeled_outcomes() if o["return_id"] == ref]
        self.assertEqual(len(outcomes), 1)
        self.assertTrue(outcomes[0]["is_fraud"])

    def test_approve_creates_legit_label(self):
        resp = client.post("/api/submit-return", json=self._payload("approve-label@example.com"))
        ref = resp.json()["reference"]
        client.post(f"/api/case/{ref}/comments", json={"author": "A", "text": "fine", "action": "approve"})
        outcomes = [o for o in db.get_labeled_outcomes() if o["return_id"] == ref]
        self.assertEqual(len(outcomes), 1)
        self.assertFalse(outcomes[0]["is_fraud"])

    def test_note_and_escalate_do_not_create_labels(self):
        resp = client.post("/api/submit-return", json=self._payload("note-label@example.com"))
        ref = resp.json()["reference"]
        client.post(f"/api/case/{ref}/comments", json={"author": "A", "text": "hmm", "action": "note"})
        client.post(f"/api/case/{ref}/comments", json={"author": "A", "text": "check this", "action": "escalate"})
        outcomes = [o for o in db.get_labeled_outcomes() if o["return_id"] == ref]
        self.assertEqual(len(outcomes), 0)


class AdminRetrainAuthTest(unittest.TestCase):
    def test_refuses_when_secret_unset(self):
        with patch.object(main_module, "_RETRAIN_ADMIN_SECRET", None):
            resp = client.post("/api/admin/retrain")
            self.assertEqual(resp.status_code, 503)

    def test_rejects_wrong_secret(self):
        with patch.object(main_module, "_RETRAIN_ADMIN_SECRET", "correct-secret"):
            resp = client.post("/api/admin/retrain", headers={"X-Retrain-Secret": "wrong"})
            self.assertEqual(resp.status_code, 401)

    def test_accepts_correct_secret(self):
        with patch.object(main_module, "_RETRAIN_ADMIN_SECRET", "correct-secret"), \
             patch.object(main_module.retrain_module, "run_retrain_cycle", return_value={"status": "skipped", "reason": "not_due", "promoted": False}):
            resp = client.post("/api/admin/retrain", headers={"X-Retrain-Secret": "correct-secret"})
            self.assertEqual(resp.status_code, 200)
            self.assertEqual(resp.json()["reason"], "not_due")


if __name__ == "__main__":
    unittest.main()
