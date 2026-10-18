"""
ModelWard metrics microservice.

Start:  uvicorn main:app --host 0.0.0.0 --port $PORT     (dev: uvicorn main:app --port 8000 --reload)

POST /compute-metrics  (multipart: file_type, primary_file, dataset_file)
    Stateless calculator -- no database, nothing persisted. Scores a predictions CSV
    (predicted, actual, protected_attribute [, probability]) or runs an uploaded
    scikit-learn-compatible model (pickle/joblib) against a companion dataset CSV.

Hardening (see README of each module for detail):
  * X-Metrics-Secret shared secret (required when APP_ENV=production, else the app won't start)
  * upload size cap (413), checked before the body is buffered
  * all scoring runs in a short-lived child process with a stripped env, timeout and
    rlimits (runner.py); model files are unpickled through an allow-list (safe_pickle.py)
  * ALLOW_MODEL_FILES=false disables model files entirely -- the safest production setting
  * endpoints are sync `def`, so Starlette runs them in its threadpool and the event loop
    is never blocked by scoring
"""

import hmac
import logging

from fastapi import Depends, FastAPI, File, Form, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.datastructures import Headers

import runner
from config import Settings, get_settings, is_production
from scoring import ScoringError

log = logging.getLogger("modelward.metrics")

# Fail closed: a public production deployment without a secret would accept scoring
# jobs from anyone on the internet.
if is_production() and not get_settings().shared_secret:
    raise RuntimeError(
        "METRICS_SHARED_SECRET must be set when APP_ENV=production "
        "(the metrics service refuses to start without it)"
    )

app = FastAPI(title="ModelWard Metrics Microservice")

MODEL_FILES_DISABLED = "Model file uploads are disabled on this deployment; upload a predictions CSV instead"
SECRET_HEADER = "x-metrics-secret"
MULTIPART_OVERHEAD_BYTES = 64 * 1024
READ_CHUNK = 1024 * 1024


class PayloadTooLarge(Exception):
    pass


def _json(status: int, error: str) -> JSONResponse:
    return JSONResponse(status_code=status, content={"error": error})


def secret_ok(presented, expected: str) -> bool:
    """True when no secret is configured or the presented one matches (constant time)."""
    if not expected:
        return True
    return hmac.compare_digest((presented or "").encode("utf-8"), expected.encode("utf-8"))


class SecretRejected(Exception):
    pass


def require_secret(request: Request) -> None:
    if not secret_ok(request.headers.get(SECRET_HEADER), get_settings().shared_secret):
        raise SecretRejected()


@app.exception_handler(SecretRejected)
async def _secret_rejected(_request: Request, _exc: SecretRejected):
    return _json(401, "Invalid or missing metrics secret")


@app.exception_handler(RequestValidationError)
async def _bad_request(_request: Request, exc: RequestValidationError):
    fields = sorted({str(e["loc"][-1]) for e in exc.errors() if e.get("loc")})
    return _json(400, "Invalid request: missing or malformed field(s): " + (", ".join(fields) or "body"))


class GuardMiddleware:
    """Cheap checks that must happen before the multipart body is buffered:
    the shared secret (so strangers can't make us spool uploads) and the size cap
    (Content-Length up front, or a running byte count for chunked uploads)."""

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http" or scope["method"] != "POST" or scope["path"] != "/compute-metrics":
            return await self.app(scope, receive, send)

        settings = get_settings()
        headers = Headers(scope=scope)
        if not secret_ok(headers.get(SECRET_HEADER), settings.shared_secret):
            return await self._reply(send, 401, "Invalid or missing metrics secret")

        limit = 2 * settings.max_upload_bytes + MULTIPART_OVERHEAD_BYTES  # primary + dataset + framing
        declared = headers.get("content-length")
        if declared and declared.isdigit() and int(declared) > limit:
            return await self._reply(send, 413, self._too_large(settings))

        state = {"seen": 0, "exceeded": False}

        async def counting_receive():
            if state["exceeded"]:
                return {"type": "http.request", "body": b"", "more_body": False}
            message = await receive()
            if message["type"] == "http.request":
                state["seen"] += len(message.get("body", b""))
                if state["seen"] > limit:
                    # Stop feeding the parser; the app will fail to parse a truncated body
                    # and we rewrite whatever it answers into a 413 below.
                    state["exceeded"] = True
                    return {"type": "http.request", "body": b"", "more_body": False}
            return message

        async def rewriting_send(message):
            if state["exceeded"]:
                if message["type"] == "http.response.start":
                    return await self._reply(send, 413, self._too_large(settings))
                return  # swallow the app's own response body
            await send(message)

        await self.app(scope, counting_receive, rewriting_send)

    @staticmethod
    def _too_large(settings: Settings) -> str:
        return f"Upload exceeds the maximum size of {settings.max_upload_bytes} bytes per file"

    @staticmethod
    async def _reply(send, status: int, error: str):
        response = _json(status, error)
        await send({"type": "http.response.start", "status": status, "headers": response.raw_headers})
        await send({"type": "http.response.body", "body": response.body})


app.add_middleware(GuardMiddleware)


@app.get("/health")
async def health():
    return {"ok": True, "service": "modelward-metrics", "allow_model_files": get_settings().allow_model_files}


def _read_limited(upload: UploadFile, max_bytes: int) -> bytes:
    """Read an upload in chunks, refusing to buffer more than max_bytes."""
    chunks, total = [], 0
    while True:
        chunk = upload.file.read(READ_CHUNK)
        if not chunk:
            break
        total += len(chunk)
        if total > max_bytes:
            raise PayloadTooLarge()
        chunks.append(chunk)
    return b"".join(chunks)


# Sync `def` on purpose: Starlette runs it in a worker thread, so waiting on the scoring
# child never blocks the event loop (and /health stays responsive).
@app.post("/compute-metrics")
def compute_metrics(
    file_type: str = Form(...),
    primary_file: UploadFile = File(...),
    dataset_file: UploadFile | None = File(None),
    _auth: None = Depends(require_secret),
):
    settings = get_settings()

    if file_type not in ("csv", "pickle", "joblib"):
        return _json(400, "file_type must be 'csv', 'pickle' or 'joblib'")
    if file_type != "csv" and not settings.allow_model_files:
        return _json(400, MODEL_FILES_DISABLED)

    try:
        primary_bytes = _read_limited(primary_file, settings.max_upload_bytes)
        dataset_bytes = None
        if file_type == "csv":
            mode = "csv"
        else:
            mode = "model"
            if dataset_file is None:
                return _json(400, "dataset_file is required when file_type is 'pickle' or 'joblib'")
            dataset_bytes = _read_limited(dataset_file, settings.max_upload_bytes)

        return runner.run_scoring(mode, primary_bytes, dataset_bytes, settings)

    except PayloadTooLarge:
        return _json(413, f"Upload exceeds the maximum size of {settings.max_upload_bytes} bytes per file")
    except ScoringError as exc:  # explained, user-fixable failure (also timeouts and crashes)
        return _json(400, str(exc))
    except runner.ScoringBusy as exc:
        return _json(503, str(exc))
    except Exception:  # noqa: BLE001 - an internal bug, not bad input: log it, don't leak details
        log.exception("unexpected error in /compute-metrics")
        return _json(500, "Internal error while scoring")
