"""
Runs scoring in a short-lived child process (worker.py) with a stripped environment,
a temp working directory, a wall-clock timeout and -- on Linux -- memory/CPU rlimits.

Why a child process: the web process stays free of pandas/sklearn and of any
unpickled object, so a hostile or runaway model can only hurt a process that holds
no secrets and is killed after SCORING_TIMEOUT_SECONDS. Used for CSV scoring too so
every request gets the same limits.

Cost: one interpreter start plus importing pandas (and sklearn for model files) per
request -- roughly 1-3 s warm on a laptop, more on a cold/free-tier machine. That is
the price of isolation; it is paid on the order of seconds, not per row.
"""

import json
import logging
import os
import signal
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

from config import Settings
from scoring import ScoringError

try:  # POSIX only; absent on Windows
    import resource
except ImportError:  # pragma: no cover
    resource = None

log = logging.getLogger("modelward.metrics")

# Test hook: tests point this at a slow/crashing script to exercise the timeout and crash
# paths without needing a model that is both loadable under the allow-list and slow.
WORKER_SCRIPT = Path(__file__).with_name("worker.py")

_MAX_RESULT_BYTES = 10 * 1024 * 1024
_MAX_ERROR_CHARS = 2000


class ScoringBusy(Exception):
    """Too many scorings already running; the caller should retry shortly."""


_sem_lock = threading.Lock()
_sem = None
_sem_size = 0


def _semaphore(size: int) -> threading.BoundedSemaphore:
    global _sem, _sem_size
    with _sem_lock:
        if _sem is None or _sem_size != size:
            _sem, _sem_size = threading.BoundedSemaphore(size), size
        return _sem


def _child_env(workdir: str) -> dict:
    """Only what python+numpy need. In particular: no MONGO_URI, JWT_SECRET or metrics secret."""
    env = {
        "PATH": os.environ.get("PATH", ""),
        "OPENBLAS_NUM_THREADS": "1",
        "OMP_NUM_THREADS": "1",
        "MKL_NUM_THREADS": "1",
        "LOKY_MAX_CPU_COUNT": "1",  # stops joblib probing the CPU via a subprocess at import
        "TMPDIR": workdir, "TMP": workdir, "TEMP": workdir,  # scratch lands in the throw-away dir
    }
    if os.name == "nt":
        env["SYSTEMROOT"] = os.environ.get("SYSTEMROOT", r"C:\Windows")
    return env


def _preexec(max_memory_mb: int, cpu_seconds: int):
    """Linux rlimits applied in the child before exec. None on platforms without `resource`."""
    if resource is None or not hasattr(os, "fork"):
        return None

    def apply_limits():
        if max_memory_mb > 0 and hasattr(resource, "RLIMIT_AS"):
            limit = max_memory_mb * 1024 * 1024
            resource.setrlimit(resource.RLIMIT_AS, (limit, limit))
        if hasattr(resource, "RLIMIT_CPU"):
            resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))

    return apply_limits


def _kill_tree(proc: subprocess.Popen) -> None:
    """Kill the worker and anything it spawned (the Windows venv launcher is a parent of the real python)."""
    try:
        if os.name == "nt":
            taskkill = os.path.join(os.environ.get("SYSTEMROOT", r"C:\Windows"), "System32", "taskkill.exe")
            subprocess.run([taskkill, "/F", "/T", "/PID", str(proc.pid)], capture_output=True, timeout=10, check=False)
        else:
            os.killpg(proc.pid, signal.SIGKILL)
    except Exception:  # noqa: BLE001 - fall back to killing just the direct child
        pass
    try:
        proc.kill()
    except Exception:  # noqa: BLE001
        pass
    try:
        proc.wait(timeout=10)
    except Exception:  # noqa: BLE001
        pass


def _reject_constant(name):
    raise ValueError(f"non-finite number {name} in result")


