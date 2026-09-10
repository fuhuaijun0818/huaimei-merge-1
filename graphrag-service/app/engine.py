from __future__ import annotations

import inspect
from pathlib import Path
from typing import Protocol

from .bootstrap_engine import BootstrapGraphEngine
from .config import Settings
from .models import RetrievalRequest, RetrievalResult
from .official_engine import OfficialGraphRagEngine


class RetrievalEngine(Protocol):
    name: str
    version: str

    def search(self, request: RetrievalRequest): ...

    def validate_request(self, request: RetrievalRequest) -> None: ...


def _bootstrap_file(settings: Settings) -> Path:
    if not settings.active_version:
        raise RuntimeError("GRAPHRAG_INDEX_VERSION_NOT_PUBLISHED")
    return settings.index_root / settings.active_version / "bootstrap.json.gz"


def create_engine(settings: Settings) -> RetrievalEngine:
    requested = settings.engine
    if requested not in {"auto", "bootstrap", "official"}:
        raise RuntimeError(f"UNSUPPORTED_GRAPHRAG_ENGINE:{requested}")
    if settings.production and requested != "official":
        raise RuntimeError("PRODUCTION_REQUIRES_OFFICIAL_GRAPHRAG")
    if settings.production and not settings.active_version:
        raise RuntimeError("PRODUCTION_GRAPHRAG_INDEX_VERSION_REQUIRED")
    if requested in {"auto", "official"} and OfficialGraphRagEngine.is_available(settings.official_project_root):
        return OfficialGraphRagEngine(
            settings.official_project_root,
            settings.active_version,
        )
    if requested == "official":
        raise RuntimeError("OFFICIAL_GRAPHRAG_INDEX_NOT_READY")
    index_file = _bootstrap_file(settings)
    if not index_file.exists():
        raise RuntimeError(f"BOOTSTRAP_INDEX_NOT_FOUND:{index_file}")
    return BootstrapGraphEngine(index_file)


async def run_engine_search(engine: RetrievalEngine, request: RetrievalRequest) -> RetrievalResult:
    result = engine.search(request)
    if inspect.isawaitable(result):
        return await result
    return result
