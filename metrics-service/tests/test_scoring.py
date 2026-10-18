"""Unit tests for scoring.py -- no subprocess, no HTTP."""

import io
import json

import numpy as np
import pandas as pd
import pytest

from scoring import Limits, ScoringError, score_frame, score_predictions_csv, score_with_model

SMALL = Limits(min_rows=8, max_rows=1000, min_group_rows=4)


def frame(predicted, actual, group, probability=None):
    data = {"predicted": predicted, "actual": actual, "protected_attribute": group}
    if probability is not None:
        data["probability"] = probability
    return pd.DataFrame(data)


def csv_bytes(df: pd.DataFrame) -> bytes:
    return df.to_csv(index=False).encode()


# Hand-computed fixture (12 rows, groups A and B of 6):
#   A: actual 1 1 1 0 0 0 / pred 1 1 0 0 0 1  -> acc 4/6, positive rate 3/6, TPR 2/3
#   B: actual 1 1 0 0 0 0 / pred 1 0 0 1 0 0  -> acc 4/6, positive rate 2/6, TPR 1/2
#   TP=3 FP=2 FN=2 -> precision = recall = f1 = 0.6;  AUC = 28.5/35 = 57/70
HAND = frame(
    [1, 1, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0],
    [1, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0],
    ["A"] * 6 + ["B"] * 6,
    [.9, .8, .4, .3, .2, .6, .7, .3, .6, .1, .2, .5],
)


def test_hand_computed_binary_metrics():
    r = score_frame(HAND, SMALL)
    assert r["rows"] == 12
    assert r["accuracy"] == pytest.approx(8 / 12)
    assert r["fairness_gap"] == pytest.approx(0.0)
    assert r["demographic_parity_diff"] == pytest.approx(0.5 - 2 / 6)
    assert r["equal_opportunity_diff"] == pytest.approx(2 / 3 - 1 / 2)
    assert r["disparate_impact_ratio"] == pytest.approx((2 / 6) / 0.5)
    assert r["precision"] == pytest.approx(0.6)
    assert r["recall"] == pytest.approx(0.6)
    assert r["f1"] == pytest.approx(0.6)
    assert r["auc"] == pytest.approx(57 / 70)
    assert r["latency_ms"] is None
    a, b = r["groups"]
    assert (a["group"], a["count"], a["positive_rate"]) == ("A", 6, 0.5)
    assert a["accuracy"] == pytest.approx(4 / 6) and a["tpr"] == pytest.approx(2 / 3)
    assert (b["group"], b["tpr"]) == ("B", 0.5)
    assert b["positive_rate"] == pytest.approx(2 / 6)


def test_auc_matches_sklearn_with_ties():
    from sklearn.metrics import roc_auc_score

    rng = np.random.default_rng(1)
    actual = rng.integers(0, 2, 200)
    prob = np.round(rng.random(200), 1)  # many ties
    df = frame(rng.integers(0, 2, 200), actual, rng.integers(0, 2, 200), prob)
    assert score_frame(df, Limits())["auc"] == pytest.approx(roc_auc_score(actual, prob))


def test_fairness_gap_is_max_minus_min_group_accuracy():
    # A: 5/5 correct, B: 3/5 correct -> gap 0.4, accuracy 0.8
    df = frame([1] * 10, [1] * 5 + [1, 1, 1, 0, 0], ["A"] * 5 + ["B"] * 5)
    r = score_frame(df, SMALL)
    assert r["accuracy"] == pytest.approx(0.8)
    assert r["fairness_gap"] == pytest.approx(0.4)


def test_results_are_json_safe_even_with_degenerate_inputs():
    # nobody has a positive actual, group B predicts positive and A never does
    df = frame([0] * 6 + [1] * 6, [0] * 12, ["A"] * 6 + ["B"] * 6)
    r = score_frame(df, SMALL)
    json.dumps(r, allow_nan=False)
    assert r["disparate_impact_ratio"] == 0.0
    assert r["equal_opportunity_diff"] is None  # no group has positive actuals
    assert any("no positive actual rows" in w for w in r["warnings"])


def test_disparate_impact_null_when_nobody_predicted_positive():
    df = frame([0] * 12, [0, 1] * 6, ["A"] * 6 + ["B"] * 6)
    r = score_frame(df, SMALL)
    assert r["disparate_impact_ratio"] is None
    assert r["precision"] == 0.0 and r["recall"] == 0.0 and r["f1"] == 0.0  # zero_division=0


