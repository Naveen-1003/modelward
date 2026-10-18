"""
Pure scoring logic for the ModelWard metrics service.

Everything here is deterministic and free of I/O beyond parsing bytes, so it is
unit-testable without a subprocess. In production this module only runs inside the
short-lived worker process (see worker.py / runner.py); the web process never
imports pandas or sklearn.

Every user-fixable problem raises ScoringError, which the API turns into a 400
with the message verbatim -- so messages are written for the person uploading.
"""

import io
import math
import time
from dataclasses import dataclass

import numpy as np
import pandas as pd

REQUIRED_CSV_COLUMNS = ("predicted", "actual", "protected_attribute")
REQUIRED_DATASET_COLUMNS = ("actual", "protected_attribute")
PROBABILITY_COLUMN = "probability"

# Groups below this are scored but flagged: a per-group rate over a handful of rows is noise.
SMALL_GROUP_WARN_ROWS = 30
_MAX_LISTED = 5  # cap how many group/class names go into one message


class ScoringError(ValueError):
    """A user-fixable validation or scoring failure (maps to HTTP 400)."""


@dataclass(frozen=True)
class Limits:
    min_rows: int = 30
    max_rows: int = 200000
    min_group_rows: int = 10


# --------------------------------------------------------------------------- helpers


def _f(value):
    """JSON-safe float: None/NaN/inf -> None."""
    if value is None:
        return None
    try:
        value = float(value)
    except (TypeError, ValueError):
        return None
    return value if math.isfinite(value) else None


def _cap(names, limit=_MAX_LISTED):
    names = [str(n) for n in names]
    shown = ", ".join(f"'{n}'" for n in names[:limit])
    return shown + (f" and {len(names) - limit} more" if len(names) > limit else "")


def _capitalise(noun: str) -> str:
    return noun[:1].upper() + noun[1:]


def read_csv(raw: bytes, noun: str, limits: Limits) -> pd.DataFrame:
    """Parse CSV bytes, bounding memory by never reading more than max_rows+1 rows."""
    try:
        df = pd.read_csv(io.BytesIO(raw), nrows=limits.max_rows + 1)
    except pd.errors.EmptyDataError as exc:
        raise ScoringError(f"{_capitalise(noun)} has no rows") from exc
    except Exception as exc:  # noqa: BLE001 - pandas raises many types for malformed input
        raise ScoringError(f"Could not parse {noun}: {exc}") from exc
    df.columns = [str(c).strip() for c in df.columns]
    if len(df) > limits.max_rows:
        raise ScoringError(
            f"{_capitalise(noun)} has more than the maximum of {limits.max_rows} rows; "
            f"split it or sample it down and re-upload"
        )
    return df


def _check_columns(df: pd.DataFrame, required, noun: str) -> None:
    missing = [c for c in required if c not in df.columns]
    if missing:
        raise ScoringError(f"{_capitalise(noun)} is missing required column(s): {', '.join(sorted(missing))}")


def _check_size(n: int, noun: str, limits: Limits) -> None:
    if n == 0:
        raise ScoringError(f"{_capitalise(noun)} has no rows")
    if n < limits.min_rows:
        raise ScoringError(
            f"{_capitalise(noun)} has only {n} row(s); at least {limits.min_rows} are required for meaningful metrics"
        )
    if n > limits.max_rows:
        raise ScoringError(f"{_capitalise(noun)} has {n} rows; the maximum is {limits.max_rows}")


def _missing_mask(series: pd.Series) -> pd.Series:
    mask = series.isna()
    if series.dtype == object or pd.api.types.is_string_dtype(series.dtype):
        # A blank cell is a missing value even when the column is text.
        blank = series.where(~mask, "").astype(str).str.strip().eq("")
        mask = mask | blank
    return mask


def _check_missing(df: pd.DataFrame, columns) -> None:
    masks = {c: _missing_mask(df[c]) for c in columns}
    rows_with_missing = int(pd.concat(masks.values(), axis=1).any(axis=1).sum())
    if rows_with_missing:
        detail = ", ".join(f"{c} ({int(m.sum())})" for c, m in masks.items() if m.any())
        raise ScoringError(
            f"{rows_with_missing} row(s) have missing values in required column(s): {detail}. "
            f"Fill or remove them and re-upload"
        )


