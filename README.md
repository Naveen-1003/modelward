# ModelWard

An AI model governance platform: register a model → upload a version (CSV
predictions, or a pickle/joblib model in development) → get real/self-reported
metrics → route it through an approval queue → deploy → monitor it with real
data batches (or simulated drift) → see every action in a tamper-evident audit
trail. Built from `MVP_BUILD_PLAN.md` one level up, then hardened following
`QA_GAPS_AND_ENHANCEMENTS.md`.

Three roles: **Admin**, **ML Engineer / Data Scientist**, **Compliance Officer /
Reviewer**. ML engineers can self-register; admin and compliance accounts need
an invite code (or an existing admin creates them).

Deploying to Vercel + Render + MongoDB Atlas? See **[DEPLOYMENT.md](DEPLOYMENT.md)**.

## Features

- **Security hardening** -- invite-code gated signup for privileged roles,
  zod validation on every body, `helmet`, CORS allow-list, request logging,
  per-IP rate limits (failed logins, signups, general API), NoSQL-operator
  stripping, JSON errors with no file paths or stack traces, startup checks that
  refuse weak secrets in production, shared-secret header between Express and the
  metrics service, and pickle/joblib uploads **off by default in production**.
- **Soft delete / archive and Trash** -- models and versions are archived, never
  removed; admins restore them from Trash (archiving a model cascades to its
  versions). Model names are unique case-insensitively among active models.
- **Full version lifecycle** -- `draft`, `submitted`, `changes_requested`,
  `approved`, `rejected`, `deployed`, `needs_review`, `superseded`, `retired`,
  `upload_failed`. Withdraw, request changes, resubmit, retry scoring, deploy
  (automatically supersedes the previous live version), retire.
- **Real monitoring** -- upload a new predictions batch for a deployed version and
  it is re-scored by the metrics service. Drift flags move the version to
  `needs_review` until a compliance officer resolves it (keep or retire). The
  simulated drift button is optional (`ENABLE_DRIFT_SIMULATION`).
- **Configurable thresholds** -- admins set the low/medium risk and drift
  thresholds; each version records the thresholds it was scored under, and its
  risk tier is re-evaluated on every snapshot.
- **Fairness metrics** -- demographic parity difference, equal-opportunity
  difference, disparate-impact ratio and a per-group table, plus precision,
  recall, F1 and AUC when the data allows. The accuracy-gap number is kept for
  the risk tier.
- **Comments** -- immutable discussion thread on each version.
- **Model card / report** -- printable compliance report per version.
- **Audit trail** -- append-only, hash-chained log with filters, pagination, CSV
  export (compliance/admin) and an admin integrity check
  (`GET /api/audit-log/verify`). ML engineers only see entries about their own work.
- **Admin user management** -- list/search users, create users, change roles,
  deactivate/reactivate (blocks login immediately, keeps the audit trail).
- **Search, filters and pagination** on the registry, review queue and audit log;
  toasts, confirm dialogs, 401-redirect on expired sessions.

## Architecture

```
React (Vite, :5173) --proxy /api--> Express API (:5000) --> MongoDB (:27017)
                                          |
                                          +--> FastAPI metrics microservice (:8000)
                                               (X-Metrics-Secret, CSV or model-file scoring)

Production:
Vercel (React) --VITE_API_URL or rewrite--> Render: Express --> MongoDB Atlas
                                                      |
                                                      +--> Render: FastAPI metrics
```

- **MongoDB** stores structured data only (users, models, versions, metric
  snapshots, comments, settings, audit logs).
- **Uploaded files**: with `STORAGE_MODE=local` (the development default) the
  bytes live in `server/uploads/` and Mongo holds a pointer to them. In
  production (`discard`) files are deleted after scoring because Render's disk is
  ephemeral; only the metrics are kept.
- **FastAPI** is a stateless calculator: takes a file, returns accuracy,
  fairness metrics and (for model files) measured latency, remembers nothing.
- **Risk tier** (`low`/`medium`/`high`) is never chosen by the uploader -- it's
  computed server-side in Express from the metrics FastAPI returns and the
  admin-configured thresholds.

## Prerequisites

