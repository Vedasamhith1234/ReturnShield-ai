# Deploying ReturnShield AI

## Part 1 — Dashboard on Netlify (zero libraries needed)

The dashboard (`netlify-site/index.html`) is **fully self-contained**: all 150
scored cases, model metrics, SHAP data, styles, and JavaScript are embedded in
the single HTML file. Google Fonts loads from a CDN. That means:

> **There are no libraries to install for the Netlify deploy. No npm, no
> build step, nothing.** Netlify just serves the file.

### Option A — Drag & drop (fastest, ~30 seconds)
1. Go to https://app.netlify.com/drop
2. Drag the `netlify-site` folder onto the page
3. Done — you get a live URL immediately

### Option B — Deploy from your GitHub repo (recommended)
1. Push this repo to GitHub (see repo instructions)
2. In Netlify: **Add new site → Import an existing project → GitHub** →
   select `Vedasamhith1234/ReturnShield-ai`
3. Netlify auto-detects `netlify.toml`:
   - Publish directory: `netlify-site`
   - Build command: none needed
4. Click **Deploy**

### Option C — Netlify CLI
The only install here is the Netlify CLI itself (not project libraries):
```bash
npm install -g netlify-cli
netlify login
netlify deploy --dir=netlify-site --prod
```

### Bonus: camera works on Netlify
Netlify serves over **https**, which is a secure context — so the Agent 3
camera demo (which some browsers block on `file://`) will work on your live
Netlify URL. The `netlify.toml` already includes
`Permissions-Policy: camera=(self)` to allow it.

## Part 2 — Python backend (NOT deployable on Netlify)

Netlify only hosts static sites and JS serverless functions — it **cannot run
FastAPI/Python servers or load scikit-learn/XGBoost models**. The dashboard
doesn't need the backend (data is embedded), but if you want the live API too,
deploy it on a Python-friendly host:

| Host | How |
|---|---|
| **Render** (easiest free tier) | New Web Service → connect repo → build: `pip install -r requirements.txt` → start: `uvicorn backend.main:app --host 0.0.0.0 --port $PORT` |
| **Railway** | Same commands; Railway auto-detects Python |
| **Fly.io** | `fly launch` with a simple Dockerfile |

Python libraries for the backend (already in `requirements.txt`):
```
fastapi
uvicorn
scikit-learn
xgboost
lightgbm
catboost
shap
pandas
numpy
pyarrow
joblib
faker
```
Install locally with:
```bash
pip install -r requirements.txt
```

## Summary
- **Netlify** → hosts `netlify-site/` (the dashboard). Zero installs.
- **Render/Railway** → hosts `backend/` (the FastAPI + ML API), installs from
  `requirements.txt`.
- The dashboard works perfectly on its own without the backend.
