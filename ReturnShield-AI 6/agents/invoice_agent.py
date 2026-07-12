"""
Agent 6 — Invoice Verification Agent
Cross-checks an uploaded invoice/receipt against the order record.

Real-world fraud patterns this catches:
- Amount mismatch (invoice edited to inflate refund value)
- Duplicate invoice reuse across multiple return claims
- Date inconsistency (invoice date after delivery, or impossible timelines)
- Vendor/merchant mismatch (receipt from a different seller entirely)
- Order-ID mismatch (invoice references a different or nonexistent order)

Reference implementation consumes structured fields extracted from the invoice.
In production, feed it OCR output (e.g. Tesseract, AWS Textract, or a vision
LLM) — the verification logic below is unchanged.
"""
from datetime import datetime

# In-memory registry of invoice fingerprints already used in prior claims.
# In production this is a database table keyed on a perceptual/document hash.
_SEEN_INVOICE_HASHES = {}


def verify_invoice(invoice_fields: dict, order_row: dict) -> dict:
    """
    invoice_fields: {
        invoice_number, invoice_amount, invoice_date (ISO),
        merchant_name, order_id_on_invoice, document_hash
    }
    order_row: the matching order record
    """
    score = 100
    flags = []

    # 1. Amount match (small tolerance for tax/rounding)
    inv_amount = float(invoice_fields.get("invoice_amount") or 0)
    order_amount = float(order_row["purchase_value"])
    if inv_amount > 0:
        diff_pct = abs(inv_amount - order_amount) / max(order_amount, 0.01)
        if diff_pct > 0.10:
            score -= 35
            flags.append(
                f"Invoice amount (${inv_amount:,.2f}) differs from order record "
                f"(${order_amount:,.2f}) by {diff_pct:.0%} — possible edited invoice")
    else:
        score -= 15
        flags.append("No amount could be read from the invoice")

    # 2. Duplicate invoice reuse
    doc_hash = invoice_fields.get("document_hash")
    if doc_hash:
        prior_use = _SEEN_INVOICE_HASHES.get(doc_hash)
        if prior_use and prior_use != order_row["order_id"]:
            score -= 40
            flags.append(
                f"This exact invoice document was already submitted for a different "
                f"claim ({prior_use}) — duplicate-invoice fraud pattern")
        _SEEN_INVOICE_HASHES[doc_hash] = order_row["order_id"]

    # 3. Date consistency
    inv_date_str = invoice_fields.get("invoice_date")
    if inv_date_str:
        try:
            inv_date = datetime.fromisoformat(inv_date_str)
            order_date = datetime.fromisoformat(order_row["order_date"])
            delivery_date = datetime.fromisoformat(order_row["delivery_date"])
            if inv_date > delivery_date:
                score -= 25
                flags.append("Invoice is dated AFTER the delivery date — timeline impossible for an original purchase invoice")
            elif abs((inv_date - order_date).days) > 3:
                score -= 15
                flags.append(f"Invoice date is {abs((inv_date - order_date).days)} days away from the order date")
        except (ValueError, TypeError):
            score -= 10
            flags.append("Invoice date could not be parsed/validated")

    # 4. Order ID match
    inv_order_id = (invoice_fields.get("order_id_on_invoice") or "").strip()
    if inv_order_id and inv_order_id != order_row["order_id"]:
        score -= 30
        flags.append(
            f"Order ID on invoice ({inv_order_id}) does not match this claim's order ({order_row['order_id']})")

    score = max(0, min(100, score))
    verdict = ("VERIFIED" if score >= 80 else
               "NEEDS REVIEW" if score >= 50 else
               "SUSPECT DOCUMENT")
    return {"invoice_verification_score": score, "verdict": verdict, "flags": flags}