- Node.js 18+ (20 recommended; CI uses 20) and npm
- Python 3.10+ (CI uses 3.11)
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
Reads config from `server/.env` (Mongo URI, JWT secret, metrics service URL,
invite codes). Start from `server/.env.example` if you don't have one:
`copy .env.example .env`, then set `JWT_SECRET` (any long string in development).

**3. Frontend (React + Vite)**
```
cd client
npm install
npm run dev
```
Open **http://localhost:5173**. The dev server proxies `/api/*` to Express on
port 5000, so the browser never needs to know about port 5000 directly.

If you restart your machine or the terminal session ends, bring them back up with
the three commands above, in that order (metrics service and Mongo before Express,
since Express calls out to the metrics service on file upload).

## Configuration (local development)

Server settings live in `server/.env` and are all read through
`server/config/env.js`. The full annotated list is in `server/.env.example`;
the ones you are most likely to touch:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `5000` | API port |
| `MONGO_URI` | `mongodb://127.0.0.1:27017/modelward` | Database |
| `JWT_SECRET` | none (**required**) | Token signing key (>= 32 chars required in production) |
| `METRICS_SERVICE_URL` | `http://127.0.0.1:8000` | FastAPI scoring service |
| `METRICS_SHARED_SECRET` | empty | Must match the metrics service when it has one (required in production) |
| `CLIENT_ORIGIN` | any localhost origin | Allowed browser origins |
| `ADMIN_INVITE_CODE` | none | Needed to self-register as **admin** (unset = disabled) |
| `COMPLIANCE_INVITE_CODE` | none | Needed to self-register as **compliance officer** (unset = disabled) |
| `ALLOW_MODEL_FILES` | `true` dev / `false` prod | Accept pickle/joblib uploads (they execute code) |
| `STORAGE_MODE` | `local` dev / `discard` prod | Keep or delete uploaded files after scoring |
| `ENABLE_DRIFT_SIMULATION` | `true` | Show/allow the simulate-drift button |
| `MAX_UPLOAD_MB` | `25` | Upload size limit (413 above it) |
| `RETENTION_DAYS` | `30` | Days before retained files of archived/failed versions are deleted |
| `LOGIN_MAX_FAILURES` / `LOGIN_WINDOW_MINUTES` | `10` / `15` | Failed-login rate limit per IP |
| `SIGNUP_MAX_PER_HOUR` / `API_MAX_PER_MINUTE` | `20` / `600` | Signup and general rate limits per IP |

The metrics service reads plain environment variables (`APP_ENV`,
`METRICS_SHARED_SECRET`, `ALLOW_MODEL_FILES`, row/size limits; see
`metrics-service/.env.example`). The client reads `VITE_API_URL` only when the API
is on a different origin (see `client/.env.example`; leave it unset locally).

## Roles and signing up locally

| Role | How to get one |
|---|---|
| ML Engineer | Open signup at `/signup` -- no code |
| Compliance Officer | Sign up with `COMPLIANCE_INVITE_CODE` from `server/.env` |
| Admin | Sign up with `ADMIN_INVITE_CODE` from `server/.env`, or have an existing admin create you in **Admin > Users** |

If a code is unset in `server/.env`, signup for that role is disabled (the API
answers 403 "Signup for this role is disabled"); after editing `.env`, restart the
API. Passwords are 8-128 characters. Admins create further users (any role) and
can deactivate them from the Admin portal.

## Trying it out

1. Create three accounts (one per role) at `/signup`, using the invite codes for
   admin and compliance (or create them from an admin account).
2. As the **ML Engineer**: create a model, then upload a version.
   - Sample fixtures are in `sample-data/` (see the table below).
   - Submit the version for review once it's uploaded. (Not happy with it? Withdraw
     it back to draft, edit the notes, or archive it.)
3. As the **Compliance Officer**: open the Review Queue and approve, reject or
   request changes. A comment is **required** to reject, to request changes, and
   to approve a **high-risk** version -- the API returns a 400 without one.
