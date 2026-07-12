"""
Tests for wiring the trained ML model into the live Customer Portal endpoint
(POST /api/submit-return). Run alongside the rest of the suite:

    python3 -m unittest discover -s tests -v

Sets RETURNSHIELD_DB_PATH to an isolated temp file before importing
backend.main, so this file never writes into the real backend/returnshield.db
used by the running dashboard/demo.
"""
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_TMP_DB = tempfile.NamedTemporaryFile(suffix=".db", delete=False)
_TMP_DB.close()
os.environ["RETURNSHIELD_DB_PATH"] = _TMP_DB.name

from fastapi.testclient import TestClient

from backend import db
from backend.customer_pipeline import score_customer_return
import backend.main as main_module
from backend.main import CustomerReturnIn, app
from features.feature_contract import (
    build_features, FEATURE_COLUMNS, INTAKE_UNKNOWN_DEFAULTS, LIVE_UNKNOWN_COLUMNS,
)

client = TestClient(app)


def _baseline_payload(**overrides):
    payload = dict(
        order_id="ORD-TEST-1",
        email="test-customer@example.com",
        category="Electronics",
        purchase_value=199.99,
        reason="Changed my mind",
        days_since_delivery=3,
        product_ordered="Wireless Earbuds",
        item_declared="Wireless Earbuds",
        order_brand="Sony",
        photo_provided=True,
        photo_score=90.0,
        photo_flags=[],
        invoice_attached=False,
    )
    payload.update(overrides)
    return payload


class FeatureContractSkewTest(unittest.TestCase):
    """Same underlying values through the training-shaped call and the
    live-serving-shaped call must agree on the 4 fields with real live data,
    and fall back to the documented defaults for the other 10 — proving
    intentional defaulting, not accidental train/serve skew."""

    def test_real_fields_match_between_training_and_serving_shapes(self):
        training_row = build_features(
            order={"category": "Electronics", "purchase_value": 199.99},
            return_event={"days_before_return": 5},
            customer_history={"return_frequency": 2},
        )
        serving_row = build_features(
            order={"category": "Electronics", "purchase_value": 199.99},
            return_event={"days_before_return": 5},
            customer_history={"return_frequency": 2},
        )
        for col in ("purchase_value", "category_enc", "days_before_return", "return_frequency"):
            self.assertEqual(training_row[col].iloc[0], serving_row[col].iloc[0])

    def test_intake_unknown_columns_default_when_missing(self):
        row = build_features(
            order={"category": "Electronics", "purchase_value": 199.99},
            return_event={"days_before_return": 5},
            customer_history={"return_frequency": 2},
        )
        for col in LIVE_UNKNOWN_COLUMNS:
            self.assertEqual(row[col].iloc[0], INTAKE_UNKNOWN_DEFAULTS[col])

    def test_column_order_matches_feature_columns(self):
        row = build_features({}, {}, {})
        self.assertEqual(list(row.columns), FEATURE_COLUMNS)


class SubmitReturnModelScoringTest(unittest.TestCase):
    def test_scoring_engine_is_model_and_probability_rises_with_stale_return(self):
        resp1 = client.post("/api/submit-return", json=_baseline_payload(
            email="fresh-return@example.com", days_since_delivery=3))
        self.assertEqual(resp1.status_code, 200)
        ref1 = resp1.json()["reference"]
        case1 = db.get_case(ref1)
        self.assertEqual(case1["scoring_engine"], "model")

        resp2 = client.post("/api/submit-return", json=_baseline_payload(
            email="stale-return@example.com", days_since_delivery=60))
        ref2 = resp2.json()["reference"]
        case2 = db.get_case(ref2)
        self.assertEqual(case2["scoring_engine"], "model")

        self.assertGreater(case2["fraud_probability_pct"], case1["fraud_probability_pct"])


class ModelMissingFallbackTest(unittest.TestCase):
    def test_rules_fallback_when_model_unavailable(self):
        with patch.object(main_module, "_CUSTOMER_MODEL", None):
            resp = client.post("/api/submit-return", json=_baseline_payload(
                email="fallback-customer@example.com"))
            self.assertEqual(resp.status_code, 200)
            ref = resp.json()["reference"]
            case = db.get_case(ref)
            self.assertEqual(case["scoring_engine"], "rules_fallback")

    def test_fallback_matches_calling_score_customer_return_directly(self):
        rules = db.get_fraud_rules()
        history = db.get_customer_history("direct-compare@example.com")
        body = CustomerReturnIn(**_baseline_payload(email="direct-compare@example.com"))
        direct_result = score_customer_return(body, rules, history, model_probability=None)

        with patch.object(main_module, "_CUSTOMER_MODEL", None):
            resp = client.post("/api/submit-return", json=_baseline_payload(
                email="direct-compare@example.com"))
            ref = resp.json()["reference"]
            case = db.get_case(ref)
            self.assertEqual(case["risk_tier"], direct_result["risk_tier"])
            self.assertEqual(case["fraud_probability_pct"], direct_result["fraud_probability_pct"])


