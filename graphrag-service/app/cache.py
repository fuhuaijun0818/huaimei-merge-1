from __future__ import annotations

import asyncio
import time
import unicodedata
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from typing import Generic, TypeVar


T = TypeVar("T")

# Cache-key-only synonym normalization. The retrieval query itself is left
# untouched so evidence quality does not depend on this table. Keep this list
# aligned with server/graphrag-client.mjs::CACHE_QUERY_SYNONYMS.
_CACHE_QUERY_SYNONYMS = {
    "报价": "价格",
    "费用": "价格",
    "收费": "价格",
    "预算": "价格",
    "价钱": "价格",
    "价位": "价格",
    "多少钱": "价格",
}


def canonical_cache_query(query: str) -> str:
    """Return an order-insensitive cache key form for equivalent phrasings."""

    tokens = unicodedata.normalize("NFKC", str(query or "")).lower().split()
    return " ".join(sorted({_CACHE_QUERY_SYNONYMS.get(token, token) for token in tokens}))


class AsyncTtlCache(Generic[T]):
    """Per-worker TTL/LRU cache with in-flight request de-duplication."""

    def __init__(self, ttl_seconds: int, max_entries: int):
        self.ttl_seconds = ttl_seconds
        self.max_entries = max_entries
        self._values: OrderedDict[str, tuple[float, T]] = OrderedDict()
        self._inflight: dict[str, asyncio.Task[T]] = {}
        self._lock = asyncio.Lock()

    async def get_or_create(self, key: str, factory: Callable[[], Awaitable[T]]) -> tuple[T, bool]:
        now = time.monotonic()
        async with self._lock:
            cached = self._values.get(key)
            if cached and cached[0] > now:
                self._values.move_to_end(key)
                return cached[1], True
            if cached:
                self._values.pop(key, None)
            task = self._inflight.get(key)
            if task is None:
                task = asyncio.create_task(factory())
                self._inflight[key] = task
                owner = True
            else:
                owner = False
        try:
            value = await asyncio.shield(task)
        finally:
            if owner:
                async with self._lock:
                    self._inflight.pop(key, None)
        if owner:
            async with self._lock:
                self._values[key] = (time.monotonic() + self.ttl_seconds, value)
                self._values.move_to_end(key)
                while len(self._values) > self.max_entries:
                    self._values.popitem(last=False)
        return value, not owner

    async def clear(self) -> None:
        async with self._lock:
            self._values.clear()

    @property
    def size(self) -> int:
        return len(self._values)
