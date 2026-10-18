"""
Security tests for the restricted unpickler.

Every malicious payload here is harmless: it tries to create a marker file inside the
test's tmp_path. If the allow-list ever regresses, the marker appears and the test fails.
These tests call load_model() in-process because a correct implementation never executes
the payload.
"""

import io
import pickle
import re

import joblib
import numpy as np
import pandas as pd
import pytest
from sklearn.compose import ColumnTransformer
from sklearn.ensemble import GradientBoostingClassifier, HistGradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.neighbors import KNeighborsClassifier
from sklearn.pipeline import make_pipeline
from sklearn.preprocessing import StandardScaler
from sklearn.svm import SVC

import safe_pickle
from safe_pickle import UnsafeModelError, check_global, load_model
from scoring import ScoringError


class Evil:
    """Pickles as `func(*args)` -- the classic __reduce__ gadget."""

    def __init__(self, func, args):
        self.func, self.args = func, args

    def __reduce__(self):
        return (self.func, self.args)


def _payloads(marker):
    import os
    import subprocess
    import sys

    m = str(marker)
    write_marker = [sys.executable, "-c", f"open({m!r}, 'w').write('x')"]
    return {
        "os.system": Evil(os.system, (f'echo pwned> "{m}"',)),
        "subprocess.call": Evil(subprocess.call, (write_marker,)),
        "subprocess.Popen": Evil(subprocess.Popen, (write_marker,)),
        "builtins.eval": Evil(eval, (f"open({m!r}, 'w').write('x')",)),
        "builtins.exec": Evil(exec, (f"open({m!r}, 'w').write('x')",)),
    }


PAYLOAD_NAMES = ["os.system", "subprocess.call", "subprocess.Popen", "builtins.eval", "builtins.exec"]


def _dump_pickle(obj, protocol=4):
    return pickle.dumps(obj, protocol=protocol)


def _dump_joblib(obj):
    buf = io.BytesIO()
    joblib.dump(obj, buf)
    return buf.getvalue()


DUMPERS = {"pickle": _dump_pickle, "pickle-proto2": lambda o: _dump_pickle(o, 2), "joblib": _dump_joblib}


@pytest.mark.parametrize("dumper", DUMPERS)
@pytest.mark.parametrize("name", PAYLOAD_NAMES)
def test_reduce_payloads_are_rejected_and_never_run(tmp_path, name, dumper):
    marker = tmp_path / "pwned.txt"
    raw = DUMPERS[dumper](_payloads(marker)[name])
    with pytest.raises(UnsafeModelError, match="disallowed object"):
        load_model(raw)
    assert not marker.exists(), f"payload {name} executed!"


@pytest.mark.parametrize("dumper", DUMPERS)
def test_payload_hidden_inside_a_plausible_sklearn_model_is_rejected(tmp_path, dumper):
    marker = tmp_path / "pwned.txt"
    model = LogisticRegression()
    model.coef_ = _payloads(marker)["builtins.eval"]  # attacker-controlled attribute
    with pytest.raises(UnsafeModelError, match=r"disallowed object \((__builtin__|builtins)\.eval\)"):
        load_model(DUMPERS[dumper](model))
    assert not marker.exists()


def test_payload_hidden_in_object_dtype_array_inside_joblib_is_rejected(tmp_path):
    # joblib stores object arrays as a raw nested pickle after the wrapper -- the path a naive
    # "restrict find_class only" fix would miss.
    marker = tmp_path / "pwned.txt"
    arr = np.empty(1, dtype=object)
    arr[0] = _payloads(marker)["builtins.eval"]
    with pytest.raises(UnsafeModelError, match="disallowed object"):
        load_model(_dump_joblib({"names": arr}))
    assert not marker.exists()


