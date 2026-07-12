"""
Regenerates dashboard/index.html from dashboard/template.html + dashboard/app.js.

index.html is a build artifact, not a source file: template.html holds the
page shell (CSS/markup) with __DATA_BUNDLE__ / __APP_JS__ placeholders, and
app.js holds all page behavior. Editing index.html directly causes it to
drift from app.js (its <script> becomes a stale, disconnected copy) — always
edit template.html and app.js, then run this script.

Run with:
    python dashboard/build.py
"""
import json
import re
from pathlib import Path

DASHBOARD_DIR = Path(__file__).parent
DATA_DIR = DASHBOARD_DIR.parent / "data"

TEMPLATE_PATH = DASHBOARD_DIR / "template.html"
APP_JS_PATH = DASHBOARD_DIR / "app.js"
INDEX_PATH = DASHBOARD_DIR / "index.html"

DATA_BUNDLE_RE = re.compile(
    r'<script id="data-bundle" type="application/json">(.*?)</script>', re.DOTALL
)


def _existing_data_bundle() -> dict:
    """Reuses the data bundle already baked into index.html so this script
    doesn't need to know how to regenerate the demo dataset from scratch."""
    if not INDEX_PATH.exists():
        raise FileNotFoundError(
            "index.html not found — can't recover the data bundle. "
            "Regenerate it via the pipeline that originally produced it."
        )
    match = DATA_BUNDLE_RE.search(INDEX_PATH.read_text())
    if not match:
        raise ValueError("Could not find a data-bundle <script> tag in index.html")
    return json.loads(match.group(1))


def _customer_names_for(cases: list) -> dict:
    """Minimal customer_id -> name lookup, scoped to the customer_ids that
    actually appear in the seeded case bundle, so the page doesn't have to
    ship the entire customers.json (2500 rows) just to label a handful of
    cases with a human name instead of a bare CUST-XXXXX id."""
    customers_path = DATA_DIR / "customers.json"
    if not customers_path.exists():
        return {}
    customers = json.loads(customers_path.read_text())
    name_by_id = {c["customer_id"]: c["name"] for c in customers}
    ids_in_use = {c["customer_id"] for c in cases}
    return {cid: name_by_id[cid] for cid in ids_in_use if cid in name_by_id}


def build():
    template = TEMPLATE_PATH.read_text()
    app_js = APP_JS_PATH.read_text()
    data_bundle = _existing_data_bundle()
    data_bundle["customer_names"] = _customer_names_for(data_bundle["cases"])

    output = template.replace("__DATA_BUNDLE__", json.dumps(data_bundle)).replace("__APP_JS__", app_js)
    INDEX_PATH.write_text(output)
    print(f"Wrote {INDEX_PATH} ({len(output):,} bytes)")


if __name__ == "__main__":
    build()
