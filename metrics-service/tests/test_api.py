"""
API tests through FastAPI's TestClient. Scoring goes through the real subprocess path, so
each scoring request costs one interpreter start (about 1-3 s).
"""

import io
import json
import os
import pickle
import subprocess
import sys
import textwrap
import time

import joblib
import pytest

import main
import runner
from config import get_settings
from conftest import SERVICE_DIR, post_metrics
from scoring import ScoringError


# ---- health & config -----------------------------------------------------------------


def test_health_is_open_and_reports_model_file_flag(client, monkeypatch):
    body = client.get("/health").json()
    assert body == {"ok": True, "service": "modelward-metrics", "allow_model_files": True}

    monkeypatch.setenv("ALLOW_MODEL_FILES", "false")
    monkeypatch.setenv("METRICS_SHARED_SECRET", "s3cret")
    r = client.get("/health")  # no secret header needed
    assert r.status_code == 200 and r.json()["allow_model_files"] is False


def test_model_files_default_off_in_production(monkeypatch):
    monkeypatch.setenv("APP_ENV", "production")
    assert get_settings().allow_model_files is False
    monkeypatch.setenv("ALLOW_MODEL_FILES", "true")
    assert get_settings().allow_model_files is True


def test_production_without_secret_refuses_to_start():
    env = {"PATH": os.environ["PATH"], "APP_ENV": "production"}
    if os.name == "nt":
        env["SYSTEMROOT"] = os.environ.get("SYSTEMROOT", r"C:\Windows")
    code = f"import sys; sys.path.insert(0, {str(SERVICE_DIR)!r}); import main"
    proc = subprocess.run([sys.executable, "-I", "-c", code], env=env, capture_output=True, text=True, timeout=60)
    assert proc.returncode != 0
    assert "METRICS_SHARED_SECRET must be set when APP_ENV=production" in proc.stderr

    env["METRICS_SHARED_SECRET"] = "s3cret"
    ok = subprocess.run([sys.executable, "-I", "-c", code], env=env, capture_output=True, text=True, timeout=60)
    assert ok.returncode == 0, ok.stderr


# ---- sample scenarios (numbers must not change) ----------------------------------------


def test_good_predictions_sample(client, sample):
    r = post_metrics(client, "csv", sample("good_predictions.csv"))
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["accuracy"] == 0.95
    assert body["fairness_gap"] == pytest.approx(0.009073495, abs=1e-8)
    assert body["latency_ms"] is None and body["rows"] == 200
    assert [g["group"] for g in body["groups"]] == ["0", "1"]
    assert sum(g["count"] for g in body["groups"]) == 200
    assert 0 < body["precision"] <= 1 and body["auc"] is None  # no probability column
    assert body["warnings"] == []
    json.dumps(body, allow_nan=False)


def test_bad_predictions_sample(client, sample):
    r = post_metrics(client, "csv", sample("bad_predictions.csv"))
    assert r.status_code == 200
    assert r.json()["accuracy"] == 0.455


@pytest.mark.parametrize("file_type", ["joblib", "pickle"])
def test_joblib_sample_scores_097_with_latency(client, sample, file_type):
    # the shipped sample is a joblib file; the pickle route must accept it too (same loader)
    r = post_metrics(client, file_type, sample("dummy_model.joblib"), sample("model_dataset.csv"), primary_name="m.joblib")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["accuracy"] == 0.97
    assert body["latency_ms"] is not None and body["latency_ms"] > 0
    assert body["rows"] == 100 and body["auc"] is not None and body["auc"] > 0.9


def test_mismatched_dataset_message(client, sample):
    r = post_metrics(client, "joblib", sample("dummy_model.joblib"), sample("mismatched_dataset.csv"))
    assert r.status_code == 400
    assert "model.predict() failed -- the dataset's feature columns likely don't match" in r.json()["error"]


def test_csv_with_probability_column_gets_auc(client):
    rows = ["predicted,actual,protected_attribute,probability"]
    for i in range(60):
        actual = i % 2
        rows.append(f"{actual},{actual},{i % 2 if i % 3 else 1 - i % 2},{0.9 if actual else 0.1}")
    r = post_metrics(client, "csv", "\n".join(rows).encode())
    assert r.status_code == 200, r.text
    assert r.json()["auc"] == 1.0


def test_wrong_columns_and_garbage_are_400_not_500(client, sample):
    r = post_metrics(client, "csv", b"a,b\n1,2\n")
    assert r.status_code == 400 and "missing required column" in r.json()["error"]
    r = post_metrics(client, "joblib", sample("good_predictions.csv"), sample("model_dataset.csv"))
    assert r.status_code == 400 and "Could not load model file" in r.json()["error"]
    r = post_metrics(client, "joblib", sample("dummy_model.joblib"))  # no dataset
    assert r.status_code == 400 and "dataset_file is required" in r.json()["error"]
    r = post_metrics(client, "exe", b"x")
    assert r.status_code == 400 and "file_type must be" in r.json()["error"]
    r = client.post("/compute-metrics", data={"file_type": "csv"})  # no file at all
    assert r.status_code == 400 and "primary_file" in r.json()["error"]