@pytest.mark.parametrize("module,name", [
    ("os", "system"), ("posix", "system"), ("nt", "system"), ("subprocess", "Popen"),
    ("builtins", "eval"), ("builtins", "exec"), ("builtins", "getattr"), ("builtins", "__import__"),
    ("builtins", "open"), ("pandas", "eval"), ("pandas", "read_csv"), ("pandas", "read_pickle"),
    ("numpy", "load"), ("numpy", "fromfile"), ("numpy", "memmap"), ("numpy.lib.npyio", "NpzFile"),
    ("sklearn.base", "clone"), ("joblib", "load"), ("joblib.parallel", "Parallel"), ("joblib.numpy_pickle", "load"),
    # re-exports: names that resolve to classes from NON-allowed packages via an allowed module
    ("pandas.core.frame", "StringIO"), ("sklearn.pipeline", "chain"), ("joblib.numpy_pickle", "Path"),
    # attribute walking via dotted names (protocol 4 STACK_GLOBAL)
    ("sklearn.base", "os.system"), ("numpy", "core.multiarray._reconstruct"),
    ("importlib", "import_module"), ("sys", "modules"), ("socket", "socket"), ("ctypes", "CDLL"),
    ("pickle", "loads"), ("copyreg", "__newobj__"), ("_loss", "os"), ("_loss", "__loader__"),
])
def test_check_global_rejects(module, name):
    with pytest.raises(UnsafeModelError, match="disallowed object"):
        check_global(module, name)


@pytest.mark.parametrize("module,name", [
    ("builtins", "set"), ("builtins", "dict"), ("builtins", "frozenset"), ("builtins", "slice"),
    ("collections", "OrderedDict"), ("collections", "defaultdict"),
    ("numpy", "ndarray"), ("numpy", "dtype"), ("numpy", "float64"),
    ("numpy.core.multiarray", "_reconstruct"), ("numpy._core.multiarray", "_reconstruct"),
    ("numpy.core.multiarray", "scalar"), ("numpy._core.multiarray", "scalar"),
    ("sklearn.linear_model._logistic", "LogisticRegression"),
    ("sklearn.pipeline", "Pipeline"), ("pandas.core.frame", "DataFrame"), ("scipy.sparse._csr", "csr_matrix"),
    ("joblib.numpy_pickle", "NumpyArrayWrapper"),
])
def test_check_global_allows(module, name):
    assert check_global(module, name) is not None


def test_error_message_names_the_offending_object():
    raw = _dump_pickle(Evil(eval, ("1",)))
    with pytest.raises(UnsafeModelError) as exc:
        load_model(raw)
    assert str(exc.value) == "Model file contains a disallowed object (builtins.eval)"


# ---- legitimate models must still load -----------------------------------------------


def _fit_models():
    rng = np.random.default_rng(0)
    X = pd.DataFrame(rng.random((120, 4)), columns=list("abcd"))  # DataFrame => object-dtype feature_names_in_
    y = (X["a"] + X["b"] > 1).astype(int)
    models = {
        "logreg": LogisticRegression(),
        "forest": RandomForestClassifier(n_estimators=3, random_state=0),
        "gbm": GradientBoostingClassifier(n_estimators=3, random_state=0),
        "hist-gbm": HistGradientBoostingClassifier(max_iter=3),
        "svc": SVC(probability=True, random_state=0),
        "knn": KNeighborsClassifier(),
        "pipeline": make_pipeline(StandardScaler(), LogisticRegression()),
        "column-transformer": make_pipeline(ColumnTransformer([("s", StandardScaler(), ["a", "b"])], remainder="passthrough"),
                                            LogisticRegression()),
    }
    for model in models.values():
        model.fit(X, y)
    return X, models


_X, _MODELS = _fit_models()


@pytest.mark.parametrize("dumper", ["pickle", "pickle-proto2", "joblib", "joblib-compressed"])
@pytest.mark.parametrize("name", list(_MODELS))
def test_common_sklearn_models_round_trip(name, dumper):
    model = _MODELS[name]
    if dumper == "joblib-compressed":
        buf = io.BytesIO()
        joblib.dump(model, buf, compress=3)
        raw = buf.getvalue()
    else:
        raw = DUMPERS[dumper](model)
    loaded = load_model(raw)
    np.testing.assert_array_equal(loaded.predict(_X), model.predict(_X))


def test_shipped_sample_model_loads(sample):
    model = load_model(sample("dummy_model.joblib"))
    assert type(model).__name__ == "LogisticRegression"


@pytest.mark.parametrize("raw", [b"", b"not a pickle at all", b"predicted,actual\n1,1\n", b"\x80\x04\x95garbage"])
def test_garbage_is_a_clear_scoring_error(raw):
    with pytest.raises(ScoringError, match="Could not load model file"):
        load_model(raw)


def test_module_documents_its_limits():
    # honesty guard: the docstring must keep saying this is defense-in-depth
    assert "NOT a guarantee" in safe_pickle.__doc__ and "CSV-only" in safe_pickle.__doc__
    assert re.search(r"ALLOW_MODEL_FILES", safe_pickle.__doc__)