class BrandMismatchOverrideTest(unittest.TestCase):
    def _mismatch_payload(self, email):
        return _baseline_payload(
            email=email, category="Shoes", product_ordered="Air Max 90",
            item_declared="Air Max 90", order_brand="Nike", photo_detected_brand="adidas",
        )

    def test_override_rejects_with_model_active(self):
        resp = client.post("/api/submit-return", json=self._mismatch_payload("mismatch-model@example.com"))
        ref = resp.json()["reference"]
        self.assertEqual(db.get_case(ref)["risk_tier"], "HIGH")

    def test_override_rejects_with_model_unavailable(self):
        with patch.object(main_module, "_CUSTOMER_MODEL", None):
            resp = client.post("/api/submit-return", json=self._mismatch_payload("mismatch-fallback@example.com"))
            ref = resp.json()["reference"]
            self.assertEqual(db.get_case(ref)["risk_tier"], "HIGH")


class SerialMismatchOverrideTest(unittest.TestCase):
    def _serial_payload(self, email, known="SN-4F82-K93X", detected="SN-4F82-K93X", confident=True, is_new_order=False):
        return _baseline_payload(
            email=email,
            serial_photo_provided=True,
            order_known_serial=known,
            detected_serial=detected,
            serial_confident=confident,
            is_new_order=is_new_order,
        )

    def test_clean_match_no_override(self):
        # Differently formatted but equivalent — exercises normalization.
        payload = self._serial_payload("serial-match@example.com", known="SN-4F82-K93X", detected="sn4f82-k93x")
        resp = client.post("/api/submit-return", json=payload)
        ref = resp.json()["reference"]
        case = db.get_case(ref)
        self.assertNotIn("SERIAL MISMATCH", " ".join(case["reasons"]))
        self.assertNotEqual(case["risk_tier"], "HIGH")

    def test_confirmed_mismatch_forces_high_with_model_active(self):
        payload = self._serial_payload("serial-mismatch-model@example.com", known="SN-4F82-K93X", detected="SN-9GT5-XQ84")
        resp = client.post("/api/submit-return", json=payload)
        ref = resp.json()["reference"]
        case = db.get_case(ref)
        self.assertEqual(case["risk_tier"], "HIGH")
        self.assertIn("SERIAL MISMATCH", " ".join(case["reasons"]))

    def test_confirmed_mismatch_forces_high_with_model_unavailable(self):
        with patch.object(main_module, "_CUSTOMER_MODEL", None):
            payload = self._serial_payload("serial-mismatch-fallback@example.com", known="SN-4F82-K93X", detected="SN-9GT5-XQ84")
            resp = client.post("/api/submit-return", json=payload)
            ref = resp.json()["reference"]
            case = db.get_case(ref)
            self.assertEqual(case["risk_tier"], "HIGH")
            self.assertIn("SERIAL MISMATCH", " ".join(case["reasons"]))

    def test_inconclusive_ocr_floors_at_medium_not_high(self):
        payload = _baseline_payload(
            email="serial-inconclusive@example.com",
            serial_photo_provided=True,
            order_known_serial="SN-4F82-K93X",
            detected_serial="",
            serial_confident=False,
        )
        resp = client.post("/api/submit-return", json=payload)
        ref = resp.json()["reference"]
        case = db.get_case(ref)
        self.assertEqual(case["risk_tier"], "MEDIUM")

    def test_fallback_only_disagreement_does_not_escalate_to_high(self):
        # A non-keyword-anchored ("low confidence") read that happens to
        # differ from the known serial must NOT be treated as a confirmed
        # mismatch — only floors at MEDIUM (inconclusive), per the
        # confidence-gate design.
        payload = self._serial_payload(
            "serial-fallback-only@example.com", known="SN-4F82-K93X", detected="SN-9GT5-XQ84", confident=False)
        resp = client.post("/api/submit-return", json=payload)
        ref = resp.json()["reference"]
        case = db.get_case(ref)
        self.assertNotEqual(case["risk_tier"], "HIGH")
        self.assertNotIn("SERIAL MISMATCH", " ".join(case["reasons"]))

    def test_self_added_order_skips_check_without_crashing(self):
        payload = self._serial_payload(
            "serial-new-order@example.com", known="", detected="", confident=False, is_new_order=True)
        resp = client.post("/api/submit-return", json=payload)
        self.assertEqual(resp.status_code, 200)
        ref = resp.json()["reference"]
        case = db.get_case(ref)
        self.assertNotIn("SERIAL MISMATCH", " ".join(case["reasons"]))


class NlpFallbackTest(unittest.TestCase):
    def test_regex_engine_used_by_default(self):
        payload = _baseline_payload(email="nlp-regex@example.com")
        payload["chat_transcript"] = "Customer: this is ridiculous, I want a refund immediately or I will report you."
        resp = client.post("/api/submit-return", json=payload)
        ref = resp.json()["reference"]
        case = db.get_case(ref)
        self.assertEqual(case["nlp_engine"], "regex_fallback")

    @unittest.skipUnless(os.environ.get("ANTHROPIC_API_KEY"), "no ANTHROPIC_API_KEY in test environment")
    def test_llm_engine_when_enabled_and_key_present(self):
        payload = _baseline_payload(email="nlp-llm@example.com")
        payload["chat_transcript"] = "Customer: item broke after one use, please refund me."
        with patch.dict(os.environ, {"USE_LLM_NLP": "1"}):
            resp = client.post("/api/submit-return", json=payload)
            ref = resp.json()["reference"]
            case = db.get_case(ref)
            self.assertIn(case["nlp_engine"], ("llm", "regex_fallback"))


if __name__ == "__main__":
    unittest.main()
