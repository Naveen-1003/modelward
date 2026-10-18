"""
Restricted loading of uploaded model files (.pkl / .pickle / .joblib).

SECURITY STATUS -- read this before relying on it.
Unpickling untrusted bytes is inherently dangerous. This module is one layer of
defense-in-depth, NOT a guarantee:

  1. find_class only resolves *classes* from an allow-list of top-level packages
     (sklearn, numpy, scipy, pandas, joblib) plus a handful of plain builtins and a
     tiny explicit list of helper functions that numpy/sklearn pickles need.
     os, subprocess, builtins.eval/exec/getattr/__import__, pandas.eval/read_*,
     numpy.load ... are all rejected before they are ever imported.
  2. The unpickler runs in a throw-away child process with a stripped environment,
     a temp working directory, a timeout and (Linux) memory/CPU rlimits (runner.py).
  3. ALLOW_MODEL_FILES=false (the default when APP_ENV=production) turns the whole
     feature off.

Known limits: a class from an allowed package could still be abused by a clever
attacker (constructors and __setstate__ run with attacker-chosen arguments), and a
fitted model's predict() is trusted code once loaded. The safest production
setting is CSV-only (ALLOW_MODEL_FILES=false). Do not treat this as a sandbox.

How it hooks into joblib: joblib.load builds a NumpyUnpickler (a pickle._Unpickler
subclass that also reads numpy arrays stored inline in the stream). We subclass that
same class and override find_class -- so the stock joblib file format (shipped
sample dummy_model.joblib) still loads -- and we also override its BUILD handler,
because joblib reads object-dtype arrays (e.g. sklearn's feature_names_in_) with a bare
pickle.load() that would bypass our find_class; we read those with the restricted class. This relies on joblib internals (pinned: joblib==1.4.2).
Plain pickle files are loaded by the very same class: a NumpyUnpickler reads a
vanilla pickle stream fine.
"""

import importlib
import io
import os
import pickle
import sys

from joblib.numpy_pickle import NumpyArrayWrapper, NumpyUnpickler
from joblib.numpy_pickle_utils import _ensure_native_byte_order, _read_fileobject

from scoring import ScoringError


class UnsafeModelError(ScoringError):
    """The model file references something outside the allow-list."""


ALLOWED_PACKAGES = frozenset({"sklearn", "numpy", "scipy", "pandas", "joblib"})

# Plain builtins/collections types, matched on (module, name) exactly.
_ALLOWED_BUILTINS = frozenset({
    "set", "frozenset", "slice", "range", "complex", "bytearray", "object", "dict", "list",
    "tuple", "int", "float", "str", "bool", "bytes",
})
_ALLOWED_EXACT_CLASSES = frozenset(
    {(mod, n) for mod in ("builtins", "__builtin__") for n in _ALLOWED_BUILTINS}
    | {("collections", "OrderedDict"), ("collections", "defaultdict")}
)

# Non-class helpers that real numpy/sklearn pickles reference. Keep this list tiny and explicit.
# numpy 2 moved numpy.core -> numpy._core; both spellings are accepted (see _normalise_module).
_ALLOWED_FUNCTIONS = frozenset({
    ("numpy._core.multiarray", "_reconstruct"),
    ("numpy._core.multiarray", "scalar"),
    ("numpy._core.numeric", "_frombuffer"),          # pickle protocol 5 ndarrays
    ("numpy.random._pickle", "__randomstate_ctor"),   # RandomState inside forests etc.
    ("numpy.random._pickle", "__generator_ctor"),
    ("numpy.random._pickle", "__bit_generator_ctor"),
    ("numpy.random.bit_generator", "__pyx_unpickle_SeedSequence"),
    ("sklearn.metrics._dist_metrics", "newObj"),      # KNN / tree-based neighbours
    ("sklearn.neighbors._kd_tree", "newObj"),
    ("sklearn.neighbors._ball_tree", "newObj"),
    ("copyreg", "_reconstructor"),                    # protocol 0/1 plain-object pickles
    ("_codecs", "encode"),                            # protocol 2 bytes
})

# Inside an allowed package, still refuse modules that exist to touch files, the network or the
# interpreter. Prefix match on the dotted module path.
_DENIED_MODULE_PREFIXES = (
    "numpy.testing", "numpy.distutils", "numpy.f2py", "numpy.ctypeslib", "numpy._pyinstaller",
    "numpy.lib.npyio", "numpy.lib._npyio_impl", "numpy.lib.format", "numpy.lib._format_impl",
    "numpy.lib._datasource", "numpy.lib.utils", "numpy.lib._utils_impl",
    "scipy.io", "scipy.datasets", "scipy._lib._testutils",
    "pandas.io", "pandas.util", "pandas._testing", "pandas.testing", "pandas.compat",
    "sklearn.datasets", "sklearn.utils._testing", "sklearn.utils.estimator_checks",
    "joblib.externals", "joblib.memory", "joblib.parallel", "joblib._memmapping_reducer",
)
# joblib is allowed only for its own array wrapper -- nothing else in it is needed to load a model.
_ALLOWED_JOBLIB = frozenset({("joblib.numpy_pickle", "NumpyArrayWrapper")})

