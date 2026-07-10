"""
Agent 3 — Image Verification Agent
Checks uploaded "damaged item" photos for product match, staged damage,
reused/old photos, missing items, and serial number consistency.
Output: Image Authenticity Score (0-100)

Reference implementation consumes pre-extracted image metadata (as produced by
a vision model such as YOLOv8 / OpenCV / GPT-4 Vision / Gemini Vision in
production). The `analyze_image_meta` function is the integration point:
replace the metadata source with real model output and the scoring logic
below is unchanged.
"""


def analyze_image_meta(image_meta: dict) -> dict:
    score = 100
    flags = []

    if not image_meta.get("sku_match", True):
        score -= 35
        flags.append("Uploaded product image does not match ordered SKU")

    if image_meta.get("staged_damage_suspected"):
        score -= 30
        flags.append("Damage pattern is inconsistent with claimed shipping damage (staged damage suspected)")

    if image_meta.get("reused_photo_detected"):
        score -= 25
        flags.append("Image appears to be reused/old (matches a previously submitted photo)")

    if not image_meta.get("serial_number_match", True):
        score -= 20
        flags.append("Visible serial number does not match order record")

    score = max(0, min(100, score))
    return {"image_authenticity_score": score, "flags": flags}