# ---- dtype / label coherence ---------------------------------------------------------


@pytest.mark.parametrize("predicted,actual", [
    ([1, 0] * 6, ["1", "0"] * 6),
    ([1.0, 0.0] * 6, [1, 0] * 6),
    ([True, False] * 6, [1, 0] * 6),
    (["1", "0"] * 6, [1.0, 0.0] * 6),
    ([True, False] * 6, [True, False] * 6),
])
def test_numeric_like_labels_compare_numerically(predicted, actual):
    r = score_frame(frame(predicted, actual, ["A", "B"] * 6), SMALL)
    assert r["accuracy"] == 1.0
    assert r["precision"] == 1.0


def test_text_labels_compare_case_and_whitespace_insensitively():
    r = score_frame(frame(["Yes", " no ", "YES", "No"] * 3, ["yes", "no", "yes", "no"] * 3, ["A", "B"] * 6), SMALL)
    assert r["accuracy"] == 1.0
    # text labels have no defined positive class -> positive-class metrics are skipped, with a warning
    assert r["precision"] is None and r["auc"] is None and r["demographic_parity_diff"] is None
    assert any("Positive-class metrics skipped" in w for w in r["warnings"])


def test_mixed_numeric_and_text_labels_are_an_error_not_zero_accuracy():
    with pytest.raises(ScoringError, match="different label types"):
        score_frame(frame([1, 0] * 6, ["yes", "no"] * 6, ["A", "B"] * 6), SMALL)
    with pytest.raises(ScoringError, match="different label types"):
        score_frame(frame(["yes", "no"] * 6, [1, 0] * 6, ["A", "B"] * 6), SMALL)


def test_non_binary_labels_skip_positive_class_metrics():
    r = score_frame(frame([0, 1, 2] * 4, [0, 1, 1] * 4, ["A", "B"] * 6), SMALL)
    assert r["accuracy"] == pytest.approx(8 / 12)
    assert r["fairness_gap"] is not None
    for key in ("precision", "recall", "f1", "auc", "demographic_parity_diff", "equal_opportunity_diff", "disparate_impact_ratio"):
        assert r[key] is None
    assert r["groups"][0]["positive_rate"] is None
    assert any("not binary" in w for w in r["warnings"])


def test_protected_attribute_variants_are_one_group():
    # 1, 1.0 and "1" must not split into separate groups
    df = frame([1, 0] * 8, [1, 0] * 8, [1, 0, 1.0, 0.0] * 4)
    assert [g["group"] for g in score_frame(df, SMALL)["groups"]] == ["0", "1"]


# ---- validation ----------------------------------------------------------------------


def test_minimum_rows():
    with pytest.raises(ScoringError, match=r"only 5 row\(s\); at least 30"):
        score_frame(frame([1] * 5, [1] * 5, ["A", "B"] * 2 + ["A"]), Limits())


def test_maximum_rows_via_csv_parse():
    raw = csv_bytes(frame([1, 0] * 10, [1, 0] * 10, ["A", "B"] * 10))
    with pytest.raises(ScoringError, match="more than the maximum of 15 rows"):
        score_predictions_csv(raw, Limits(min_rows=1, max_rows=15, min_group_rows=1))


def test_group_too_small_names_the_group():
    df = frame([1, 0] * 7 + [1], [1, 0] * 7 + [1], ["big"] * 14 + ["tiny"])
    with pytest.raises(ScoringError, match=r"'tiny' \(1 row"):
        score_frame(df, Limits(min_rows=8, min_group_rows=4))


def test_single_group_rejected():
    with pytest.raises(ScoringError, match="only one group"):
        score_frame(frame([1, 0] * 6, [1, 0] * 6, ["A"] * 12), SMALL)


@pytest.mark.parametrize("column", ["predicted", "actual", "protected_attribute"])
def test_missing_values_are_counted_per_column(column):
    df = frame([1, 0] * 6, [1, 0] * 6, ["A", "B"] * 6)
    df[column] = df[column].astype(object)
    df.loc[[0, 1], column] = np.nan
    with pytest.raises(ScoringError, match=rf"2 row\(s\) have missing values .*{column} \(2\)"):
        score_frame(df, SMALL)