# Classes that open files or fetch data on construction, wherever they are re-exported from.
_DENIED_CLASS_NAMES = frozenset({
    "memmap", "DataSource", "NpzFile", "HDFStore", "ExcelWriter", "ExcelFile", "Memory", "Parallel",
})


def _normalise_module(module: str) -> str:
    if module == "numpy.core" or module.startswith("numpy.core."):
        return "numpy._core" + module[len("numpy.core"):]
    return module


def _import(module: str):
    try:
        return importlib.import_module(module)
    except ImportError:
        if module.startswith("numpy._core"):  # numpy 1.x: only numpy.core exists
            return importlib.import_module("numpy.core" + module[len("numpy._core"):])
        raise


def _reject(module: str, name: str):
    raise UnsafeModelError(f"Model file contains a disallowed object ({module}.{name})")


def _sklearn_loss_class(name: str):
    """sklearn 1.x pickles its Cython loss classes (GradientBoosting, HistGradientBoosting,
    LogisticRegression variants...) under the bare module name `_loss`. Accept that only when
    `_loss` really is sklearn's compiled extension, and only for its Cy* classes."""
    importlib.import_module("sklearn._loss._loss")
    mod = sys.modules.get("_loss")
    sklearn_dir = os.path.dirname(importlib.import_module("sklearn").__file__)
    if mod is None or not str(getattr(mod, "__file__", "")).startswith(sklearn_dir):
        _reject("_loss", name)
    obj = getattr(mod, name, None)
    if not isinstance(obj, type) or not name.startswith("Cy"):
        _reject("_loss", name)
    return obj


def check_global(module: str, name: str):
    """Resolve (module, name) if it is on the allow-list, else raise UnsafeModelError."""
    if not isinstance(module, str) or not isinstance(name, str) or "." in name:
        _reject(module, name)  # dotted names would let protocol 4 walk attributes

    if (module, name) in _ALLOWED_EXACT_CLASSES:
        return getattr(importlib.import_module("builtins" if module == "__builtin__" else module), name)

    if module == "_loss":
        return _sklearn_loss_class(name)

    norm = _normalise_module(module)
    top = norm.split(".")[0]
    if top not in ALLOWED_PACKAGES and (norm, name) not in _ALLOWED_FUNCTIONS:
        _reject(module, name)
    if name in _DENIED_CLASS_NAMES:
        _reject(module, name)
    if any(norm == p or norm.startswith(p + ".") for p in _DENIED_MODULE_PREFIXES):
        _reject(module, name)
    if top == "joblib" and (norm, name) not in _ALLOWED_JOBLIB:
        _reject(module, name)

    obj = getattr(_import(norm), name, None)
    if (norm, name) in _ALLOWED_FUNCTIONS:
        return obj if obj is not None else _reject(module, name)
    # Classes only, and only classes that really live in an allowed package: a module in
    # sklearn that does `from subprocess import Popen` must not become a back door.
    if not isinstance(obj, type) or obj.__name__ in _DENIED_CLASS_NAMES:
        _reject(module, name)
    if str(getattr(obj, "__module__", "")).split(".")[0] not in ALLOWED_PACKAGES | {"builtins", "collections"}:
        _reject(module, name)
    return obj


class RestrictedUnpickler(NumpyUnpickler):
    """joblib's NumpyUnpickler with an allow-listing find_class (see module docstring)."""

    dispatch = NumpyUnpickler.dispatch.copy()

    def __init__(self, file_handle):
        super().__init__("", file_handle, mmap_mode=None)

    def find_class(self, module, name):
        return check_global(module, name)

    def load_build(self):
        # Same as NumpyUnpickler.load_build, except object-dtype arrays (e.g. sklearn's
        # feature_names_in_) are read with *this* restricted class: joblib itself would use a
        # bare pickle.load() on them, which would bypass find_class.
        pickle._Unpickler.load_build(self)
        top = self.stack[-1]
        if isinstance(top, NumpyArrayWrapper):
            self.stack.pop()
            if getattr(top, "dtype", None) is not None and top.dtype.hasobject:
                array = _ensure_native_byte_order(RestrictedUnpickler(self.file_handle).load())
            else:
                array = top.read(self)
            self.stack.append(array)

    dispatch[pickle.BUILD[0]] = load_build


def load_model(raw: bytes):
    """Load a pickle/joblib model from bytes under the allow-list; raises ScoringError on failure."""
    try:
        with _read_fileobject(io.BytesIO(raw), "", None) as fobj:
            if isinstance(fobj, str):
                raise ScoringError("Model file uses a legacy joblib format that is not supported; re-save it with a current joblib")
            return RestrictedUnpickler(fobj).load()
    except ScoringError:
        raise
    except MemoryError:
        raise
    except Exception as exc:  # noqa: BLE001 - corrupt/truncated/unsupported streams raise many types
        raise ScoringError(f"Could not load model file: it is not a valid pickle/joblib file ({type(exc).__name__})") from exc
