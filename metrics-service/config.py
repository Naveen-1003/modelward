"""
Environment-driven settings for the metrics service.

Settings are read from the environment on every call (cheap) instead of once at
import so tests -- and a redeploy-less config change on a long-lived worker --
see the current values. The only import-time check is the production guard in
main.py.
"""

import logging
import os
from dataclasses import dataclass

log = logging.getLogger("modelward.metrics")

_TRUE = {"1", "true", "yes", "on"}
_FALSE = {"0", "false", "no", "off"}


def _int_env(name: str, default: int, minimum: int = 0) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        value = int(raw.strip())
    except ValueError:
        log.warning("Ignoring invalid %s=%r (expected an integer); using %s", name, raw, default)
        return default
    return max(value, minimum)


def _bool_env(name: str, default: bool) -> bool:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    value = raw.strip().lower()
    if value in _TRUE:
        return True
    if value in _FALSE:
        return False
    log.warning("Ignoring invalid %s=%r (expected true/false); using %s", name, raw, default)
    return default


def is_production() -> bool:
    return os.environ.get("APP_ENV", "").strip().lower() == "production"


@dataclass(frozen=True)
class Settings:
    app_env: str
    shared_secret: str  # "" = no secret configured
    allow_model_files: bool
    max_upload_bytes: int
    min_rows: int
    min_group_rows: int
    max_rows: int
    scoring_timeout_seconds: int
    scoring_max_memory_mb: int  # 0 disables (Linux only anyway)
    max_concurrent_scorings: int


def get_settings() -> Settings:
    production = is_production()
    return Settings(
        app_env="production" if production else (os.environ.get("APP_ENV", "").strip() or "development"),
        shared_secret=os.environ.get("METRICS_SHARED_SECRET", ""),
        allow_model_files=_bool_env("ALLOW_MODEL_FILES", not production),
        max_upload_bytes=_int_env("MAX_UPLOAD_BYTES", 26214400, minimum=1),
        min_rows=_int_env("METRICS_MIN_ROWS", 30, minimum=1),
        min_group_rows=_int_env("METRICS_MIN_GROUP_ROWS", 10, minimum=1),
        max_rows=_int_env("METRICS_MAX_ROWS", 200000, minimum=1),
        scoring_timeout_seconds=_int_env("SCORING_TIMEOUT_SECONDS", 60, minimum=1),
        scoring_max_memory_mb=_int_env("SCORING_MAX_MEMORY_MB", 2048, minimum=0),
        max_concurrent_scorings=_int_env("SCORING_MAX_CONCURRENT", 2, minimum=1),
    )