def _group_labels(series: pd.Series) -> pd.Series:
    """Protected attribute as clean strings; 1, 1.0 and "1" are the same group."""
    if pd.api.types.is_bool_dtype(series.dtype):
        return series.map({True: "True", False: "False"})
    if pd.api.types.is_numeric_dtype(series.dtype):
        values = series.astype(float)
        if np.isfinite(values).all() and (values % 1 == 0).all():
            return values.astype("int64").astype(str)
        return series.astype(str)
    return series.astype(str).str.strip()


def _sorted_groups(labels: pd.Series) -> list:
    names = list(labels.unique())
    try:
        return sorted(names, key=lambda g: float(g))  # numeric groups sort numerically (2 before 10)
    except ValueError:
        return sorted(names)


def _check_groups(labels: pd.Series, limits: Limits) -> None:
    counts = labels.value_counts()
    if len(counts) < 2:
        only = counts.index[0] if len(counts) else "?"
        raise ScoringError(
            f"protected_attribute has only one group ('{only}'); at least 2 groups are required to compute fairness metrics"
        )
    small = [g for g in _sorted_groups(labels) if counts[g] < limits.min_group_rows]
    if small:
        details = ", ".join(f"'{g}' ({int(counts[g])} row(s))" for g in small[:_MAX_LISTED])
        raise ScoringError(
            f"Every protected group needs at least {limits.min_group_rows} rows; too small: {details}"
        )


def _as_numeric(series: pd.Series):
    """Series as float64 if every value is numeric-coercible, else None. Bool counts as 0/1."""
    if pd.api.types.is_bool_dtype(series.dtype):
        return series.astype("int64").astype(float)
    if pd.api.types.is_numeric_dtype(series.dtype):
        return series.astype(float)
    coerced = pd.to_numeric(series.astype(str).str.strip(), errors="coerce")
    return None if coerced.isna().any() else coerced.astype(float)


def _normalise_labels(predicted: pd.Series, actual: pd.Series):
    """Put predicted and actual on one scale so equality means what the uploader thinks it means.

    numeric on both sides (1, 1.0, "1", True all equal 1)  -> compare as floats
    text on both sides                                     -> compare lower-cased, stripped
    one of each                                            -> error (otherwise accuracy is silently 0%)
    """
    p_num, a_num = _as_numeric(predicted), _as_numeric(actual)
    if p_num is not None and a_num is not None:
        return p_num.to_numpy(), a_num.to_numpy(), "numeric"
    if p_num is None and a_num is None:
        p = predicted.astype(str).str.strip().str.lower().to_numpy()
        a = actual.astype(str).str.strip().str.lower().to_numpy()
        return p, a, "text"
    p_kind = "numeric" if p_num is not None else "text"
    a_kind = "numeric" if a_num is not None else "text"
    raise ScoringError(
        f"predicted and actual use different label types (predicted is {p_kind}, actual is {a_kind}); "
        f"use the same label encoding in both columns, e.g. 0/1 for both"
    )


def _clean_probability(values, n: int, warnings: list):
    """Validated probability array, or None (with a warning) if it can't be trusted."""
    if values is None:
        return None
    series = pd.Series(values)
    numeric = pd.to_numeric(series, errors="coerce")
    if len(numeric) != n:
        warnings.append("probability values ignored: length does not match the number of rows")
        return None
    if numeric.isna().any():
        warnings.append(
            f"probability column ignored: {int(numeric.isna().sum())} value(s) are missing or non-numeric; AUC not computed"
        )
        return None
    arr = numeric.to_numpy(dtype=float)
    if not np.isfinite(arr).all() or arr.min() < 0.0 or arr.max() > 1.0:
        warnings.append("probability column ignored: values must be between 0 and 1; AUC not computed")
        return None
    return arr


def _auc(y_true: np.ndarray, score: np.ndarray):
    """ROC AUC via the rank-sum (Mann-Whitney U) identity, ties get average ranks."""
    pos = y_true == 1
    n_pos, n_neg = int(pos.sum()), int((~pos).sum())
    if n_pos == 0 or n_neg == 0:
        return None
    ranks = pd.Series(score).rank(method="average").to_numpy()
    return (ranks[pos].sum() - n_pos * (n_pos + 1) / 2.0) / (n_pos * n_neg)


def _range(values):
    values = [v for v in values if v is not None]
    return (max(values) - min(values)) if values else None


