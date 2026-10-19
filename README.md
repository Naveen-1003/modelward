# ModelWard

An AI model governance platform: register a model → upload a version (CSV
predictions, or a pickle/joblib model in development) → get real/self-reported
metrics → route it through an approval queue → deploy → monitor it with real
data batches (or simulated drift) → see every action in a tamper-evident audit
trail. Built from `MVP_BUILD_PLAN.md` one level up, then hardened following
`QA_GAPS_AND_ENHANCEMENTS.md`.

One platform, many companies: every company is an **organization** with its own
admin, employees, models, thresholds and audit trail, and no organization can see
another's data. Roles: **Super admin** (the platform owner, no organization of its own),
and per organization **Admin**, **ML Engineer / Data Scientist**, **Compliance Officer /
Reviewer**. Employees join with one of their organization's **join codes**; the code
decides the role. See [Organizations, roles and signing up](#organizations-roles-and-signing-up).

Deploying to Vercel + Render + MongoDB Atlas? See **[DEPLOYMENT.md](DEPLOYMENT.md)**.

## Features

- **Multi-organization isolation** -- every query on tenant data is filtered by the
  caller's organization (fail-closed), another organization's ids answer 404, join-code
  signup with email verification and admin approval, a platform super admin.
- **Security hardening** -- join-code gated signup (role fixed by the code),
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
- **Configurable thresholds** -- each organization's admin sets its own low/medium risk
  and drift thresholds; each version records the thresholds it was scored under, and its
  risk tier is re-evaluated on every snapshot.
- **Fairness metrics** -- demographic parity difference, equal-opportunity
  difference, disparate-impact ratio and a per-group table, plus precision,
  recall, F1 and AUC when the data allows. The accuracy-gap number is kept for
  the risk tier.
- **Comments** -- immutable discussion thread on each version.
- **Model card / report** -- printable compliance report per version.
- **Audit trail** -- append-only, hash-chained log with filters, pagination, CSV
  export (compliance/admin) and an admin integrity check
  (`GET /api/audit-log/verify`). Each organization sees only its own entries (ML
  engineers only those about their own work); the super admin sees every organization.
- **Admin user management** -- list/search users, Add user (one-time setup link, no
  password typed by the admin), Pending list with approve / reject / approve all,
  change roles, deactivate/reactivate (blocks login immediately, keeps the audit trail).
- **Organizations** (super admin) -- create an organization together with its first
  admin, edit domains, suspend or re-activate it; org admins manage the two join codes
  (optional expiry and seat limit) and the auto-approve switch.
- **Email** -- verification, setup-link and approval emails through a Google Apps Script
  relay (`EMAIL_PROVIDER=apps_script`), or printed in the server console in development.
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

- **MongoDB** stores structured data only (organizations, users, models, versions,
  metric snapshots, comments, per-organization settings, audit logs).
- **Uploaded files**: with `STORAGE_MODE=local` (the development default) the
  bytes live in `server/uploads/` and Mongo holds a pointer to them. In
  production (`discard`) files are deleted after scoring because Render's disk is
  ephemeral; only the metrics are kept.
- **FastAPI** is a stateless calculator: takes a file, returns accuracy,
  fairness metrics and (for model files) measured latency, remembers nothing.
- **Risk tier** (`low`/`medium`/`high`) is never chosen by the uploader -- it's
  computed server-side in Express from the metrics FastAPI returns and the
  organization's configured thresholds.

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
super admin, email). Start from `server/.env.example` if you don't have one:
`copy .env.example .env`, then set `JWT_SECRET` (any long string in development) and
`SUPER_ADMIN_EMAIL` / `SUPER_ADMIN_PASSWORD` (see
[First run](#first-run-as-the-platform-owner)).

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
| `SUPER_ADMIN_EMAIL` | none | The platform owner: that account becomes `super_admin` at startup (created if `SUPER_ADMIN_PASSWORD` is set). Never created by signup. |
| `SUPER_ADMIN_PASSWORD` / `SUPER_ADMIN_NAME` | none / `Platform Admin` | Used only when the account has to be created (8-72 bytes) |
| `DEFAULT_ORG_NAME` | `Default Organization` | Organization that receives pre-existing data on the first multi-tenant start |
| `EMAIL_PROVIDER` | `console` | `console` prints emails in the server terminal; `apps_script` sends them through the Google Apps Script relay |
| `APPS_SCRIPT_URL` / `APPS_SCRIPT_SECRET` | none | Relay web-app URL (`.../exec`, https) and the shared secret (see [DEPLOYMENT.md](DEPLOYMENT.md#email-google-apps-script-relay)) |
| `EMAIL_FROM_NAME` | `ModelWard` | Sender display name |
| `APP_URL` | first `CLIENT_ORIGIN`, else `http://localhost:5173` | Public address of the web app, used for the links in emails |
| `JOIN_CODE_MAX_FAILURES` / `RESEND_VERIFY_MAX` | `10` / `5` | Invalid join-code attempts per IP per 15 min; verification re-sends per IP and per address per hour |
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

## Organizations, roles and signing up

| Role | Scope | How to get one |
|---|---|---|
| Super admin | The whole platform (only you) | `SUPER_ADMIN_EMAIL` (+ `SUPER_ADMIN_PASSWORD`) at startup, or `npm run seed:superadmin`. Never through signup. |
| Admin | One organization | Created together with the organization by the super admin (one-time setup link), or by another admin of that org with **Add user** |
| ML Engineer | One organization | The organization's **ML Engineer join code**, or Add user |
| Compliance Officer | One organization | The organization's **Compliance Officer join code**, or Add user |

- **Join codes.** Each organization has two random 12-character codes; the code, not the
  signing-up person, decides the role, and admin is never obtainable through a code. Org
  admins see them in the **Organization** tab, can **regenerate** one (the old code stops
  working at once) and may set an **expiry date** and/or a **seat limit** (both optional, off
  by default; every change is audited). Wrong, expired, full, suspended-org and wrong-domain
  attempts all return the same 403 "Invalid code or email not eligible", so nobody can learn
  which organizations exist.
- **Signup flow.** (1) code, name and email at `/signup`; (2) the address's domain must
  exactly equal one of the organization's allowed domains (no subdomains unless listed;
  the super admin can switch the rule off for organizations without their own domain, and
  then free-mail addresses are accepted); (3) a link is emailed; opening it confirms the
  address and the person **chooses their password there** (so nobody can register someone
  else's address with a password they know); (4) the organization admin approves in the
  **Pending** tab (or an optional per-org **auto-approve** admits verified addresses on an
  allowed domain). Unverified signups expire after 7 days and can be replaced by a new signup
  for the same address. Pending accounts cannot sign in.
- **Add user.** An org admin can add a person directly (name, email, role): no approval step,
  and the person gets a one-time setup link (72 hours) to set their own password. The domain
  rule still applies unless the admin ticks "allow external email" (audited).
- **Super admin.** Sees the **Organizations** tab (create, edit domains, suspend), and works
  inside one selected organization at a time (the client sends `X-Org-Id`); the first access
  to an organization each hour is written to its audit log as `org_access`. Reviews
  (approve / reject / request changes) stay with compliance officers.
- **Email.** With `EMAIL_PROVIDER=console` (the development default) emails are printed in the
  server terminal and the signup response carries `devVerifyUrl`; setup links are shown on
  screen. In production, self-signup is disabled while the provider is `console`.

Passwords are 8-128 characters. One person has one account: email is globally unique,
case-insensitive and `+tag` is ignored. Suspending an organization blocks all its users'
sessions immediately.

### First run as the platform owner

1. In `server/.env` set `SUPER_ADMIN_EMAIL` and `SUPER_ADMIN_PASSWORD` (and optionally
   `SUPER_ADMIN_NAME`). Existing accounts are promoted by email, never demoted.
2. Start the API (`npm run dev`). Look for `[super-admin] created super_admin ...` in the log
   (or run `npm run seed:superadmin` on its own).
3. Sign in at http://localhost:5173/login with those credentials.
4. Open **Admin > Organizations**, fill in name, address, admin email and allowed domains, and
   create the organization. Copy the **setup link** shown on screen (or, with
   `EMAIL_PROVIDER=apps_script`, the admin receives it by email) and send it to the org admin,
   who sets a password and shares the join codes with their employees.

**Existing data.** On the first start after upgrading, a one-time, idempotent migration puts
all current users, models, versions, comments, snapshots, settings and audit rows into one
organization named by `DEFAULT_ORG_NAME` ("Default Organization", domain rule off). Current
admins become its admins; give your own account the `super_admin` role with `SUPER_ADMIN_EMAIL`.
Nothing is invented on an empty database.

## Tenant isolation

- `orgId` is on User, Model, Version, Comment, MetricSnapshot, Settings and AuditLog. One
  Mongoose plugin (`server/utils/tenant.js`) adds the organization filter to every query and
  aggregation, using the organization of the logged-in user (kept in `AsyncLocalStorage`). A
  query with no organization context **fails closed** (400 `ORG_REQUIRED`) instead of running
  unfiltered.
- The organization is read from the user record on every request -- never from the body, a
  query string or the token. The one exception is the super admin's `X-Org-Id` header,
  checked against the Organization collection.
- Another organization's ids answer **404**, never 403; probes are written to the audit log as
  `cross_org_attempt`. Model names are unique per organization.
- Thresholds, join codes, pending approvals and last-active-admin protection are per
  organization. Audit entries carry the `orgId`; the hash chain stays one global sequence.
- The explicit ways out of the filter (`bypassTenant` query option, `runSystem`) are limited
  to a reviewed allow-list of files: `middleware/auth.js`, `middleware/audit.js`,
  `utils/auditChain.js`, `utils/crossOrg.js`, `utils/superAdmin.js`, `utils/tenant.js`,
  `routes/auth.js`, `routes/orgs.js`, `routes/users.js` (actor re-check),
  `routes/audit.js` (super admin all-organizations view), `routes/stats.js`,
  `migrations/index.js`, `jobs/cleanup.js`, `jobs/expireUnverified.js`.
  `server/tests/tenantAllowlist.test.js` fails if either appears anywhere else.
- **Audit log.** Org admins and compliance officers see their own organization's log; the
  super admin sees the selected organization's, or with none selected every organization's
  plus platform events (rows carry `orgId`/`orgName`, optional `?orgId=` filter). Verify:
  a super admin gets the full chain result (`ok`, `checked`, `head`, `brokenSeqs`, ...);
  an org admin gets `{ ok, entries, brokenInOrg, hashAlgs, keyed, legacyUnchained }`, where
  `ok` covers the whole chain but everything else concerns that organization's own entries.

## Trying it out

1. Sign in as the platform owner and create an organization (see
   [First run](#first-run-as-the-platform-owner)). As its admin, open **Organization** to
   see the two join codes. Then create two more accounts: at `/signup` with the ML Engineer
   code and the Compliance Officer code (the verification link is printed in the API
   terminal; open it, choose a password, then approve each request in the admin **Pending**
   tab), or use **Add user**.
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
   management and the Pending list, join codes, risk/drift thresholds (this
   organization's only), Trash (restore archived models/versions).
8. Every dashboard has an **Audit Trail** with filters and paging; compliance
   officers and admins can export it as CSV, and an admin can verify the hash
   chain (`GET /api/audit-log/verify`).

The person who uploaded a version can never review it (approve, reject, request changes,
deploy, retire or resolve its drift review); the server enforces this whatever their role.

## Sample data (`sample-data/`)

| File | Use it for | Expect |
|---|---|---|
| `good_predictions.csv` | CSV upload (with a latency value) or a healthy monitoring batch | ~95% accuracy -> `low` risk |
| `bad_predictions.csv` | CSV upload or a degraded monitoring batch | ~45% accuracy -> `high` risk (approval needs a comment); flags drift when used as a batch |
| `dummy_model.joblib` + `model_dataset.csv` | Model-file upload (needs `ALLOW_MODEL_FILES=true`, i.e. development): upload the model as the file and the CSV as the dataset | Real `.predict()` and measured latency |
| `mismatched_dataset.csv` | Pair with `dummy_model.joblib` | Clean `upload_failed` (wrong feature count), not a crash |
| `generate_samples.py` | Regenerate all of the above: from `sample-data/` run `..\metrics-service\venv\Scripts\python generate_samples.py` | |
| `smoke_test.ps1` | End-to-end API check across two organizations, see below | One PASS/FAIL line per check |

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

**Smoke test** against a running **development** stack (PowerShell; uses `curl.exe` for
uploads). Start the API with the platform owner configured, then give the script the same
credentials:
```
# server terminal (fresh or existing database; EMAIL_PROVIDER stays console)
$env:SUPER_ADMIN_EMAIL = "owner@modelward.test"; $env:SUPER_ADMIN_PASSWORD = "OwnerPass!123"; npm run dev

# another terminal
$env:SUPER_ADMIN_EMAIL = "owner@modelward.test"; $env:SUPER_ADMIN_PASSWORD = "OwnerPass!123"
.\sample-data\smoke_test.ps1                    # defaults to http://127.0.0.1:5000/api
.\sample-data\smoke_test.ps1 -Api http://127.0.0.1:5000/api -SuperAdminEmail owner@modelward.test -SuperAdminPassword 'OwnerPass!123'
```
It signs in as the super admin, creates two organizations (reading the join codes and setup
links from the API), completes both admins' setup, signs up an ML engineer and a compliance
officer per organization with the join codes (the dev server returns `devVerifyUrl`), approves
them, runs the full governance scenarios inside organization 1, and then checks isolation:
organization 2 cannot see or touch organization 1's models, versions, comments, files, users,
codes, trash or audit entries (404 / absence); the super admin sees the right organization
with `X-Org-Id` and gets 400 `ORG_REQUIRED` without it; join codes, domain rules, seat limits,
regenerated codes and suspended organizations behave as designed. It exits `1` if any check
fails and skips steps that need model files or drift simulation when those are disabled. It
needs a server that returns the verification link, so it cannot run against a production
deployment that sends real email. Each run creates new organizations, users and models (they
are never deleted), and uses about 13 signups, 8 rejected join codes and 6 failed logins from
your IP, so the per-IP limits allow about one run per 15 minutes to an hour; raise
`SIGNUP_MAX_PER_HOUR`, `JOIN_CODE_MAX_FAILURES` and `LOGIN_MAX_FAILURES` in `server/.env`
if you iterate on it. It writes test data to whatever database the API points at -- don't aim
it at data you care about.

GitHub Actions (`.github/workflows/ci.yml`) runs the server tests (with a
`mongo:7` service), the metrics tests and the client build on every push and pull
request to `main`.

## What's deliberately NOT built

See `MVP_BUILD_PLAN.md` section 1 and 11. Still out of scope: password reset, single
sign-on (SSO), multi-factor authentication for the super admin account, a scheduled (cron)
drift job -- monitoring is batch-triggered or button-triggered -- object storage such as S3
(files are local disk or discarded), and sandboxed model execution (so pickle/joblib stay off
in production). Notifications are in-app (the `needs_review` status and review queues) plus
the verification, setup-link and approved/rejected emails; there is no email or chat alerting
for review or drift events. The Apps Script relay is limited to 100 recipients a day.