def test_blank_strings_count_as_missing():
    df = frame([1, 0] * 6, ["1", "0"] * 5 + ["", " "], ["A", "B"] * 6)
    with pytest.raises(ScoringError, match=r"2 row\(s\) have missing values"):
        score_frame(df, SMALL)


def test_csv_missing_columns_and_garbage():
    with pytest.raises(ScoringError, match="CSV is missing required column"):
        score_predictions_csv(b"predicted,actual\n1,1\n", SMALL)
    with pytest.raises(ScoringError, match="no rows"):
        score_predictions_csv(b"", SMALL)
    with pytest.raises(ScoringError, match="Could not parse CSV"):
        score_predictions_csv(b"\xff\xfe\x00bad\x00", SMALL)


# ---- probability handling --------------------------------------------------------------


def test_invalid_probability_column_is_ignored_with_warning():
    df = HAND.copy()
    df.loc[0, "probability"] = 1.5
    r = score_frame(df, SMALL)
    assert r["auc"] is None
    assert any("probability column ignored" in w for w in r["warnings"])
    assert r["precision"] == pytest.approx(0.6)  # everything else still computed


def test_auc_null_when_actual_has_one_class():
    df = frame([1, 0] * 6, [1] * 12, ["A", "B"] * 6, [.9, .1] * 6)
    r = score_frame(df, SMALL)
    assert r["auc"] is None
    assert any("only one class" in w for w in r["warnings"])


def test_small_group_warning():
    r = score_frame(HAND, SMALL)
    assert any("fewer than 30 rows" in w for w in r["warnings"])


# ---- model path (fake model, no pickle involved) ---------------------------------------


class FakeModel:
    def __init__(self, preds, proba=None, classes=(0, 1)):
        self._preds, self._proba, self.classes_ = np.asarray(preds), proba, np.asarray(classes)

    def predict(self, X):
        return self._preds

    def predict_proba(self, X):
        if self._proba is None:
            raise AttributeError("no probabilities")
        return self._proba


def dataset_csv(n=12):
    return csv_bytes(pd.DataFrame({
        "f1": np.arange(n), "f2": np.arange(n)[::-1],
        "actual": [1, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0][:n],
        "protected_attribute": ["A"] * 6 + ["B"] * 6,
    }))


PREDS = [1, 1, 0, 0, 0, 1, 1, 0, 0, 1, 0, 0]


def test_model_path_scores_and_measures_latency():
    r = score_with_model(FakeModel(PREDS), dataset_csv(), SMALL)
    assert r["accuracy"] == pytest.approx(8 / 12)
    assert r["latency_ms"] is not None and r["latency_ms"] >= 0
    assert r["auc"] is None
    assert any("predict_proba() failed" in w for w in r["warnings"])  # the fake raises; scoring carries on


def test_model_path_uses_predict_proba_for_auc():
    probs = np.array([.9, .8, .4, .3, .2, .6, .7, .3, .6, .1, .2, .5])
    model = FakeModel(PREDS, proba=np.column_stack([1 - probs, probs]))
    assert score_with_model(model, dataset_csv(), SMALL)["auc"] == pytest.approx(57 / 70)


def test_model_path_features_exclude_actual_protected_and_probability():
    seen = {}

    class Spy(FakeModel):
        def predict(self, X):
            seen["cols"] = list(X.columns)
            return self._preds

    df = pd.read_csv(io.BytesIO(dataset_csv()))
    df["probability"] = 0.5
    score_with_model(Spy(PREDS), csv_bytes(df), SMALL)
    assert seen["cols"] == ["f1", "f2"]


def test_model_predict_failure_keeps_documented_phrase():
    class Broken(FakeModel):
        def predict(self, X):
            raise ValueError("X has 3 features, but model is expecting 4")

    with pytest.raises(ScoringError, match=r"model\.predict\(\) failed -- the dataset's feature columns likely don't match"):
        score_with_model(Broken([]), dataset_csv(), SMALL)


def test_model_wrong_prediction_shape():
    with pytest.raises(ScoringError, match="one prediction per row"):
        score_with_model(FakeModel([1, 0, 1]), dataset_csv(), SMALL)


def test_model_without_predict():
    with pytest.raises(ScoringError, match=r"no \.predict"):
        score_with_model(object(), dataset_csv(), SMALL)


def test_model_string_predictions_vs_numeric_actual_is_label_type_error():
    with pytest.raises(ScoringError, match="different label types"):
        score_with_model(FakeModel(["yes"] * 12), dataset_csv(), SMALL)
