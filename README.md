# ModelWard

An AI model governance MVP: register a model → upload a version (CSV or a
pickle/joblib model) → get real/self-reported metrics → route it through an
approval queue → deploy → simulate drift → see every action in a read-only
audit trail. Built from `MVP_BUILD_PLAN.md` one level up.

Three roles, no invite flow (pick your role at signup): **Admin**,
**ML Engineer / Data Scientist**, **Compliance Officer / Reviewer**.

## Architecture

```
React (Vite, :5173) --proxy--> Express API (:5000) --> MongoDB (:27017)
                                      │
                                      └──> FastAPI metrics microservice (:8000)
```

- **MongoDB** stores structured data only (users, models, versions, metric
  snapshots, audit logs).
- **Local disk** (`server/uploads/`) stores the actual uploaded file bytes --
  Mongo only ever holds a `filePath` pointer to them.
- **FastAPI** is a stateless calculator: takes a file, returns
  `{accuracy, fairness_gap, latency_ms}`, remembers nothing.
- **Risk tier** (`low`/`medium`/`high`) is never chosen by the uploader -- it's
  computed server-side in Express from the metrics FastAPI returns.

## Prerequisites

- Node.js 18+ and npm
- Python 3.10+
- MongoDB running locally on `27017` (already running as a Windows service on
  this machine -- `Get-Service MongoDB` to check)

## Running it (3 processes)

**1. Metrics microservice (FastAPI)**
```
cd metrics-service
python -m venv venv
.\venv\Scripts\pip install -r requirements.txt
.\venv\Scripts\python -m uvicorn main:app --reload --port 8000
```

**2. API server (Express)**
```
cd server
npm install
npm run dev
```
Reads config from `server/.env` (Mongo URI, JWT secret, metrics service URL --
already filled in with local defaults).

**3. Frontend (React + Vite)**
```
cd client
npm install
npm run dev
```
Open **http://localhost:5173**. The dev server proxies `/api/*` to Express on
port 5000, so the browser never needs to know about port 5000 directly.

All three are already running in the background from the initial build/test
pass -- you can open http://localhost:5173 right now. If you restart your
machine or the terminal session ends, bring them back up with the three
commands above, in that order (metrics service and Mongo before Express,
since Express calls out to the metrics service on file upload).

## Trying it out

1. Sign up three accounts (one per role) at `/signup`.
2. As the **ML Engineer**: create a model, then upload a version.
   - Sample fixtures are in `../sample-data/` (one level up from this folder):
     - `good_predictions.csv` -- scores ~95% accuracy -> lands `low` risk
     - `bad_predictions.csv` -- scores ~45% accuracy -> lands `high` risk
     - `dummy_model.joblib` + `model_dataset.csv` -- a real fitted
       scikit-learn model + matching companion dataset (real `.predict()`,
       real measured latency)
     - `mismatched_dataset.csv` -- pair with `dummy_model.joblib` to see the
       clean "upload failed" error path instead of a crash (wrong feature count)
   - Regenerate all of these anytime with:
     `..\metrics-service\venv\Scripts\python ..\sample-data\generate_samples.py`
     (run from `sample-data/`)
   - Submit the version for review once it's uploaded.
3. As the **Compliance Officer**: open the Review Queue, approve or reject.
   Note: approving a **high-risk** version requires a non-empty comment --
   the API returns a 400 if you try to approve one silently.
4. Deploy the approved version, then click **Simulate Next Snapshot** a few
   times to watch drift accumulate (small downward walk + jitter, not pure
   noise, so it visibly trends).
5. As the **Admin**: check the Governance Overview for counts by risk tier and
   status.
6. Every role's dashboard ends with a shared, read-only **Audit Trail** table
   showing every governance action across the whole system.

## What's deliberately NOT built

See `MVP_BUILD_PLAN.md` section 1 and 11 -- no email verification, no real
cron job for drift (button-triggered only), no per-role audit scoping, no S3
(local disk only), no editing/deleting models or versions. This is a scoped
MVP skeleton, not a production system.
