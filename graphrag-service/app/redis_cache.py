from __future__ import annotations

import asyncio
import os
from collections.abc import Awaitable, Callable
from typing import Any, TypeVar

from .cache import AsyncTtlCache
from .models import RetrievalResult


T = TypeVar("T")


class RedisTtlCache:
    """Shared evidence cache with a per-worker in-memory fallback.

    Redis failures are treated as cache misses, never as retrieval failures.
    The key is already release/index/tenant scoped by the caller, so a shared
    namespace is safe across replicas.
    """

    def __init__(
        self,
        client: Any,
        ttl_seconds: int,
        fallback: AsyncTtlCache[RetrievalResult],
    ):
        self._client = client
        self.ttl_seconds = ttl_seconds
        self._fallback = fallback
        self._inflight: dict[str, asyncio.Task[RetrievalResult]] = {}
        self.backend = "redis"

    @staticmethod
    def _key(key: str) -> str:
        return f"huamei:graphrag:evidence:v1:{key}"

    async def get_or_create(
        self,
        key: str,
        factory: Callable[[], Awaitable[RetrievalResult]],
    ) -> tuple[RetrievalResult, bool]:
        namespaced = self._key(key)
        try:
            cached = await self._client.get(namespaced)
            if cached:
                return RetrievalResult.model_validate_json(cached), True
        except Exception:
            # A cache outage must not turn a read-only retrieval into an error.
            return await self._fallback.get_or_create(key, factory)

        task = self._inflight.get(key)
        owner = task is None
        if task is None:
            task = asyncio.create_task(factory())
            self._inflight[key] = task
        try:
            value = await asyncio.shield(task)
        finally:
            if owner:
                self._inflight.pop(key, None)
        if owner:
            try:
                await self._client.set(
                    namespaced,
                    value.model_dump_json(),
                    ex=max(1, int(self.ttl_seconds)),
                )
            except Exception:
                pass
        return value, not owner

    async def clear(self) -> None:
        await self._fallback.clear()

    @property
    def size(self) -> int:
        # Redis is shared and may contain keys from other replicas; the local
        # fallback size is the only cheap, deterministic gauge per worker.
        return self._fallback.size


def create_cache(settings: Any) -> AsyncTtlCache[RetrievalResult] | RedisTtlCache:
    fallback = AsyncTtlCache[RetrievalResult](
        settings.cache_ttl_seconds,
        settings.cache_max_entries,
    )
    url = str(
        os.getenv("HUAMEI_GRAPHRAG_REDIS_URL")
        or os.getenv("HUAMEI_REDIS_URL")
        or ""
    ).strip()
    backend = str(
        os.getenv("HUAMEI_GRAPHRAG_CACHE_BACKEND")
        or ("redis" if url else "memory")
    ).strip().lower()
    if backend != "redis" or not url:
        return fallback
    try:
        from redis.asyncio import Redis

        client = Redis.from_url(
            url,
            decode_responses=False,
            socket_timeout=0.8,
            socket_connect_timeout=0.8,
            health_check_interval=30,
        )
        return RedisTtlCache(client, settings.cache_ttl_seconds, fallback)
    except Exception:
        return fallback
