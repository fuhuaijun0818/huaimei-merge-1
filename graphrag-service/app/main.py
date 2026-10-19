from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import time
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field

import orjson
from fastapi import FastAPI, Header, HTTPException, Request, Response, status

from . import __version__
from .cache import canonical_cache_query
from .redis_cache import create_cache
from .config import Settings
from .engine import create_engine, run_engine_search
from .index_manifest import RequestBindingError
from .models import RetrievalRequest, RetrievalResponse, RetrievalResult
from .query_privacy import approved_retrieval_terms, validate_retrieval_query_privacy


logger = logging.getLogger("huamei.graphrag")


@dataclass(slots=True)
class Metrics:
    started_at: float = field(default_factory=time.monotonic)
    requests: int = 0
    success: int = 0
    errors: int = 0
    overloaded: int = 0
    cache_hits: int = 0
    cache_misses: int = 0
    query_model_attempts: int = 0
    query_model_successes: int = 0
    query_model_errors: int = 0
    query_model_prompt_tokens: int = 0
    query_model_output_tokens: int = 0
    query_model_provider: str = "unknown"
    query_model_name: str = "unknown"
    query_model_accounting: str = "unknown"
    query_hash_counts: dict[str, int] = field(default_factory=dict)
    total_ms: float = 0.0
    active: int = 0
    peak_active: int = 0

    def snapshot(self, cache_size: int) -> dict:
        return {
            "requests": self.requests,
            "success": self.success,
            "errors": self.errors,
            "overloaded": self.overloaded,
            "cache_hits": self.cache_hits,
            "cache_misses": self.cache_misses,
            "cache_hit_rate": round(self.cache_hits / self.success, 4) if self.success else 0,
            "average_ms": round(self.total_ms / self.success, 3) if self.success else 0,
            "active": self.active,
            "peak_active": self.peak_active,
            "cache_entries": cache_size,
            "uptime_seconds": round(time.monotonic() - self.started_at, 1),
        }

    def observe_query_hash(self, query_sha256: str) -> None:
        key = query_sha256 if len(self.query_hash_counts) < 20_000 or query_sha256 in self.query_hash_counts else "overflow"
        self.query_hash_counts[key] = self.query_hash_counts.get(key, 0) + 1

    def observe_query_model(self, usage: dict, *, successful: bool) -> None:
        attempts = max(0, int(usage.get("attempts") or 0))
        successes = max(0, int(usage.get("successes") or 0)) if successful else 0
        self.query_model_attempts += attempts
        self.query_model_successes += min(successes, attempts)
        self.query_model_errors += max(0, attempts - min(successes, attempts))
        self.query_model_prompt_tokens += max(0, int(usage.get("prompt_tokens") or 0))
        self.query_model_output_tokens += max(0, int(usage.get("output_tokens") or 0))
        self.query_model_provider = str(usage.get("provider") or self.query_model_provider)[:80]
        self.query_model_name = str(usage.get("model") or self.query_model_name)[:120]
        self.query_model_accounting = str(usage.get("accounting") or self.query_model_accounting)[:80]

    @staticmethod
    def _label(value: str) -> str:
        return str(value).replace("\\", "\\\\").replace("\n", "\\n").replace('"', '\\"')

    def prometheus(self, engine: object) -> str:
        service = self._label("huamei-graphrag-retrieval")
        mode = "local"
        provider = self._label(self.query_model_provider)
        model = self._label(self.query_model_name)
        accounting = self._label(self.query_model_accounting)
        lines = [
            "# HELP huamei_graphrag_queries_total Privacy-approved GraphRAG retrieval requests",
            "# TYPE huamei_graphrag_queries_total counter",
            f'huamei_graphrag_queries_total{{service="{service}",mode="{mode}",outcome="attempt"}} {self.requests}',
            f'huamei_graphrag_queries_total{{service="{service}",mode="{mode}",outcome="success"}} {self.success}',
            f'huamei_graphrag_queries_total{{service="{service}",mode="{mode}",outcome="error"}} {self.errors}',
            "# HELP huamei_graphrag_cache_total GraphRAG service query-cache outcomes",
            "# TYPE huamei_graphrag_cache_total counter",
            f'huamei_graphrag_cache_total{{service="{service}",result="hit"}} {self.cache_hits}',
            f'huamei_graphrag_cache_total{{service="{service}",result="miss"}} {self.cache_misses}',
            "# HELP huamei_graphrag_query_model_requests_total Official GraphRAG query-model calls",
            "# TYPE huamei_graphrag_query_model_requests_total counter",
            f'huamei_graphrag_query_model_requests_total{{service="{service}",provider="{provider}",model="{model}",outcome="attempt"}} {self.query_model_attempts}',
            f'huamei_graphrag_query_model_requests_total{{service="{service}",provider="{provider}",model="{model}",outcome="success"}} {self.query_model_successes}',
            f'huamei_graphrag_query_model_requests_total{{service="{service}",provider="{provider}",model="{model}",outcome="error"}} {self.query_model_errors}',
            "# HELP huamei_graphrag_query_model_tokens_total Token usage reported by the pinned official GraphRAG SearchResult",
            "# TYPE huamei_graphrag_query_model_tokens_total counter",
            f'huamei_graphrag_query_model_tokens_total{{service="{service}",provider="{provider}",model="{model}",direction="input",accounting="{accounting}"}} {self.query_model_prompt_tokens}',
            f'huamei_graphrag_query_model_tokens_total{{service="{service}",provider="{provider}",model="{model}",direction="output",accounting="{accounting}"}} {self.query_model_output_tokens}',
            "# HELP huamei_graphrag_active_requests Current GraphRAG requests in execution",
            "# TYPE huamei_graphrag_active_requests gauge",
            f'huamei_graphrag_active_requests{{service="{service}"}} {self.active}',
            "# HELP huamei_graphrag_sanitized_queries_total Privacy-approved query hashes observed by the retrieval service",
            "# TYPE huamei_graphrag_sanitized_queries_total counter",
        ]
        for query_hash, count in sorted(self.query_hash_counts.items()):
            lines.append(f'huamei_graphrag_sanitized_queries_total{{service="{service}",query_sha256="{self._label(query_hash)}"}} {count}')
        return "\n".join(lines) + "\n"


