from __future__ import annotations

import json
import os
import re
from dataclasses import dataclass
from pathlib import Path


SERVICE_ROOT = Path(__file__).resolve().parents[1]
PROJECT_ROOT = SERVICE_ROOT.parent
DEFAULT_INDEX_ROOT = SERVICE_ROOT / "data" / "indexes"


def _positive_int(name: str, default: int, minimum: int = 1) -> int:
    try:
        return max(minimum, int(os.getenv(name, str(default))))
    except ValueError:
        return default


def _positive_float(name: str, default: float, minimum: float = 0.01) -> float:
    try:
        return max(minimum, float(os.getenv(name, str(default))))
    except ValueError:
        return default


@dataclass(frozen=True, slots=True)
class Settings:
    service_name: str
    host: str
    port: int
    service_key: str
    metrics_token: str
    index_root: Path
    active_version: str
    engine: str
    max_concurrency: int
    queue_timeout_seconds: float
    request_timeout_seconds: float
    cache_ttl_seconds: int
    cache_max_entries: int
    max_top_k: int
    official_project_root: Path
    environment: str = "development"

    @property
    def production(self) -> bool:
        return self.environment in {"production", "prod"}

    def validate_service_auth(self) -> None:
        if not self.production:
            return

        def weak_secret(value: str) -> bool:
            key = value.strip()
            return (
                len(key) < 32
                or len(set(key)) < 8
                or bool(re.search(r"\s", key))
                or bool(re.search(
                    r"(?:replace|placeholder|changeme|example|dummy|fake|test[-_ ]?(?:key|secret))",
                    key,
                    re.I,
                ))
            )

        if weak_secret(self.service_key):
            raise RuntimeError("PRODUCTION_GRAPHRAG_SERVICE_KEY_REQUIRED")
        if weak_secret(self.metrics_token):
            raise RuntimeError("PRODUCTION_GRAPHRAG_METRICS_TOKEN_REQUIRED")
        if self.metrics_token.strip() == self.service_key.strip():
            raise RuntimeError("PRODUCTION_GRAPHRAG_METRICS_TOKEN_REUSE_FORBIDDEN")

    @classmethod
    def from_env(cls) -> "Settings":
        environment = os.getenv("HUAMEI_ENVIRONMENT", os.getenv("APP_ENV", "development")).strip().lower()
        index_root = Path(os.getenv("HUAMEI_GRAPHRAG_INDEX_ROOT", str(DEFAULT_INDEX_ROOT))).expanduser().resolve()
        active_version = os.getenv("HUAMEI_GRAPHRAG_INDEX_VERSION", "").strip()
        pointer = index_root / "current.json"
        # Development may follow the convenience pointer. Production must name
        # the immutable version explicitly and never inherit a mutable pointer.
        if not active_version and environment not in {"production", "prod"} and pointer.exists():
            try:
                active_version = str(json.loads(pointer.read_text(encoding="utf-8")).get("version", "")).strip()
            except (OSError, ValueError):
                active_version = ""
        return cls(
            service_name="huamei-graphrag-retrieval",
            host=os.getenv("HUAMEI_GRAPHRAG_HOST", "127.0.0.1"),
            port=_positive_int("HUAMEI_GRAPHRAG_PORT", 4191, 1),
            service_key=os.getenv("HUAMEI_GRAPHRAG_SERVICE_KEY", "").strip(),
            metrics_token=os.getenv("HUAMEI_GRAPHRAG_METRICS_TOKEN", "").strip(),
            index_root=index_root,
            active_version=active_version,
            engine=os.getenv("HUAMEI_GRAPHRAG_ENGINE", "auto").strip().lower(),
            max_concurrency=_positive_int("HUAMEI_GRAPHRAG_MAX_CONCURRENCY", 128, 4),
            queue_timeout_seconds=_positive_float("HUAMEI_GRAPHRAG_QUEUE_TIMEOUT_SECONDS", 1.0),
            request_timeout_seconds=_positive_float("HUAMEI_GRAPHRAG_REQUEST_TIMEOUT_SECONDS", 6.0),
            cache_ttl_seconds=_positive_int("HUAMEI_GRAPHRAG_CACHE_TTL_SECONDS", 300, 1),
            cache_max_entries=_positive_int("HUAMEI_GRAPHRAG_CACHE_MAX_ENTRIES", 5000, 100),
            max_top_k=_positive_int("HUAMEI_GRAPHRAG_MAX_TOP_K", 12, 1),
            official_project_root=Path(os.getenv(
                "HUAMEI_GRAPHRAG_OFFICIAL_PROJECT_ROOT",
                str(SERVICE_ROOT / "graphrag_project"),
            )).expanduser().resolve(),
            environment=environment,
        )
