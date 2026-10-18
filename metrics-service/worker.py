"""
Scoring worker: runs in a short-lived child process started by runner.py.

    python -I worker.py <workdir>

Reads <workdir>/request.json, scores, and writes <workdir>/result.json. Stdout is never
used for results: an unpickled object may print anything, so the parent only trusts the
result file (and treats a missing/garbled one as a crash).
"""

import json
import os
import sys
import threading

# -I drops the script directory from sys.path; put it back so `import scoring` works.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

WATCHDOG_GRACE_SECONDS = 5  # backstop in case the parent's kill doesn't land (e.g. orphaned grandchild)


def _write_result(workdir: str, payload: dict) -> None:
    tmp = os.path.join(workdir, "result.json.tmp")
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, allow_nan=False)
    os.replace(tmp, os.path.join(workdir, "result.json"))


def main(workdir: str) -> int:
    with open(os.path.join(workdir, "request.json"), encoding="utf-8") as fh:
        request = json.load(fh)

    watchdog = threading.Timer(request["timeout_seconds"] + WATCHDOG_GRACE_SECONDS, lambda: os._exit(124))
    watchdog.daemon = True
    watchdog.start()

    try:
        from scoring import Limits, ScoringError, score_predictions_csv, score_with_model

        limits = Limits(**request["limits"])
        with open(os.path.join(workdir, request["primary"]), "rb") as fh:
            primary = fh.read()

        if request["mode"] == "csv":
            result = score_predictions_csv(primary, limits)
        else:
            from safe_pickle import load_model

            with open(os.path.join(workdir, request["dataset"]), "rb") as fh:
                dataset = fh.read()
            model = load_model(primary)
            result = score_with_model(model, dataset, limits)
        payload = {"ok": True, "result": result}
    except MemoryError:
        mb = request.get("max_memory_mb") or 0
        payload = {"ok": False, "error": "Scoring ran out of memory" + (f" (limit {mb} MB)" if mb else "")
                   + "; the model or dataset is too large"}
    except Exception as exc:  # noqa: BLE001 - last-resort guard; message only, never a traceback
        try:
            from scoring import ScoringError
        except Exception:  # noqa: BLE001
            ScoringError = ()  # type: ignore[assignment]
        if ScoringError and isinstance(exc, ScoringError):
            payload = {"ok": False, "error": str(exc)}
        else:
            payload = {"ok": False, "error": f"Unexpected error while scoring: {type(exc).__name__}: {exc}"}

    _write_result(workdir, payload)
    sys.stdout.flush()
    watchdog.cancel()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]))