def cache_key(request: RetrievalRequest, index_version: str) -> str:
    canonical = orjson.dumps({
        "index": index_version,
        "tenant": request.tenant_id,
        "query": canonical_cache_query(request.query),
        "mode": request.mode,
        "top_k": request.top_k,
        "top_k_entities": request.top_k_entities,
        "top_k_relationships": request.top_k_relationships,
        "max_context_tokens": request.max_context_tokens,
        "evidence_only": request.evidence_only,
        "release": request.release_id,
        "requested_index": request.index_version,
        "filters": request.filters.model_dump(),
    }, option=orjson.OPT_SORT_KEYS)
    return hashlib.sha256(canonical).hexdigest()


def create_app(overrides: Settings | None = None) -> FastAPI:
    settings = overrides or Settings.from_env()
    settings.validate_service_auth()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = settings
        app.state.engine = create_engine(settings)
        app.state.approved_retrieval_terms = approved_retrieval_terms(app.state.engine)
        app.state.cache = create_cache(settings)
        app.state.gate = asyncio.Semaphore(settings.max_concurrency)
        app.state.metrics = Metrics()
        logger.info("retrieval service ready engine=%s index=%s", app.state.engine.name, app.state.engine.version)
        yield

    app = FastAPI(
        title="华美售前智能体 GraphRAG 检索服务",
        version=__version__,
        lifespan=lifespan,
    )

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        request_id = str(request.headers.get("x-request-id") or f"gr_{uuid.uuid4()}")[:160]
        request.state.request_id = request_id
        started = time.perf_counter()
        response = await call_next(request)
        response.headers["X-Request-Id"] = request_id
        response.headers["X-Response-Time-Ms"] = f"{(time.perf_counter() - started) * 1000:.3f}"
        response.headers["Cache-Control"] = "no-store"
        return response

    def authorize(key: str | None) -> None:
        if settings.service_key and (not key or not hmac.compare_digest(str(key), settings.service_key)):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail={"code": "UNAUTHORIZED"})

    def authorize_metrics(request: Request, metrics_key: str | None) -> None:
        bearer = str(request.headers.get("authorization") or "")
        supplied = bearer[7:].strip() if bearer.lower().startswith("bearer ") else str(metrics_key or "").strip()
        expected = settings.metrics_token or settings.service_key
        if expected and (not supplied or not hmac.compare_digest(supplied, expected)):
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail={"code": "METRICS_UNAUTHORIZED"})

    @app.get("/health")
    async def health(request: Request):
        engine = request.app.state.engine
        return {
            "status": "ok",
            "service": settings.service_name,
            "version": __version__,
            "engine": engine.name,
            "index_version": engine.version,
            "document_count": getattr(engine, "document_count", None),
        }

    @app.get("/ready")
    async def ready(request: Request):
        engine = request.app.state.engine
        manifest = getattr(engine, "manifest", None)
        manifest_payload = getattr(manifest, "payload", {}) if manifest is not None else {}
        return {
            "ready": engine is not None,
            "engine": getattr(engine, "name", None),
            "index_version": getattr(engine, "version", None),
            "tenant_id": getattr(manifest, "tenant_id", None),
            "release_id": getattr(manifest, "release_id", None),
            "manifest_sha256": manifest_payload.get("manifest_sha256"),
        }

    @app.get("/metrics")
    async def metrics(request: Request, x_metrics_token: str | None = Header(default=None)):
        authorize_metrics(request, x_metrics_token)
        return Response(
            content=request.app.state.metrics.prometheus(request.app.state.engine),
            media_type="text/plain; version=0.0.4; charset=utf-8",
        )

    @app.post("/v1/retrieve", response_model=RetrievalResponse)
    async def retrieve(payload: RetrievalRequest, request: Request, x_service_key: str | None = Header(default=None)):
        authorize(x_service_key)
        if payload.top_k > settings.max_top_k:
            raise HTTPException(status_code=422, detail={"code": "TOP_K_TOO_LARGE", "maximum": settings.max_top_k})
        metrics: Metrics = request.app.state.metrics
        metrics.requests += 1
        started = time.perf_counter()
        acquired = False
        try:
            await asyncio.wait_for(request.app.state.gate.acquire(), timeout=settings.queue_timeout_seconds)
            acquired = True
        except TimeoutError as error:
            metrics.overloaded += 1
            raise HTTPException(status_code=429, detail={"code": "RETRIEVAL_OVERLOADED", "retry_after_ms": 250}) from error
        queue_ms = (time.perf_counter() - started) * 1000
        metrics.active += 1
        metrics.peak_active = max(metrics.peak_active, metrics.active)
        search_ms = 0.0
        try:
            # Fail before cache lookup or any official GraphRAG/model call. Raw
            # customer utterances are not a valid retrieval-service contract.
            payload.query = validate_retrieval_query_privacy(
                payload.query,
                request.app.state.approved_retrieval_terms,
            )
            query_sha256 = hashlib.sha256(payload.query.encode("utf-8")).hexdigest()
            metrics.observe_query_hash(query_sha256)
            engine = request.app.state.engine
            engine.validate_request(payload)

            async def execute() -> RetrievalResult:
                nonlocal search_ms
                search_started = time.perf_counter()
                try:
                    return await asyncio.wait_for(run_engine_search(engine, payload), timeout=settings.request_timeout_seconds)
                finally:
                    search_ms = (time.perf_counter() - search_started) * 1000

            # A readiness probe must execute the real query path. Its cache
            # bypass is carried as structured metadata and never contaminates
            # the text sent to the query model.
            try:
                if payload.readiness_probe:
                    result, hit = await execute(), False
                else:
                    result, hit = await request.app.state.cache.get_or_create(cache_key(payload, engine.version), execute)
            except Exception as error:
                metrics.observe_query_model(getattr(error, "query_model_usage", {}), successful=False)
                raise
            elapsed = (time.perf_counter() - started) * 1000
            metrics.success += 1
            metrics.cache_hits += int(hit)
            metrics.cache_misses += int(not hit)
            if not hit:
                metrics.observe_query_model(result.query_model_usage, successful=True)
            metrics.total_ms += elapsed
            return RetrievalResponse(
                request_id=request.state.request_id,
                tenant_id=payload.tenant_id,
                index_version=result.index_version,
                engine=result.engine,
                retrieval_mode=result.mode,
                evidence=result.evidence,
                answer_draft=result.answer_draft,
                graph_entities=result.graph_entities,
                context_tokens=result.query_model_usage.get("context_tokens"),
                query_model_attempts=int(result.query_model_usage.get("attempts") or 0),
                query_model_accounting=(
                    str(result.query_model_usage.get("accounting"))
                    if result.query_model_usage.get("accounting")
                    else None
                ),
                cache_hit=hit,
                queue_ms=round(queue_ms, 3),
                search_ms=round(search_ms, 3),
                timing_ms=round(elapsed, 3),
                query_sha256=query_sha256,
            )
        except TimeoutError as error:
            metrics.errors += 1
            raise HTTPException(status_code=504, detail={"code": "RETRIEVAL_TIMEOUT"}) from error
        except RequestBindingError as error:
            metrics.errors += 1
            raise HTTPException(status_code=409, detail={"code": error.code}) from error
        except ValueError as error:
            metrics.errors += 1
            raise HTTPException(status_code=422, detail={"code": str(error)}) from error
        except HTTPException:
            metrics.errors += 1
            raise
        except Exception:
            metrics.errors += 1
            logger.exception("retrieval failed request_id=%s", request.state.request_id)
            raise HTTPException(status_code=503, detail={"code": "RETRIEVAL_UNAVAILABLE"})
        finally:
            metrics.active -= 1
            if acquired:
                request.app.state.gate.release()

    return app


app = create_app()
