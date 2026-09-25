"""
ModelWard metrics microservice.

Single endpoint: POST /compute-metrics
Stateless calculator -- no database, no persistence. Receives a file (+ type),
returns { accuracy, fairness_gap, latency_ms }, forgets everything immediately.

CSV path:     scores a labelled CSV directly (predicted, actual, protected_attribute columns).
Pickle/joblib path: loads a fitted scikit-learn-compatible model and runs .predict()
                     for real against an attached companion dataset CSV, timing it for
                     real latency.

Security note: loading arbitrary pickles executes code. This is fine for a local
MVP demo with your own trusted test files -- do not expose this endpoint publicly as-is.
"""

import io
import pickle
import time

import joblib
import pandas as pd
from fastapi import FastAPI, UploadFile, Form, File
from fastapi.responses import JSONResponse

app = FastAPI(title="ModelWard Metrics Microservice")

REQUIRED_CSV_COLUMNS = {"predicted", "actual", "protected_attribute"}
REQUIRED_DATASET_COLUMNS = {"actual", "protected_attribute"}


@app.get("/health")
async def health():
    return {"ok": True, "service": "modelward-metrics"}


def fairness_gap_from_frame(df: pd.DataFrame, predicted_col: str, actual_col: str, group_col: str) -> float:
    """Per-group accuracy, gap = max group accuracy - min group accuracy.
    Generalizes cleanly to the binary case the spec describes; degrades to 0.0
    if only one group is present in the data."""
    correct = (df[predicted_col] == df[actual_col])
    group_accuracy = correct.groupby(df[group_col]).mean()
    if len(group_accuracy) < 2:
        return 0.0
    return float(group_accuracy.max() - group_accuracy.min())


def score_csv(raw_bytes: bytes) -> dict:
    try:
        df = pd.read_csv(io.BytesIO(raw_bytes))
    except Exception as exc:
        raise ValueError(f"Could not parse CSV: {exc}") from exc

    missing = REQUIRED_CSV_COLUMNS - set(df.columns)
    if missing:
        raise ValueError(f"CSV is missing required column(s): {', '.join(sorted(missing))}")

    if df.empty:
        raise ValueError("CSV has no rows")

    accuracy = float((df["predicted"] == df["actual"]).mean())
    fairness_gap = fairness_gap_from_frame(df, "predicted", "actual", "protected_attribute")

    # Latency is intentionally not computed for the CSV path -- there is no real
    # inference happening, so the caller (Express) uses the uploader's
    # self-reported latency instead.
    return {"accuracy": accuracy, "fairness_gap": fairness_gap, "latency_ms": None}


def load_model(raw_bytes: bytes):
    buffer = io.BytesIO(raw_bytes)
    try:
        return joblib.load(buffer)
    except Exception:
        buffer.seek(0)
        try:
            return pickle.load(buffer)
        except Exception as exc:
            raise ValueError(f"Could not load model file (tried joblib and pickle): {exc}") from exc


def score_model(model_bytes: bytes, dataset_bytes: bytes) -> dict:
    model = load_model(model_bytes)

    try:
        dataset = pd.read_csv(io.BytesIO(dataset_bytes))
    except Exception as exc:
        raise ValueError(f"Could not parse dataset CSV: {exc}") from exc

    missing = REQUIRED_DATASET_COLUMNS - set(dataset.columns)
    if missing:
        raise ValueError(f"Dataset CSV is missing required column(s): {', '.join(sorted(missing))}")

    if dataset.empty:
        raise ValueError("Dataset CSV has no rows")

    feature_columns = [c for c in dataset.columns if c not in REQUIRED_DATASET_COLUMNS]
    if not feature_columns:
        raise ValueError("Dataset CSV has no feature columns (only actual/protected_attribute)")

    X = dataset[feature_columns]
    y_true = dataset["actual"]

    if not hasattr(model, "predict"):
        raise ValueError("Uploaded object has no .predict() method -- is this a fitted scikit-learn-compatible model?")

    try:
        start = time.perf_counter()
        predicted = model.predict(X)
        elapsed_ms = (time.perf_counter() - start) * 1000
    except Exception as exc:
        raise ValueError(
            f"model.predict() failed -- the dataset's feature columns likely don't match "
            f"what the model expects: {exc}"
        ) from exc

    result_df = pd.DataFrame({
        "predicted": predicted,
        "actual": y_true.values,
        "protected_attribute": dataset["protected_attribute"].values,
    })

    accuracy = float((result_df["predicted"] == result_df["actual"]).mean())
    fairness_gap = fairness_gap_from_frame(result_df, "predicted", "actual", "protected_attribute")

    return {"accuracy": accuracy, "fairness_gap": fairness_gap, "latency_ms": float(elapsed_ms)}


@app.post("/compute-metrics")
async def compute_metrics(
    file_type: str = Form(...),
    primary_file: UploadFile = File(...),
    dataset_file: UploadFile | None = File(None),
):
    if file_type not in ("csv", "pickle", "joblib"):
        return JSONResponse(status_code=400, content={"error": "file_type must be 'csv', 'pickle' or 'joblib'"})

    try:
        primary_bytes = await primary_file.read()

        if file_type == "csv":
            result = score_csv(primary_bytes)
        else:
            if dataset_file is None:
                return JSONResponse(
                    status_code=400,
                    content={"error": "dataset_file is required when file_type is 'pickle' or 'joblib'"},
                )
            dataset_bytes = await dataset_file.read()
            result = score_model(primary_bytes, dataset_bytes)

        return result

    except ValueError as exc:
        # Expected, explained failures -- bad columns, shape mismatch, corrupt file, etc.
        return JSONResponse(status_code=400, content={"error": str(exc)})
    except Exception as exc:  # noqa: BLE001 -- last-resort guard, must never 500 mid-demo
        return JSONResponse(status_code=400, content={"error": f"Unexpected error while scoring: {exc}"})
