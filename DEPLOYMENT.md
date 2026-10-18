# Deploying ModelWard

Production layout: **React client on Vercel**, **Express API and FastAPI metrics
service on Render**, **MongoDB on Atlas**.

```
Browser ──► Vercel (static React build)
   │
   └──► Render: modelward-api (Express) ──► MongoDB Atlas
                    │
                    └──► Render: modelward-metrics (FastAPI, CSV scoring)
```

The metrics service never sees the database or the JWT secret. Express calls it
with a shared secret in the `X-Metrics-Secret` header.

> Free tiers sleep. See [Free-tier cold starts](#free-tier-cold-starts) before you
> demo this to anyone.

Contents: [Deploy order](#deploy-order) · [1 Atlas](#1-mongodb-atlas) ·
[2 Metrics](#2-render-metrics-service) · [3 API](#3-render-api) ·
[4 Vercel](#4-vercel-client) · [5 CORS](#5-set-client_origin-and-verify) ·
[Routing options](#routing-option-a-vite_api_url--cors-default-vs-b-vercel-rewrite) ·
[First admin](#6-create-the-first-admin) · [Env vars](#environment-variables) ·
[Security](#security-posture) · [Storage](#ephemeral-disk-and-storage_mode) ·
[Retention](#retention-job) · [Audit](#audit-log-integrity) ·
[Backups](#backups) · [Checklist](#pre-launch-checklist) ·
[Troubleshooting](#troubleshooting)

## Deploy order

Each step needs a value from the one before it:

1. **Atlas** gives you `MONGO_URI`.
2. **Metrics service** (Render) gives you its URL and a generated `METRICS_SHARED_SECRET`.
3. **API** (Render) needs `MONGO_URI`, the metrics URL and the metrics secret. It gives you the API URL.
4. **Client** (Vercel) needs the API URL (`VITE_API_URL`). It gives you the site origin.
5. Go back to the API and set `CLIENT_ORIGIN` to that origin.

## 1. MongoDB Atlas

1. Create a free **M0** cluster (any region; pick one close to your Render region).
2. **Database Access** > Add Database User > password authentication. Give it the
   built-in role **Read and write to any database**, or a custom role limited to the
   `modelward` database. Use a generated password without special characters, or
   URL-encode them in the connection string.
3. **Network Access** > Add IP Address > **Allow access from anywhere
   (`0.0.0.0/0`)**.
   - Why: Render's free tier does not give you a fixed outbound IP, so there is
     nothing stable to allow-list. The database is still protected by the user
     name, a long random password and TLS.
   - Tighten later: on a paid Render plan, or by moving to a Render region/plan with
     static outbound IPs, replace `0.0.0.0/0` with those addresses.
4. **Database** > Connect > Drivers > copy the `mongodb+srv://` string and **add the
   database name** before the `?`:

   ```
   mongodb+srv://<user>:<password>@<cluster>.mongodb.net/modelward?retryWrites=true&w=majority
   ```

   Without `/modelward`, the driver uses the `test` database.
5. The server creates its own collections and indexes on first start
   (`migrations.runMigrations()` runs before it begins listening). Nothing to set up by hand.

## 2. Render: metrics service

Option A, with the Blueprint (recommended): in Render choose **New > Blueprint**, pick
this repository and apply `render.yaml`. It creates both services. Render prompts for the
`sync: false` values (see the table below). The API needs the metrics URL and the generated
metrics secret, which only exist after the metrics service has been created. If Render lets
you skip a prompt, fill `METRICS_SERVICE_URL` and `METRICS_SHARED_SECRET` in later under the
API service's Environment tab; until you do, the API fails its startup checks (that is
expected). If it insists on a value, enter a placeholder and replace it in step 3.

Option B, manually: **New > Web Service**, then:

| Setting | Value |
|---|---|
| Runtime | Python 3 |
| Root directory | `metrics-service` |
| Build command | `pip install -r requirements.txt` |
| Start command | `uvicorn main:app --host 0.0.0.0 --port $PORT` |
| Health check path | `/health` |
| Instance type | Free |

Environment (also pinned in `render.yaml`):

- `PYTHON_VERSION` = `3.11.9`
- `APP_ENV` = `production` (makes the shared secret mandatory)
- `METRICS_SHARED_SECRET` = a random string (the Blueprint generates one; otherwise
  `python -c "import secrets; print(secrets.token_urlsafe(32))"`)
- `ALLOW_MODEL_FILES` = `false`

After the first deploy, open `https://<metrics>.onrender.com/health`. Expect
`{"ok":true,"service":"modelward-metrics","allow_model_files":false}`.
Then **copy `METRICS_SHARED_SECRET` from the metrics service's Environment tab**; you need it in step 3.

## 3. Render: API

Manual settings (the Blueprint already does this):

| Setting | Value |
|---|---|
| Runtime | Node |
| Root directory | `server` |
| Build command | `npm ci` |
| Start command | `node server.js` |
| Health check path | `/health` |
| Instance type | Free |

Set the environment variables listed in the [server table](#api-server-modelward-api).
Do not set `PORT`; Render injects it. The ones you must supply:

- `MONGO_URI`: from step 1.
- `METRICS_SERVICE_URL`: `https://<metrics>.onrender.com` (no trailing slash).
- `METRICS_SHARED_SECRET`: **the same value as on the metrics service.** Render
  cannot share a generated value between two services, so this is a manual copy. A
  mismatch shows up as retryable `upload_failed` versions (the metrics service answers 401).
- `JWT_SECRET`: the Blueprint generates a 32+ character random value. If you set it
  yourself, use at least 32 random characters. In production the server refuses to
  start with anything shorter or with a known dev default.
- `ADMIN_INVITE_CODE` / `COMPLIANCE_INVITE_CODE`: long random strings you will use in
  step 6. Leaving one unset disables self-signup for that role.
- `CLIENT_ORIGIN`: leave empty for now (step 5).

`/health` returns 200 only when the database connection is up and 503 otherwise, so a
failing health check on Render usually means a Mongo problem. Check the service logs
first. A weak `JWT_SECRET` or a missing `METRICS_SHARED_SECRET` makes the process exit at
startup with a message listing what is wrong.

## 4. Vercel: client

1. **Add New > Project**, import the repository.
2. Project settings:

   | Setting | Value |
   |---|---|
   | Framework preset | Vite |
   | Root directory | `client` |
   | Build command | `npm run build` |
   | Output directory | `dist` |
   | Environment variable | `VITE_API_URL` = `https://<api>.onrender.com` (no trailing slash, no `/api`) |

3. Deploy. `client/vercel.json` already contains the single-page-app fallback so a
   browser refresh on `/ml/models/123` does not 404.
4. `VITE_API_URL` is baked in at build time. Changing it later needs a **redeploy**.

## 5. Set `CLIENT_ORIGIN` and verify

On the API service set `CLIENT_ORIGIN` to the exact site origin: scheme and host, **no
trailing slash and no path**, for example `https://modelward.vercel.app`. Several origins
(for example a custom domain plus the `*.vercel.app` one) can be listed separated by commas.
Vercel preview deployments have their own URLs and are not allowed unless you add them.

Redeploy the API after changing it, then:

```
curl https://<api>.onrender.com/health
curl https://<api>.onrender.com/api/config
```

`/api/config` should show `"allowModelFiles":false` and `"storageMode":"discard"`.
Then run the [smoke test](#pre-launch-checklist) against the API.

### Routing option A (`VITE_API_URL` + CORS, default) vs B (Vercel rewrite)

**A. `VITE_API_URL` + CORS (what the steps above set up).** The browser calls the Render URL
directly. CORS is the only gate, so `CLIENT_ORIGIN` must match exactly.

- Pros: simple, no proxy in the path, long-running requests only face Render's limits.
- Cons: you must keep `CLIENT_ORIGIN` correct; the API URL is visible in the bundle (it is
  public anyway).

**B. Vercel rewrite of `/api/*` to Render.** The browser only ever talks to the Vercel origin,
so there is no CORS to configure and `VITE_API_URL` stays **unset**. Replace
`client/vercel.json` with this (the API rule has to come before the SPA fallback):

```json
{
  "rewrites": [
    { "source": "/api/:path*", "destination": "https://<api>.onrender.com/api/:path*" },
    { "source": "/(.*)", "destination": "/index.html" }
  ],
  "headers": [
    {
      "source": "/assets/(.*)",
      "headers": [{ "key": "Cache-Control", "value": "public, max-age=31536000, immutable" }]
    }
  ]
}
```

Cautions for B:

- Requests now pass through Vercel's proxy as well as Render's. Vercel limits how long a
  proxied request may take, and I have not verified the current figure for your plan. A
  cold-starting Render service plus a first scoring run can take over a minute, so test the
  first upload after an idle period before relying on this. If it times out, use option A.
- The API sees Vercel's servers as the client. Per-IP rate limits (failed logins, signups,
  general API) may then be shared between users. Check how the forwarded IP is reported on your
  setup before trusting those limits, and keep `TRUST_PROXY=1`.
- Keep `CLIENT_ORIGIN` set anyway if anyone may also call the API from a browser directly.

## 6. Create the first admin

There is no default account. The API lets anyone register as `ml_engineer`, but `admin` and
`compliance_officer` need the invite codes you set in step 3.

1. Open the deployed site > Sign up > choose **Admin** and enter `ADMIN_INVITE_CODE`.
   (The form shows the invite-code field for roles that need one.)
2. Or do it from a terminal (nothing but the API URL and the code is needed):

   ```
   curl -X POST https://<api>.onrender.com/api/auth/signup \
     -H "Content-Type: application/json" \
     -d '{"name":"Your Name","email":"you@example.com","password":"<8+ chars>","role":"admin","inviteCode":"<ADMIN_INVITE_CODE>"}'
   ```

3. From then on, create everyone else in the **Admin portal > Users** (name, email, initial
   password, role), or hand out `COMPLIANCE_INVITE_CODE` for compliance-officer self-signup.
   Deactivating a user blocks login immediately and keeps their audit trail.
4. Once your admins exist, **remove `ADMIN_INVITE_CODE`** from the API service (and redeploy).
   Admin self-signup is then disabled entirely; existing admins can still create admins.

Passwords must be 8-128 characters.

## Environment variables

### API server (`modelward-api`)

Read only through `server/config/env.js`. Copy `server/.env.example` for local development.

| Variable | Required | Default | Example / notes |
|---|---|---|---|
| `NODE_ENV` | yes (prod) | `development` | `production`. Turns on strict checks. |
| `PORT` | no | `5000` | Render injects it; do not set. |
| `NODE_VERSION` | Render only | Render default | `20.18.0`. Render-specific, not read by the app. |
| `MONGO_URI` | **yes** | `mongodb://127.0.0.1:27017/modelward` | `mongodb+srv://u:p@cluster.mongodb.net/modelward?retryWrites=true&w=majority`. Production refuses `localhost`. |
| `JWT_SECRET` | **yes** | none | 32+ random chars in production. `openssl rand -base64 48` |
| `JWT_EXPIRES_IN` | no | `12h` | `8h` |
| `CLIENT_ORIGIN` | yes for option A | empty | `https://modelward.vercel.app`. Comma list, exact, no trailing slash. Empty in production = no cross-origin access. |
| `TRUST_PROXY` | **yes on Render** | off | `1`. Needed so rate limits see real client IPs. |
| `METRICS_SERVICE_URL` | **yes** | `http://127.0.0.1:8000` | `https://modelward-metrics.onrender.com` |
| `METRICS_SHARED_SECRET` | **yes (prod)** | none | Must equal the metrics service's value. |
| `METRICS_TIMEOUT_MS` | no | `90000` | Per-request timeout to the metrics service. |
| `METRICS_WAKE_TIMEOUT_MS` | no | `60000` prod / `0` dev | How long to poll `/health` for a sleeping metrics service. |
| `ALLOW_MODEL_FILES` | no | `false` prod / `true` dev | Keep `false` in production. Must match the metrics service. |
| `STORAGE_MODE` | no | `discard` prod / `local` dev | `discard` on Render. See [Storage](#ephemeral-disk-and-storage_mode). |
| `UPLOAD_DIR` | no | `server/uploads` | Only used when `STORAGE_MODE=local`. |
| `MAX_UPLOAD_MB` | no | `25` | Per file. Larger returns 413. |
| `RETENTION_DAYS` | no | `30` | See [Retention](#retention-job). |
| `ADMIN_INVITE_CODE` | recommended | none | Unset = nobody can self-register as admin. |
| `COMPLIANCE_INVITE_CODE` | recommended | none | Unset = nobody can self-register as compliance officer. |
| `ENABLE_DRIFT_SIMULATION` | no | `true` | `false` on a real deployment that only uses monitoring batches. |
| `LOGIN_MAX_FAILURES` | no | `10` | Failed logins per IP per window before 429. |
| `LOGIN_WINDOW_MINUTES` | no | `15` | |
| `SIGNUP_MAX_PER_HOUR` | no | `20` | Signup requests per IP per hour. |
| `API_MAX_PER_MINUTE` | no | `600` | General per-IP limit. |

### Metrics service (`modelward-metrics`)

Plain environment variables only (the service does not read `.env` files). See
`metrics-service/.env.example`.

| Variable | Required | Default | Example / notes |
|---|---|---|---|
| `APP_ENV` | yes (prod) | `development` | `production`. The app refuses to start without a secret in production. |
| `PYTHON_VERSION` | Render only | Render default | `3.11.9` (full `x.y.z`). |
| `METRICS_SHARED_SECRET` | **yes (prod)** | none | Same value as on the API. Compared in constant time. |
| `ALLOW_MODEL_FILES` | no | `false` prod / `true` otherwise | Keep `false` in production. |
| `MAX_UPLOAD_BYTES` | no | `26214400` | Per file. Larger returns 413. |
| `METRICS_MIN_ROWS` | no | `30` | Fewer rows is a 400. |
| `METRICS_MIN_GROUP_ROWS` | no | `10` | Smallest allowed protected-attribute group. |
| `METRICS_MAX_ROWS` | no | `200000` | Row cap. Lower it on a 512 MB free instance (check your plan's memory). |
| `SCORING_TIMEOUT_SECONDS` | no | `60` | Scoring child process is killed after this. |
| `SCORING_MAX_MEMORY_MB` | no | `2048` | Linux only; `0` disables. |
| `SCORING_MAX_CONCURRENT` | no | `2` | Extra setting from `metrics-service/.env.example`. |

### Client (Vercel)

| Variable | Required | Default | Notes |
|---|---|---|---|
| `VITE_API_URL` | option A: yes | unset (same-origin `/api`) | `https://modelward-api.onrender.com`. No trailing slash, no `/api`. Build-time: redeploy after changing. See `client/.env.example`. |

## Security posture

- **Pickle / joblib uploads are OFF in production.** Loading a pickle or joblib file
  runs arbitrary code. With signup open to `ml_engineer`, any visitor could otherwise execute
  code on your metrics service. `ALLOW_MODEL_FILES=false` makes the API reject those uploads
  with a 400 and the metrics service refuse them too, so a leaked secret alone cannot re-enable them.
  Set it on **both** services, and keep it `false`.
- The metrics service also has a restricted unpickler (allow-list of classes), runs scoring in
  a child process with a timeout and memory limit, and never receives your database URI or JWT
  secret. Treat all of this as **defense in depth only**. An allow-list reduces the attack
  surface; it does not make loading untrusted pickles safe.
- If you must enable model files: restrict uploads to staff you trust (no open ML-engineer
  signup: remove self-signup by creating users from the Admin portal), keep the metrics service
  on its own Render service with no other secrets, set `METRICS_SHARED_SECRET`, enable
  `ALLOW_MODEL_FILES=true` on both services, and accept that this is only as safe as your least
  trusted uploader. A better long-term route is a non-executable format (skops, ONNX) or a
  sandboxed, network-less container for scoring.
- Production startup refuses a weak `JWT_SECRET`, a missing `METRICS_SHARED_SECRET`, or a
  `localhost` Mongo URI. CORS is an explicit allow-list. Responses never contain server file
  paths. Failed logins, signups and every state change are audited.
- **Rotating secrets**
  - `JWT_SECRET`: change it on the API and redeploy. Every issued token is invalidated and
    everyone has to sign in again.
  - `METRICS_SHARED_SECRET`: change it on **both** services. Until both have redeployed, uploads
    fail with a retryable error. Update the metrics service first, then the API.
  - Invite codes: change them whenever you like; existing accounts are unaffected.
  - Atlas password: change it in Atlas, update `MONGO_URI`, redeploy the API.

## Free-tier cold starts

Render's free web services spin down after a period of inactivity and take roughly 50 seconds
to wake on the next request (Render's figure, may vary). Both services sleep independently. The
first upload after an idle spell is the worst case: the API may need to wake, then the metrics
service has to wake, then scoring itself runs.

What the code does about it:

- Before calling the metrics service, the API polls its `/health` for up to
  `METRICS_WAKE_TIMEOUT_MS` (60 s in production) so the scoring request lands on a warm instance.
- The scoring request then has `METRICS_TIMEOUT_MS` (90 s).
- If it still fails because the service was unreachable, timed out, or returned 5xx/401/403, the
  version is saved as `upload_failed` with `retryable: true`. The ML engineer uses **Retry
  scoring** on that version (`POST /api/versions/:id/retry`; the uploaded file is kept for
  retryable failures). Errors caused by
  the file itself (bad columns, too few rows, and so on) are not retryable and need a new upload.
- The very first page load of the site can also be slow if the API is asleep.

Optional: keep both services awake with an external uptime pinger (UptimeRobot, cron-job.org,
a GitHub Actions schedule, ...) that requests `https://<api>.onrender.com/health` and
`https://<metrics>.onrender.com/health` every 10 minutes or so. Check Render's current free-tier
instance-hour allowance first: keeping two services up around the clock may use more hours than
the free plan includes. A paid instance type removes the problem.

## Ephemeral disk and `STORAGE_MODE`

Render's free web services have an ephemeral filesystem: files vanish on every deploy, restart
and spin-down. `STORAGE_MODE` decides how the API deals with uploads:

| | `discard` (production default) | `local` (development default) |
|---|---|---|
| After scoring | Uploaded files are deleted. Only the metrics and file names are stored in MongoDB. | Files are kept in `UPLOAD_DIR`. |
| Download (`GET /api/versions/:id/file`) | 404 `File not retained`. | Works while the file exists on disk. |
| Retry scoring | Only for **retryable** failures (such as a sleeping metrics service); the file is kept just for those. If the instance restarts in between, the file is gone and the version has to be uploaded again. | Works. |
| Good for | Render free tier, CSV-only governance workflows. | Local development, or a host with a persistent disk. |

If you attach a persistent disk or move to object storage later, set `STORAGE_MODE=local` and
`UPLOAD_DIR` to the mounted path. Monitoring-batch files are always discarded after scoring.

## Retention job

On startup (after about 30 seconds) and then every 6 hours the API runs a cleanup that deletes
**files** (never database rows) for:

- versions archived more than `RETENTION_DAYS` days ago (default 30), and
- `upload_failed` versions that have not changed for that long,

and removes orphan files in `UPLOAD_DIR` older than a day that no version refers to. Archived
rows stay in MongoDB and remain restorable from the Admin Trash. In `discard` mode there is
rarely anything to clean.

## Audit-log integrity

The audit log is append-only and hash-chained (each entry stores `seq`, `prevHash` and `hash`).
Admins can check the chain at any time:

```
curl -H "Authorization: Bearer <admin token>" https://<api>.onrender.com/api/audit-log/verify
# {"ok":true,"checked":1234,"legacyUnchained":12}
# on tampering: {"ok":false,...,"brokenAtSeq":57}
```

`legacyUnchained` counts old entries written before chaining existed. Compliance officers and
admins can also export the log as CSV from the Audit Trail (or `GET /api/audit-log/export`).
Run the verify call after any manual database work and before audits.

## Backups

All state is in MongoDB. Atlas **M0** (free) clusters do not include automated cloud backups
as far as I know (confirm in the Atlas UI), so take your own snapshots:

```
mongodump --uri "<MONGO_URI>" --out backup-$(date +%F)
```

Paid Atlas tiers add Cloud Backup with point-in-time restore; turn it on before storing real
data. Test a restore once. Soft-deleted items are still in the database and are included.

## Pre-launch checklist

- [ ] Atlas user has a unique, generated password; `MONGO_URI` includes `/modelward`.
- [ ] **Delete demo/test accounts and data** (anything created while developing: smoke-test
      users, sample models). Start production from an empty database, or archive and purge them.
- [ ] `JWT_SECRET` is a unique generated value (not reused from development); **rotate it** if
      it was ever pasted in chat, a ticket or a commit.
- [ ] `METRICS_SHARED_SECRET` is identical on both services.
- [ ] `ADMIN_INVITE_CODE` and `COMPLIANCE_INVITE_CODE` are set to long random values, the first
      admin exists, and `ADMIN_INVITE_CODE` has been removed again.
- [ ] `ALLOW_MODEL_FILES=false` on both services (check `/api/config` and the metrics `/health`).
- [ ] `CLIENT_ORIGIN` is the exact origin: scheme + host, **no trailing slash**, no path
      (or you chose the Vercel rewrite option).
- [ ] `TRUST_PROXY=1` on the API.
- [ ] `ENABLE_DRIFT_SIMULATION` decided (`false` if the simulate button should not exist).
- [ ] Thresholds reviewed in Admin > Settings (low/medium risk and drift thresholds).
- [ ] `GET /health` on both services returns ok; Render health checks are green.
- [ ] **Run the smoke test against the production URL**, with existing accounts so you do not
      need invite codes on the command line:
      `.\sample-data\smoke_test.ps1 -Api https://<api>.onrender.com/api -AdminEmail ... -AdminPassword ... -ComplianceEmail ... -CompliancePassword ...`
      (it creates throwaway models and users, so delete or archive them afterwards).
- [ ] Audit verify (`/api/audit-log/verify`) returns `ok: true`.
- [ ] Backup plan in place (see Backups).
- [ ] Decided how to handle cold starts (accept, pinger, or paid instance).

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Browser console: CORS error / "blocked by CORS policy"; API log shows `CORS_NOT_ALLOWED` | `CLIENT_ORIGIN` does not match the page's origin exactly (trailing slash, `http` vs `https`, `www.` vs apex, a Vercel preview URL). Fix it and redeploy the API. Or use the Vercel rewrite option. |
| Login works, then every page bounces back to the sign-in screen (401 loop) | `JWT_SECRET` changed or differs between instances, the account was deactivated, or the token expired (`JWT_EXPIRES_IN`, default 12 h). Also check the client really calls the API (`VITE_API_URL` set at build time) and not Vercel's `/api`, which returns the SPA page or a 404. |
| Every `/api/...` call returns HTML or 404 from Vercel | `VITE_API_URL` is unset and there is no rewrite. Set it and redeploy the client. |
| Upload ends as `upload_failed` with a "metrics service unreachable / timed out" message and Retry scoring is offered | Cold start. Wait a minute and press **Retry scoring**. See cold starts. |
| `upload_failed`, still retryable after waking the service | `METRICS_SHARED_SECRET` mismatch (the metrics service answers 401), wrong `METRICS_SERVICE_URL`, or the metrics service crashed. Check its logs and `/health`. |
| `upload_failed`, not retryable | The file itself: wrong columns, fewer than 30 rows, a group smaller than 10 rows, NaNs, bad labels. The message says which. Fix the CSV and upload again. |
| Upload rejected with 400 mentioning model files | `ALLOW_MODEL_FILES=false`: only CSV is accepted in production. |
| 413 on upload | File larger than `MAX_UPLOAD_MB` (API) or `MAX_UPLOAD_BYTES` (metrics). |
| 429 "Too many failed login attempts / signup attempts / requests" | Per-IP rate limit. Wait for the time in the message (`Retry-After` header). Check `TRUST_PROXY=1`, otherwise everybody shares the proxy's IP. Raise `LOGIN_MAX_FAILURES`, `SIGNUP_MAX_PER_HOUR` or `API_MAX_PER_MINUTE` if legitimate. |
| API exits at startup: "Invalid configuration" | The message lists the problem: short/missing `JWT_SECRET`, missing `METRICS_SHARED_SECRET`, or `MONGO_URI` still pointing at localhost. |
| Mongo: `bad auth` / "Authentication failed" | Wrong database user or password in `MONGO_URI`; special characters in the password must be URL-encoded; the user needs access to the `modelward` database. |
| Mongo: `ENOTFOUND`, `ECONNREFUSED`, "server selection timed out" | Atlas Network Access does not allow Render (add `0.0.0.0/0`), the cluster is paused, or the host name is mistyped. |
| Render health check keeps failing on the API | `/health` returns 503 until MongoDB is connected. Fix `MONGO_URI` or Atlas access. Also confirm the service listens on Render's `$PORT` (do not set `PORT` yourself). |
| Render health check failing on the metrics service | In production it will not start without `METRICS_SHARED_SECRET`; the build must also have installed `requirements.txt` (check `PYTHON_VERSION`). |
| First request after idle takes about a minute | Free-tier wake-up. Normal. |
| Downloads return 404 `File not retained` | `STORAGE_MODE=discard` (expected on Render). |
| `render.yaml` rejected by Render | See the note below and Render's current Blueprint specification. |

### Notes on `render.yaml`

`render.yaml` uses keys I believe are valid in the Blueprint spec (`type`, `name`, `runtime`,
`plan`, `region`, `rootDir`, `buildCommand`, `startCommand`, `healthCheckPath`, `autoDeploy`,
`envVars` with `key`/`value`/`sync`/`generateValue`). It could not be validated against
Render's service here (it was only checked to be valid YAML). If Render rejects a key, compare
against the current Blueprint specification; the manual settings above give the same result.
Render may also want a specific `NODE_VERSION` format; if `20.18.0` is rejected, use another
Node 20 release.

### Behind a proxy (TRUST_PROXY hop count)

Rate limiting keys on `req.ip`, which Express derives from `X-Forwarded-For` only for the
hops listed in `TRUST_PROXY`. Set it to the exact number of reverse proxies in front of the
API (Render: `1`). Too low and every client shares the proxy's IP (one user's failed logins
lock everybody out); too high, or `true`, and a client can invent its own `X-Forwarded-For`
and dodge the limits. Verify after deploying: the API log (`combined` format) should show your real client address, not the proxy's, and a failed-login burst from your machine (default 10 per IP) must not lock out a user on a different network. IPv6 clients are limited per
/64, IPv4-mapped addresses count as their IPv4. Invalid `TRUST_PROXY` values stop the server at
startup with a configuration error.