def _read_result(workdir: str):
    path = os.path.join(workdir, "result.json")
    if not os.path.exists(path) or os.path.getsize(path) > _MAX_RESULT_BYTES:
        return None
    try:
        with open(path, encoding="utf-8") as fh:
            payload = json.load(fh, parse_constant=_reject_constant)
    except (ValueError, OSError):
        return None
    return payload if isinstance(payload, dict) and isinstance(payload.get("ok"), bool) else None


def _tail(path: str, limit: int = 600) -> str:
    try:
        with open(path, "rb") as fh:
            return fh.read()[-limit:].decode("utf-8", "replace").strip()
    except OSError:
        return ""


def run_scoring(mode: str, primary: bytes, dataset, settings: Settings, worker_script=None) -> dict:
    """Score in a child process. mode is 'csv' or 'model'; returns the metrics dict.

    Raises ScoringError (HTTP 400) for validation failures, timeouts and crashes, and
    ScoringBusy (HTTP 503) when SCORING_MAX_CONCURRENT scorings are already running.
    """
    sem = _semaphore(settings.max_concurrent_scorings)
    if not sem.acquire(timeout=settings.scoring_timeout_seconds):
        raise ScoringBusy("Scoring service is busy; retry shortly")
    try:
        return _run(mode, primary, dataset, settings, worker_script or WORKER_SCRIPT)
    finally:
        sem.release()


def _run(mode, primary, dataset, settings, worker_script) -> dict:
    timeout = settings.scoring_timeout_seconds
    with tempfile.TemporaryDirectory(prefix="mw-score-") as workdir:
        with open(os.path.join(workdir, "primary.bin"), "wb") as fh:
            fh.write(primary)
        if dataset is not None:
            with open(os.path.join(workdir, "dataset.csv"), "wb") as fh:
                fh.write(dataset)
        with open(os.path.join(workdir, "request.json"), "w", encoding="utf-8") as fh:
            json.dump({
                "mode": mode,
                "primary": "primary.bin",
                "dataset": "dataset.csv" if dataset is not None else None,
                "limits": {"min_rows": settings.min_rows, "max_rows": settings.max_rows,
                           "min_group_rows": settings.min_group_rows},
                "timeout_seconds": timeout,
                "max_memory_mb": settings.scoring_max_memory_mb,
            }, fh)

        popen_kwargs = {}
        if os.name == "nt":
            popen_kwargs["creationflags"] = subprocess.CREATE_NEW_PROCESS_GROUP | getattr(subprocess, "CREATE_NO_WINDOW", 0)
        else:
            popen_kwargs["start_new_session"] = True  # own process group so the whole tree can be killed
            popen_kwargs["preexec_fn"] = _preexec(settings.scoring_max_memory_mb, timeout + 5)

        out_path, err_path = os.path.join(workdir, "stdout.txt"), os.path.join(workdir, "stderr.txt")
        # stdout/stderr go to files (not pipes): a hostile pickle can print without limit.
        with open(out_path, "wb") as out, open(err_path, "wb") as err:
            proc = subprocess.Popen(
                [sys.executable, "-I", str(worker_script), workdir],
                cwd=workdir, env=_child_env(workdir),
                stdin=subprocess.DEVNULL, stdout=out, stderr=err, **popen_kwargs,
            )
            try:
                proc.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                _kill_tree(proc)
                raise ScoringError(f"Scoring timed out after {timeout} s") from None

        payload = _read_result(workdir)
        if payload is None:
            log.warning("scoring worker exited %s without a valid result; stderr tail: %s",
                        proc.returncode, _tail(err_path))
            raise ScoringError(
                f"Scoring process crashed (exit code {proc.returncode}) before producing a result; "
                f"the model or dataset may be too large or invalid"
            )
        if not payload["ok"]:
            raise ScoringError(str(payload.get("error", "Scoring failed"))[:_MAX_ERROR_CHARS])
        result = payload.get("result")
        if not isinstance(result, dict):
            raise ScoringError("Scoring process returned an invalid result")
        return result