def test_label_type_mismatch_is_clear_error(client):
    body = "predicted,actual,protected_attribute\n" + "\n".join(
        f"{'yes' if i % 2 else 'no'},{i % 2},{i % 2}" for i in range(60))
    r = post_metrics(client, "csv", body.encode())
    assert r.status_code == 400 and "different label types" in r.json()["error"]


def test_row_cap_and_min_rows_enforced_via_env(client, sample, monkeypatch):
    monkeypatch.setenv("METRICS_MAX_ROWS", "50")
    r = post_metrics(client, "csv", sample("good_predictions.csv"))
    assert r.status_code == 400 and "more than the maximum of 50 rows" in r.json()["error"]
    monkeypatch.delenv("METRICS_MAX_ROWS")
    monkeypatch.setenv("METRICS_MIN_ROWS", "500")
    r = post_metrics(client, "csv", sample("good_predictions.csv"))
    assert r.status_code == 400 and "at least 500" in r.json()["error"]


# ---- shared secret ---------------------------------------------------------------------


def test_secret_enforced_when_configured(client, sample, monkeypatch):
    monkeypatch.setenv("METRICS_SHARED_SECRET", "s3cret")
    csv = sample("good_predictions.csv")
    for headers in ({}, {"X-Metrics-Secret": "wrong"}, {"X-Metrics-Secret": ""}):
        r = post_metrics(client, "csv", csv, headers=headers)
        assert r.status_code == 401, headers
        assert r.json() == {"error": "Invalid or missing metrics secret"}
    ok = post_metrics(client, "csv", csv, headers={"X-Metrics-Secret": "s3cret"})
    assert ok.status_code == 200 and ok.json()["accuracy"] == 0.95


def test_secret_not_required_when_unset(client, sample):
    assert post_metrics(client, "csv", sample("good_predictions.csv")).status_code == 200


def test_secret_checked_before_body_is_read(client, monkeypatch):
    monkeypatch.setenv("METRICS_SHARED_SECRET", "s3cret")
    # not even valid multipart: auth must fail first
    r = client.post("/compute-metrics", content=b"garbage", headers={"content-type": "multipart/form-data; boundary=x"})
    assert r.status_code == 401


# ---- model files disabled --------------------------------------------------------------


@pytest.mark.parametrize("file_type", ["pickle", "joblib"])
def test_model_files_disabled(client, sample, monkeypatch, file_type):
    monkeypatch.setenv("ALLOW_MODEL_FILES", "false")
    r = post_metrics(client, file_type, sample("dummy_model.joblib"), sample("model_dataset.csv"))
    assert r.status_code == 400
    assert r.json() == {"error": "Model file uploads are disabled on this deployment; upload a predictions CSV instead"}
    # CSV keeps working
    assert post_metrics(client, "csv", sample("good_predictions.csv")).status_code == 200


# ---- upload size -----------------------------------------------------------------------


def test_oversize_file_is_413(client, monkeypatch):
    monkeypatch.setenv("MAX_UPLOAD_BYTES", "1000")
    r = post_metrics(client, "csv", b"x" * 1500)  # passes the early gate, caught by the chunked reader
    assert r.status_code == 413
    assert "maximum size of 1000 bytes" in r.json()["error"]


def test_very_large_body_rejected_early_by_content_length(client, monkeypatch):
    monkeypatch.setenv("MAX_UPLOAD_BYTES", "1000")
    r = post_metrics(client, "csv", b"x" * (2000 + main.MULTIPART_OVERHEAD_BYTES + 10))
    assert r.status_code == 413