# --------------------------------------------------------------------------- core


def precheck_frame(df: pd.DataFrame, limits: Limits, columns, noun: str) -> None:
    """Size, missing-value and group checks that don't need predictions (run before predict())."""
    _check_size(len(df), noun, limits)
    _check_missing(df, columns)
    _check_groups(_group_labels(df["protected_attribute"]), limits)


def score_frame(df: pd.DataFrame, limits: Limits, *, noun: str = "CSV", latency_ms=None,
                probability=None, warnings=None) -> dict:
    """Score a frame with columns predicted, actual, protected_attribute [, probability].

    `probability` (array-like) overrides a `probability` column; the model-file path uses
    it for predict_proba output.
    """
    warnings = list(warnings or [])
    n = len(df)
    _check_size(n, noun, limits)
    _check_missing(df, ["predicted", "actual", "protected_attribute"])
    labels = _group_labels(df["protected_attribute"])
    _check_groups(labels, limits)
    p, a, kind = _normalise_labels(df["predicted"].reset_index(drop=True), df["actual"].reset_index(drop=True))
    g = labels.reset_index(drop=True).to_numpy()
    group_names = _sorted_groups(labels)

    prob_source = probability if probability is not None else (
        df[PROBABILITY_COLUMN].reset_index(drop=True) if PROBABILITY_COLUMN in df.columns else None)

    # accuracy and fairness_gap semantics are load-bearing: the risk tier is computed from them.
    correct = p == a
    accuracy = float(correct.mean())
    group_acc = {name: float(correct[g == name].mean()) for name in group_names}
    fairness_gap = float(max(group_acc.values()) - min(group_acc.values()))

    classes = sorted(set(np.unique(p).tolist()) | set(np.unique(a).tolist()), key=str)
    binary = kind == "numeric" and set(classes) <= {0.0, 1.0}

    result = {
        "accuracy": _f(accuracy),
        "fairness_gap": _f(fairness_gap),
        "latency_ms": _f(latency_ms),
        "rows": int(n),
        "demographic_parity_diff": None,
        "equal_opportunity_diff": None,
        "disparate_impact_ratio": None,
        "precision": None,
        "recall": None,
        "f1": None,
        "auc": None,
    }

    group_rows = []
    if binary:
        pred_pos = p == 1.0
        act_pos = a == 1.0
        rates, tprs = [], []
        undefined_tpr = []
        for name in group_names:
            m = g == name
            rate = float(pred_pos[m].mean())
            n_actual_pos = int(act_pos[m].sum())
            tpr = float((pred_pos & act_pos)[m].sum() / n_actual_pos) if n_actual_pos else None
            if tpr is None:
                undefined_tpr.append(name)
            rates.append(rate)
            tprs.append(tpr)
            group_rows.append({"group": str(name), "count": int(m.sum()), "accuracy": _f(group_acc[name]),
                               "positive_rate": _f(rate), "tpr": _f(tpr)})

        result["demographic_parity_diff"] = _f(max(rates) - min(rates))
        defined = [t for t in tprs if t is not None]
        result["equal_opportunity_diff"] = _f(_range(defined)) if len(defined) >= 2 else None
        result["disparate_impact_ratio"] = _f(min(rates) / max(rates)) if max(rates) > 0 else None
        if undefined_tpr:
            warnings.append(
                f"Equal opportunity ignores group(s) {_cap(undefined_tpr)} because they have no positive actual rows"
            )

        tp = int((pred_pos & act_pos).sum())
        fp = int((pred_pos & ~act_pos).sum())
        fn = int((~pred_pos & act_pos).sum())
        precision = tp / (tp + fp) if (tp + fp) else 0.0  # zero_division=0
        recall = tp / (tp + fn) if (tp + fn) else 0.0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
        result.update(precision=_f(precision), recall=_f(recall), f1=_f(f1))

        prob = _clean_probability(prob_source, n, warnings)
        if prob is not None:
            auc = _auc(a, prob)
            if auc is None:
                warnings.append("AUC not computed: actual contains only one class")
            result["auc"] = _f(auc)
    else:
        for name in group_names:
            m = g == name
            group_rows.append({"group": str(name), "count": int(m.sum()), "accuracy": _f(group_acc[name]),
                               "positive_rate": None, "tpr": None})
        shown = [("%g" % c) if isinstance(c, float) else str(c) for c in classes]
        listed = ", ".join(shown[:10]) + (", ..." if len(shown) > 10 else "")
        reason = "labels are not binary 0/1" if kind == "numeric" else "labels are text, so no positive class is defined"
        warnings.append(
            f"Positive-class metrics skipped because {reason} (found: {listed}); only accuracy and "
            f"the per-group accuracy gap were computed. Use 0/1 labels to get precision, recall, F1, AUC and fairness ratios"
        )
        if prob_source is not None:
            warnings.append("probability values ignored because labels are not binary 0/1")

    small = [r["group"] for r in group_rows if r["count"] < SMALL_GROUP_WARN_ROWS]
    if small:
        warnings.append(
            f"Group(s) {_cap(small)} have fewer than {SMALL_GROUP_WARN_ROWS} rows; per-group metrics are statistically unreliable"
        )

    result["groups"] = group_rows
    result["warnings"] = warnings
    return result


