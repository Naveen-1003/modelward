"""Shared fixtures. Run with:  cd metrics-service && venv\\Scripts\\python.exe -m pytest -q"""

import sys
from pathlib import Path

import pytest

SERVICE_DIR = Path(__file__).resolve().parents[1]
SAMPLE_DIR = SERVICE_DIR.parent / "sample-data"
sys.path.insert(0, str(SERVICE_DIR))

CONFIG_ENV_VARS = [
    "APP_ENV", "METRICS_SHARED_SECRET", "ALLOW_MODEL_FILES", "MAX_UPLOAD_BYTES", "METRICS_MIN_ROWS",
    "METRICS_MIN_GROUP_ROWS", "METRICS_MAX_ROWS", "SCORING_TIMEOUT_SECONDS", "SCORING_MAX_MEMORY_MB",
    "SCORING_MAX_CONCURRENT",
]


@pytest.fixture(autouse=True)
def clean_env(monkeypatch):
    """A developer's shell must not change test outcomes."""
    for name in CONFIG_ENV_VARS:
        monkeypatch.delenv(name, raising=False)


@pytest.fixture
def client():
    from fastapi.testclient import TestClient
    import main

    return TestClient(main.app)


@pytest.fixture
def sample():
    def read(name: str) -> bytes:
        return (SAMPLE_DIR / name).read_bytes()

    return read


def post_metrics(client, file_type="csv", primary=None, dataset=None, headers=None, primary_name="primary.csv"):
    files = {"primary_file": (primary_name, primary, "application/octet-stream")}
    if dataset is not None:
        files["dataset_file"] = ("dataset.csv", dataset, "text/csv")
    return client.post("/compute-metrics", data={"file_type": file_type}, files=files, headers=headers or {})