def test_chunked_upload_without_content_length_is_cut_off(client, monkeypatch):
    monkeypatch.setenv("MAX_UPLOAD_BYTES", "1000")
    limit = 2 * 1000 + main.MULTIPART_OVERHEAD_BYTES
    sent = []

    def body():
        for _ in range(20):
            sent.append(1)
            yield b"x" * (limit // 4)

    r = client.post("/compute-metrics", content=body(), headers={"content-type": "multipart/form-data; boundary=x"})
    assert r.status_code == 413


# ---- security through the API -----------------------------------------------------------


class Evil:
    def __init__(self, func, args):
        self.func, self.args = func, args

    def __reduce__(self):
        return (self.func, self.args)


@pytest.mark.parametrize("kind", ["pickle", "joblib"])
def test_malicious_model_upload_is_rejected_and_nothing_runs(client, sample, tmp_path, kind):
    marker = tmp_path / "pwned.txt"
    payload = Evil(os.system, (f'echo pwned> "{marker}"',))
    if kind == "pickle":
        raw = pickle.dumps(payload)
    else:
        buf = io.BytesIO()
        joblib.dump(payload, buf)
        raw = buf.getvalue()
    r = post_metrics(client, kind, raw, sample("model_dataset.csv"))
    assert r.status_code == 400
    assert "disallowed object" in r.json()["error"]
    assert not marker.exists()


def test_eval_payload_via_api(client, sample, tmp_path):
    marker = tmp_path / "pwned.txt"
    raw = pickle.dumps(Evil(eval, (f"open({str(marker)!r}, 'w').write('x')",)))
    r = post_metrics(client, "pickle", raw, sample("model_dataset.csv"))
    assert r.status_code == 400 and "disallowed object (builtins.eval)" in r.json()["error"]
    assert not marker.exists()


# ---- runner: isolation, timeout, crash (via the explicit WORKER_SCRIPT test hook) ---------


def _pid_alive(pid: int) -> bool:
    if os.name == "nt":
        out = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"], capture_output=True, text=True).stdout
        return str(pid) in out
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _worker(tmp_path, source: str):
    path = tmp_path / "fake_worker.py"
    path.write_text(textwrap.dedent(source), encoding="utf-8")
    return path


def test_timeout_returns_400_and_kills_worker(client, sample, monkeypatch, tmp_path):
    pidfile = tmp_path / "pid.txt"
    slow = _worker(tmp_path, f"""
        import os, time
        open({str(pidfile)!r}, "w").write(str(os.getpid()))
        time.sleep(60)
    """)
    monkeypatch.setattr(runner, "WORKER_SCRIPT", slow)
    monkeypatch.setenv("SCORING_TIMEOUT_SECONDS", "2")
    start = time.perf_counter()
    r = post_metrics(client, "csv", sample("good_predictions.csv"))
    assert time.perf_counter() - start < 20
    assert r.status_code == 400
    assert r.json() == {"error": "Scoring timed out after 2 s"}
    # the whole process tree must be gone (on Windows the venv launcher is a parent of the real python)
    time.sleep(0.5)
    assert not _pid_alive(int(pidfile.read_text()))


def test_worker_crash_is_a_clear_400(client, sample, monkeypatch, tmp_path):
    monkeypatch.setattr(runner, "WORKER_SCRIPT", _worker(tmp_path, "import os\nos._exit(3)\n"))
    r = post_metrics(client, "csv", sample("good_predictions.csv"))
    assert r.status_code == 400
    assert "Scoring process crashed (exit code 3)" in r.json()["error"]


def test_worker_garbage_result_is_a_crash_not_a_500(client, sample, monkeypatch, tmp_path):
    monkeypatch.setattr(runner, "WORKER_SCRIPT", _worker(tmp_path, """
        import os, sys
        open(os.path.join(sys.argv[1], "result.json"), "w").write('{"ok": true, "result": {"accuracy": NaN}}')
    """))
    r = post_metrics(client, "csv", sample("good_predictions.csv"))
    assert r.status_code == 400 and "crashed" in r.json()["error"]


def test_child_environment_is_stripped(client, sample, monkeypatch, tmp_path):
    monkeypatch.setenv("MONGO_URI", "mongodb://secret-host")
    monkeypatch.setenv("JWT_SECRET", "jwt-secret")
    monkeypatch.setenv("METRICS_SHARED_SECRET", "s3cret")
    monkeypatch.setattr(runner, "WORKER_SCRIPT", _worker(tmp_path, """
        import json, os, sys
        result = {"ok": True, "result": {"env": sorted(os.environ), "cwd": os.getcwd(),
                                         "sys_path_has_cwd": os.getcwd() in sys.path}}
        json.dump(result, open(os.path.join(sys.argv[1], "result.json"), "w"))
    """))
    r = post_metrics(client, "csv", sample("good_predictions.csv"), headers={"X-Metrics-Secret": "s3cret"})
    assert r.status_code == 200, r.text
    env = set(r.json()["env"])
    assert not env & {"MONGO_URI", "JWT_SECRET", "METRICS_SHARED_SECRET", "APP_ENV"}
    assert {"OPENBLAS_NUM_THREADS", "OMP_NUM_THREADS", "MKL_NUM_THREADS"} <= env
    assert os.path.basename(r.json()["cwd"]).startswith("mw-score-")  # temp dir, not the service dir
    assert r.json()["sys_path_has_cwd"] is False  # python -I


def test_busy_service_returns_503(client, sample, monkeypatch):
    monkeypatch.setenv("SCORING_MAX_CONCURRENT", "1")
    monkeypatch.setenv("SCORING_TIMEOUT_SECONDS", "1")
    sem = runner._semaphore(1)
    assert sem.acquire(timeout=1)
    try:
        r = post_metrics(client, "csv", sample("good_predictions.csv"))
    finally:
        sem.release()
    assert r.status_code == 503 and "busy" in r.json()["error"]


def test_run_scoring_timeout_unit(monkeypatch, tmp_path):
    slow = _worker(tmp_path, "import time\ntime.sleep(60)\n")
    monkeypatch.setenv("SCORING_TIMEOUT_SECONDS", "1")
    with pytest.raises(ScoringError, match="timed out after 1 s"):
        runner.run_scoring("csv", b"a,b\n", None, get_settings(), worker_script=slow)