def score_predictions_csv(raw: bytes, limits: Limits) -> dict:
    """CSV path: predicted, actual, protected_attribute [, probability]. No latency (nothing is run)."""
    df = read_csv(raw, "CSV", limits)
    _check_columns(df, REQUIRED_CSV_COLUMNS, "CSV")
    return score_frame(df, limits, noun="CSV")


# --------------------------------------------------------------------------- model path


def _model_probability(model, X, warnings: list):
    """predict_proba(X)[:, 1] for a binary model whose positive class is 1/True, else None."""
    if not hasattr(model, "predict_proba"):
        return None
    try:
        proba = np.asarray(model.predict_proba(X))
    except Exception as exc:  # noqa: BLE001 - a model without usable probabilities still gets scored
        warnings.append(f"model.predict_proba() failed, so AUC was not computed: {exc}")
        return None
    if proba.ndim != 2 or proba.shape[1] != 2:
        return None
    classes = list(getattr(model, "classes_", [0, 1]))
    positive = [i for i, c in enumerate(classes) if isinstance(c, (bool, int, float, np.number, np.bool_)) and c == 1]
    if len(classes) != 2 or not positive:
        warnings.append("AUC not computed: could not identify the model's positive class (1) in classes_")
        return None
    return proba[:, positive[0]]


def score_with_model(model, dataset_bytes: bytes, limits: Limits) -> dict:
    """Model-file path: run model.predict on the companion dataset and score the output."""
    dataset = read_csv(dataset_bytes, "dataset CSV", limits)
    _check_columns(dataset, REQUIRED_DATASET_COLUMNS, "dataset CSV")
    if dataset.empty:
        raise ScoringError("Dataset CSV has no rows")

    reserved = set(REQUIRED_DATASET_COLUMNS) | {PROBABILITY_COLUMN}
    feature_columns = [c for c in dataset.columns if c not in reserved]
    if not feature_columns:
        raise ScoringError("Dataset CSV has no feature columns (only actual/protected_attribute)")

    precheck_frame(dataset, limits, ["actual", "protected_attribute"], "dataset CSV")

    if not hasattr(model, "predict"):
        raise ScoringError("Uploaded object has no .predict() method -- is this a fitted scikit-learn-compatible model?")

    X = dataset[feature_columns]
    try:
        start = time.perf_counter()
        predicted = model.predict(X)
        elapsed_ms = (time.perf_counter() - start) * 1000
    except Exception as exc:  # noqa: BLE001 - feature mismatch surfaces as many exception types
        raise ScoringError(
            f"model.predict() failed -- the dataset's feature columns likely don't match "
            f"what the model expects: {exc}"
        ) from exc

    predicted = np.asarray(predicted)
    if predicted.ndim == 2 and predicted.shape[1] == 1:
        predicted = predicted.ravel()
    if predicted.ndim != 1 or len(predicted) != len(dataset):
        raise ScoringError(
            f"model.predict() returned shape {tuple(predicted.shape)} but one prediction per row "
            f"({len(dataset)}) was expected"
        )

    warnings: list = []
    probability = _model_probability(model, X, warnings)
    frame = pd.DataFrame({
        "predicted": predicted,
        "actual": dataset["actual"].to_numpy(),
        "protected_attribute": dataset["protected_attribute"].to_numpy(),
    })
    return score_frame(frame, limits, noun="dataset CSV", latency_ms=elapsed_ms,
                       probability=probability, warnings=warnings)
