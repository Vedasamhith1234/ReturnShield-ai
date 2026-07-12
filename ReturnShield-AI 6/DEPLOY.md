# Deploying ReturnShield AI to returnshield.ai (HTTPS)

This walks through putting the real app — dashboard + FastAPI backend with
SQLite persistence and the trained ML model — on a real domain with HTTPS.
I can't execute any of these steps myself (no domain registrar, hosting, or
payment access from this environment) — this is the exact sequence to follow
yourself. Two services, both with generous free tiers for a low-traffic demo:

- **Netlify** — hosts `dashboard/` (static, HTTPS automatic)
- **Fly.io** — hosts the FastAPI backend + persistent SQLite (HTTPS automatic)

## 0. Register the domain

Pick any registrar (Cloudflare Registrar, Namecheap, Porkbun, etc.) and
register `returnshield.ai`. Worth knowing before you buy: **`.ai` domains are
priced by Anguilla's registry and run noticeably higher than `.com`/`.net`**
(often $60–100+/year depending on registrar) — check the current price at
checkout since it varies and changes over time. If cost is a concern,
`.com`/`.dev` alternatives are far cheaper if the exact TLD isn't a hard
requirement.

Once registered, point its nameservers at Cloudflare (free) — this isn't
required, but it's the easiest way to manage DNS records for two different
hosts (Netlify + Fly.io) from one place, and it's a prerequisite if you want
the Cloudflare Access gating mentioned in step 4.

## 1. Deploy the dashboard (Netlify)

`netlify.toml` is already configured to publish `dashboard/` directly — no
build step (the dashboard is fully static; `dashboard/build.py` is only run
locally, when you change `template.html`/`app.js`, to regenerate the
committed `index.html`).

1. Push this repo to GitHub if it isn't already.
2. In Netlify: **Add new site → Import an existing project → GitHub** → select
   this repo. Netlify auto-detects `netlify.toml`.
3. Click **Deploy** — you'll get a `*.netlify.app` URL immediately, already on
   HTTPS.
4. **Domain settings → Add custom domain** → `returnshield.ai` (and/or
   `www.returnshield.ai`). Netlify shows you the DNS records to add; add them
   at Cloudflare (or wherever your DNS lives). HTTPS certificate provisioning
   is automatic once DNS resolves — no extra step.

## 2. Deploy the backend (Fly.io)

This repo now has a `Dockerfile` and `fly.toml` for this.

```bash
# one-time
curl -L https://fly.io/install.sh | sh
fly auth signup    # or `fly auth login`

# from the repo root
fly launch --no-deploy     # rename the app in fly.toml first — app names are globally unique
fly volumes create returnshield_data --size 1   # 1GB, matches the mount in fly.toml
fly deploy
```

`fly.toml` already mounts a 1GB volume at `/data`, and the `Dockerfile` sets
`RETURNSHIELD_DB_PATH=/data/returnshield.db` and `RETURNSHIELD_MODEL_DIR=/data/models`
— **this is what makes case data, and any weekly-retrained model, actually
survive redeploys/restarts**; skipping the volume means every deploy silently
resets back to the 150-case synthetic seed and the originally-committed model.

You'll get a `https://<your-app-name>.fly.dev` URL immediately (HTTPS
automatic). To use `api.returnshield.ai` instead:
```bash
fly certs add api.returnshield.ai
```
then add the CNAME/A records it prints at your DNS provider.

**Note on the Docker build:** I wrote `Dockerfile` to mirror exactly what
worked in local testing (Python 3.11-slim + `libgomp1` for
xgboost/lightgbm/catboost, which need the OpenMP runtime the same way they
did locally without Homebrew's `libomp`) — but I don't have Docker available
in this environment to actually build and run the image myself, so this is
untested beyond careful reasoning from the working local setup. Watch the
first `fly deploy` build log for anything unexpected.

## 3. Wire the two together

Edit these two lines near the top of `dashboard/template.html` (added for
exactly this):
```html
<script>
  window.RETURNSHIELD_API_BASE = 'https://api.returnshield.ai';  // or your *.fly.dev URL
  window.RETURNSHIELD_SITE_PASSPHRASE = 'choose-a-passphrase';   // leave '' to skip the gate
</script>
```
Then rebuild and push:
```bash
python3 dashboard/build.py
git add dashboard/index.html dashboard/template.html
git commit -m "Point production build at the deployed backend"
git push   # Netlify redeploys automatically on push
```

If you set a passphrase, also set it on the backend (must match exactly):
```bash
fly secrets set SITE_ACCESS_PASSPHRASE='choose-a-passphrase'
```

## 3b. Enable weekly automatic retraining (optional)

The backend already retrains itself in-process, but that alone is
best-effort on a machine that scales to zero (see the README's "Weekly
automatic retraining" section for why). To actually guarantee it fires every
week:

```bash
fly secrets set RETRAIN_ADMIN_SECRET='choose-a-different-secret'
```
Then, in the GitHub repo → **Settings → Secrets and variables → Actions**,
add two repository secrets:
- `RETURNSHIELD_API_URL` — your deployed backend URL (`https://api.returnshield.ai`
  or your `*.fly.dev` URL)
- `RETRAIN_ADMIN_SECRET` — the exact same value as the `fly secrets set` above

`.github/workflows/weekly-retrain.yml` is already set up (Monday 06:00 UTC +
a manual "Run workflow" button) — nothing else to do once those two secrets
exist. Use a **different** value than `SITE_ACCESS_PASSPHRASE` — that one is
meant to live in frontend JS and is visible to anyone reading page source,
which is fine for gating demo access but not for an endpoint that can
overwrite the production model.

## 4. About the access gate

This prototype has synthetic data and hardcoded demo logins
(`customer@demo.com` / `admin@returnshield.ai`), so once it's on a real
domain, anyone who finds it can log in and poke around. `SITE_ACCESS_PASSPHRASE`
+ the frontend gate screen (shown automatically when
`RETURNSHIELD_SITE_PASSPHRASE` is set) is a **speed bump, not real security**:
the passphrase has to live in the frontend's JS to be sent to the backend, so
it's visible to anyone who reads the page source or a network request. It
stops casual/accidental discovery (search engines, shared links, port scans),
nothing more.

For real access control, put **Cloudflare Access** in front of both the
Netlify site and the Fly.io API (both can be proxied through Cloudflare's
orange-cloud DNS) — it authenticates *before* a request ever reaches either
origin (email OTP or your own login policy), with no code changes needed
here. I can't set this up myself since it requires your own Cloudflare
account; Cloudflare's dashboard walks through adding an Access application
per hostname.

## 5. Optional hardening once it's live

- Tighten CORS in `backend/main.py` (`allow_origins=["*"]` → your actual
  domain) once you know the final URL.
- Consider rotating/removing the hardcoded demo credentials
  (`dashboard/app.js::DEMO_USERS`) if this is more than a private demo.

## Costs

Netlify's and Fly.io's free tiers comfortably cover a low-traffic demo as of
this writing, but check each provider's current pricing page before
committing — free-tier terms change over time and I can't look up live
pricing from here. The `.ai` domain itself will likely be the single biggest
recurring cost.
