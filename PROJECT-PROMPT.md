# Master Build Prompt: ReturnShield AI

Copy everything below the line into your AI coding assistant (Claude Code, Cursor, etc.) or use it as your project brief / hackathon submission spec.

---

## PROJECT PROMPT

You are building **ReturnShield AI** — a multi-agent AI platform that detects and explains shipment-return fraud in real time, for an e-commerce operation processing millions of returns.

The platform does not just output a fraud score. For every return, it must answer:

1. Should this return be accepted?
2. Does it need manual review?
3. Is this customer abusing the return system?
4. Is the returned package/item fake or swapped?
5. Is the customer lying about the return reason?
6. Could a warehouse employee be involved?
7. What evidence supports the final decision?

### System Architecture

Build the pipeline in this order:

```
Customer Return Event
        │
        ▼
Data Ingestion Pipeline (Orders + Returns + Chat logs + Images)
        │
        ▼
Feature Engineering Pipeline
        │
   ┌────────────┬──────────────┬──────────────┐
   ▼            ▼              ▼
Agent 1:     Agent 2:       Agent 3:
Pattern AI   NLP Agent      Vision Agent
   │            │              │
   └────────────┼──────────────┘
                ▼
     Agent 4: Fraud Risk Prediction Model
                ▼
        Explainability Layer (SHAP / LIME)
                ▼
     Agent 5: AI Decision Agent (LLM)
                ▼
     Interactive Real-Time Dashboard
```

### Agent 1 — Pattern Detection Agent
Rule + statistical model that flags behavioral red flags:
- Excessive return frequency
- Returns concentrated on high-value/expensive items
- Seasonal/holiday return abuse patterns
- Shipping address vs. billing/GPS location mismatch
- Multiple shipping addresses on one account
- Frequent payment-method switching

**Output:** `Suspicious Pattern Score (0–100)`

### Agent 2 — NLP Agent
Analyzes customer support chat/email transcripts using an LLM:
- Detects contradictions (e.g., customer says "never arrived" while tracking shows "delivered")
- Flags abusive or manipulative language
- Detects repeated/copy-paste excuse templates across tickets
- Flags emotional-manipulation tactics used to pressure agents

**Output:** `Customer Trust Score`

### Agent 3 — Image Verification Agent
Vision model (YOLO, OpenCV, Gemini Vision, or GPT-4 Vision) analyzes uploaded "damaged item" photos:
- Confirms the photographed product matches the ordered SKU
- Detects staged or fake damage
- Detects reused/old photos (reverse-image / metadata check)
- Flags missing items in the photo
- Cross-checks visible serial number against the order record

**Output:** `Image Authenticity Score`

### Agent 4 — Fraud Prediction Model
Classic ML classifier trained on structured features:
- Customer age / account age
- Purchase value
- Return frequency
- Product category
- Days between delivery and return request
- Shipping distance / delivery-to-return-address distance
- Payment type
- Prior fraud flags on account
- Coupon/promo usage
- Warehouse/fulfillment center
- Delivery time

Train and benchmark **Random Forest, XGBoost, LightGBM, and CatBoost**; select the best performer by Precision/Recall/F1/AUC.

**Output:** `Fraud Probability (%)`

### Agent 5 — Decision Agent (LLM)
Combines all four upstream signals (Pattern Score, Trust Score, Image Score, Fraud Probability) plus SHAP/LIME explanations into a natural-language summary and final recommendation, e.g.:

```
Fraud Probability: 94%
Reasons:
• Customer returned 17 phones this year
• Same excuse used 8 times across tickets
• GPS location mismatch vs. delivery address
• Tracking confirms delivery, customer claims non-arrival
• Uploaded image shows inconsistent product/serial number

Recommendation: Reject return. Escalate to investigation team.
```

### Deliverables

1. **Working prototype** — end-to-end, runnable demo (not just notebooks)
2. **Data ingestion pipeline** — orders, returns, chat logs, images (support batch + streaming/simulated real-time)
3. **ML model pipeline** — feature engineering, training, model comparison, versioning
4. **Explainability layer** — SHAP/LIME visual breakdown per prediction
5. **Multi-agent orchestration layer** — Pattern, NLP, Vision, Prediction, and Decision agents communicating through a shared feature/result store
6. **Interactive dashboard** — real-time backend data, functioning camera/image upload with no bugs
   - Visual theme: **dark glassmorphism** — blue, black, and white palette, frosted-glass panel effects, subtle glow/blur, smooth transitions
   - Real-time fraud risk visualization (live-updating scores, risk heatmaps, case queue)
7. **Precision/Recall/F1/AUC metrics** — model comparison table + confusion matrix visualization
8. **Business impact summary** — estimated fraud $ prevented, false-positive cost avoided, manual review time saved, ROI narrative

### Tech Guidance (adapt as needed)
- **Backend:** Python (FastAPI/Flask) for ML services and agent orchestration
- **ML:** scikit-learn, XGBoost, LightGBM, CatBoost, SHAP
- **NLP:** LLM API (Claude/GPT) for chat analysis and the Decision Agent
- **Vision:** GPT-4 Vision / Gemini Vision / YOLOv8 + OpenCV for image checks
- **Data:** synthetic or public e-commerce return dataset if no real data is available — clearly label it as synthetic
- **Dashboard:** React (or similar) frontend, WebSocket/SSE for real-time updates, glassmorphism UI (blue/black/white), working camera capture for image agent demo
- **Storage:** Postgres for structured data, vector store optional for chat similarity search

### Build Order (recommended)
1. Define synthetic dataset schema (orders, returns, chats, images) and generate realistic sample data with embedded fraud patterns
2. Build feature engineering + Agent 4 (ML baseline) first — this is the core, most demo-able piece
3. Add Agent 1 (Pattern Detection) as a rules/stats layer on top
4. Add Agent 2 (NLP) using LLM calls on chat transcripts
5. Add Agent 3 (Vision) as an optional/stretch agent if time allows
6. Wire in SHAP explainability
7. Build Agent 5 (Decision Agent) to synthesize all signals into a narrative recommendation
8. Build the real-time dashboard last, once backend endpoints are stable
9. Compute and present precision/recall metrics and business impact numbers

### Success Criteria
- Prototype runs end-to-end on sample data without manual intervention
- Dashboard updates in real time as new return events are simulated/ingested
- Every fraud decision is explainable (visible reasons, not a black-box score)
- Model comparison table with Precision/Recall/F1/AUC is presented clearly
- A clear, quantified business-impact story is included (not just "it detects fraud")

---

*Note: if this is for a hackathon or portfolio project, keep the synthetic dataset and any "employee involvement" detection framed carefully — flag it as a risk indicator for human review, not an automated accusation.*
