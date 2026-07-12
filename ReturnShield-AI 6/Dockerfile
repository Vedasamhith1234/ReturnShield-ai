# ReturnShield AI backend — FastAPI + trained sklearn/CatBoost/XGBoost model.
# Builds the API only; the dashboard (dashboard/) deploys separately as a
# static site (see DEPLOY.md) since it needs no server.
FROM python:3.11-slim

# xgboost/lightgbm/catboost all need the OpenMP runtime at import time —
# without it the container crashes on startup with a libgomp.so error (the
# same failure this project hit locally on macOS without Homebrew's libomp;
# on Debian the fix is this one apt package instead).
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY __init__.py .
COPY backend/ backend/
COPY agents/ agents/
COPY features/ features/
COPY data/ data/
COPY models/ models/

# Both the SQLite DB and the model directory (best_model.joblib, the weekly
# retrain registry/candidates) live on the same mounted volume in production
# (see fly.toml) — without this, a promoted weekly retrain is silently wiped
# on the next deploy/machine recreation, since the image's own committed
# models/ directory isn't persistent storage. backend/pipeline.py bootstrap-
# copies the committed models/* onto this path once, on first boot.
ENV RETURNSHIELD_DB_PATH=/data/returnshield.db
ENV RETURNSHIELD_MODEL_DIR=/data/models
RUN mkdir -p /data

EXPOSE 8000
CMD ["uvicorn", "backend.main:app", "--host", "0.0.0.0", "--port", "8000"]
