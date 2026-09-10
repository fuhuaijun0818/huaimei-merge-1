from __future__ import annotations

import asyncio
import hashlib
import time
import uuid
from contextlib import asynccontextmanager

from fastapi import FastAPI, Header, HTTPException, Request, status

from . import __version__
from .contracts import OrchestrateRequest, TurnDecision
from .graph import TURN_GRAPH, orchestrate_turn
from .service_auth import ServiceTokenError, verify_service_token
from .settings import Settings


def _authorization_hash(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def _bearer(value: str | None) -> str:
    candidate = str(value or "").strip()
    if not candidate.lower().startswith("bearer "):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail={"code": "SERVICE_TOKEN_REQUIRED"})
    return candidate[7:].strip()


def create_app(overrides: Settings | None = None) -> FastAPI:
    settings = overrides or Settings.from_env()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = settings
        app.state.gate = asyncio.Semaphore(settings.max_concurrency)
        app.state.graph = TURN_GRAPH
        app.state.checkpoint_backend = "disabled_p0"
        yield

    app = FastAPI(
        title="华美售前智能体 LangGraph 编排服务",
        version=__version__,
        lifespan=lifespan,
    )

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        request_id = str(request.headers.get("x-request-id") or f"lg_{uuid.uuid4()}")[:160]
        request.state.request_id = request_id
        started = time.perf_counter()
        response = await call_next(request)
        response.headers["X-Request-Id"] = request_id
        response.headers["X-Response-Time-Ms"] = f"{(time.perf_counter() - started) * 1000:.3f}"
        response.headers["Cache-Control"] = "no-store"
        return response

    @app.get("/health")
    async def health():
        return {
            "status": "ok",
            "service": settings.service_name,
            "version": __version__,
            "engine": "langgraph",
            "mode": "p0_read_only_prototype",
            "checkpoint_backend": getattr(app.state, "checkpoint_backend", "not_initialized"),
        }

    @app.post("/internal/v1/orchestrate", response_model=TurnDecision)
    async def orchestrate(
        payload: OrchestrateRequest,
        request: Request,
        authorization: str | None = Header(default=None),
    ) -> TurnDecision:
        token = _bearer(authorization)
        try:
            verify_service_token(
                token,
                settings.service_auth_secret,
                audience=settings.audience,
                tenant_id=payload.turn.tenant_id,
                authorization_context_hash=_authorization_hash(payload.authorization_context),
            )
        except ServiceTokenError as error:
            raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail={"code": str(error)}) from error
        try:
            await asyncio.wait_for(request.app.state.gate.acquire(), timeout=0.25)
        except TimeoutError as error:
            raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail={"code": "ORCHESTRATOR_OVERLOADED"}) from error
        try:
            if len(payload.input.redacted_message) > settings.max_message_chars:
                raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail={"code": "MESSAGE_LIMIT_EXCEEDED"})
            return await orchestrate_turn(payload, request.app.state.graph)
        finally:
            request.app.state.gate.release()

    return app


app = create_app()