4. Deploy the approved version (any previously live version of that model becomes
   `superseded`). Then, as the ML engineer, either upload a **monitoring batch**
   (re-use `good_predictions.csv` for healthy data and `bad_predictions.csv` for a
   degraded batch) or click **Simulate next snapshot** a few times. A flagged
   snapshot moves the version to `needs_review`.
5. The Compliance Officer resolves the review (keep deployed, or retire) with a
   comment, and can retire any live version.
6. Add comments on the version, open the **model card / report** and print it.
7. As the **Admin**: Governance Overview (counts by tier and status), user
   management, risk/drift thresholds, Trash (restore archived models/versions).
8. Every dashboard has an **Audit Trail** with filters and paging; compliance
   officers and admins can export it as CSV, and an admin can verify the hash
   chain (`GET /api/audit-log/verify`).

## Sample data (`sample-data/`)

| File | Use it for | Expect |
|---|---|---|
| `good_predictions.csv` | CSV upload (with a latency value) or a healthy monitoring batch | ~95% accuracy -> `low` risk |
| `bad_predictions.csv` | CSV upload or a degraded monitoring batch | ~45% accuracy -> `high` risk (approval needs a comment); flags drift when used as a batch |
| `dummy_model.joblib` + `model_dataset.csv` | Model-file upload (needs `ALLOW_MODEL_FILES=true`, i.e. development): upload the model as the file and the CSV as the dataset | Real `.predict()` and measured latency |
| `mismatched_dataset.csv` | Pair with `dummy_model.joblib` | Clean `upload_failed` (wrong feature count), not a crash |
| `generate_samples.py` | Regenerate all of the above: from `sample-data/` run `..\metrics-service\venv\Scripts\python generate_samples.py` | |
| `smoke_test.ps1` | End-to-end API check, see below | One PASS/FAIL line per check |

Prediction CSVs need the columns `predicted`, `actual`, `protected_attribute` (and
optionally `probability` for AUC). The metrics service needs at least 30 rows and
10 rows per group, and answers 400 with a clear message otherwise.

## Tests

**Server** (Jest + supertest). Needs a local MongoDB; the suite uses its own
database and **drops it**, so never point `TEST_DB_NAME` at real data.
```
cd server
npm test
# several runners at once: give each its own database
#   $env:TEST_DB_NAME = "modelward_jest_a"; npm test
```
`TEST_DB_NAME` defaults to `modelward_jest`. The metrics service is mocked.

**Metrics service** (pytest):
```
cd metrics-service
.\venv\Scripts\pip install -r requirements-dev.txt
.\venv\Scripts\python -m pytest
```

**Client**: `cd client && npm run build` (CI runs the same).

**Smoke test** against a running stack (PowerShell; uses `curl.exe` for uploads):
```
$env:ADMIN_INVITE_CODE = "<code from server/.env>"
$env:COMPLIANCE_INVITE_CODE = "<code from server/.env>"
.\sample-data\smoke_test.ps1                    # defaults to http://127.0.0.1:5000/api
.\sample-data\smoke_test.ps1 -Api https://<api>.onrender.com/api -AdminEmail a@x.com -AdminPassword '...' -ComplianceEmail c@x.com -CompliancePassword '...'
```
It creates uniquely named users and models on every run (so it can be re-run), exits
`1` if any check fails, and skips steps that need model files, drift simulation, or an
admin/compliance account when those are unavailable. It signs up a handful of users per
run, so the per-IP signup and failed-login limits allow only a few runs in a row; raise
`SIGNUP_MAX_PER_HOUR` / `LOGIN_MAX_FAILURES` in `server/.env` if you iterate on it. It
writes test data to whatever database the API points at -- don't aim it at data you care
about.

GitHub Actions (`.github/workflows/ci.yml`) runs the server tests (with a
`mongo:7` service), the metrics tests and the client build on every push and pull
request to `main`.

## What's deliberately NOT built

See `MVP_BUILD_PLAN.md` section 1 and 11. Still out of scope: email
verification and password reset, SSO, a scheduled (cron) drift job -- monitoring is
batch-triggered or button-triggered -- object storage such as S3 (files are local
disk or discarded), and sandboxed model execution (so pickle/joblib stay off in
production). Notifications are in-app only (the `needs_review` status and review
queues), there is no email or chat alerting.
