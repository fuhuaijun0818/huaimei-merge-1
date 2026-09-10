from __future__ import annotations

import os
import re
from dataclasses import dataclass


def _bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        return min(max(int(os.getenv(name, str(default))), minimum), maximum)
    except ValueError:
        return default


def _enabled(name: str, default: bool = False) -> bool:
    value = os.getenv(name, "true" if default else "false").strip().lower()
    return value in {"1", "true", "yes", "on"}


def _weak_secret(value: str) -> bool:
    return (
        len(value) < 32
        or len(set(value)) < 8
        or bool(re.search(r"\s", value))
        or bool(re.search(r"(?:replace|placeholder|changeme|example|dummy|fake|test[-_ ]?(?:key|secret))", value, re.I))
    )


@dataclass(frozen=True, slots=True)
class Settings:
    service_name: str
    environment: str
    service_auth_secret: str
    audience: str
    checkpoint_database_url: str
    durable_checkpoints_enabled: bool
    max_message_chars: int
    max_concurrency: int

    @property
    def production(self) -> bool:
        return self.environment in {"production", "prod"}

    def validate(self) -> None:
        if self.production and _weak_secret(self.service_auth_secret):
            raise RuntimeError("PRODUCTION_LANGGRAPH_SERVICE_AUTH_SECRET_REQUIRED")
        if not self.service_auth_secret:
            raise RuntimeError("LANGGRAPH_SERVICE_AUTH_SECRET_REQUIRED")
        # P0-A only validates the contract and intentionally has no admitted
        # durable checkpoint schema/role/retention workflow. Failing closed is
        # safer than allowing LangGraph to create its default tables in a
        # shared application schema. R1 removes these guards only together
        # with its independent migration and recovery evidence.
        if self.durable_checkpoints_enabled:
            raise RuntimeError("LANGGRAPH_DURABLE_CHECKPOINTS_NOT_ADMITTED")
        if self.production:
            raise RuntimeError("LANGGRAPH_PRODUCTION_RUNTIME_NOT_ADMITTED")

    @classmethod
    def from_env(cls) -> "Settings":
        value = cls(
            service_name=os.getenv("HUAMEI_LANGGRAPH_SERVICE_NAME", "huamei-agent-orchestrator").strip(),
            environment=os.getenv("HUAMEI_LANGGRAPH_RUNTIME_ENV", os.getenv("NODE_ENV", "development")).strip().lower(),
            service_auth_secret=os.getenv("HUAMEI_LANGGRAPH_SERVICE_AUTH_SECRET", "").strip(),
            audience=os.getenv("HUAMEI_LANGGRAPH_AUDIENCE", "huamei-agent-orchestrator").strip(),
            checkpoint_database_url=os.getenv("HUAMEI_LANGGRAPH_CHECKPOINT_DATABASE_URL", "").strip(),
            durable_checkpoints_enabled=_enabled("HUAMEI_LANGGRAPH_ENABLE_DURABLE_CHECKPOINTS"),
            max_message_chars=_bounded_int("HUAMEI_LANGGRAPH_MAX_MESSAGE_CHARS", 2000, 64, 8000),
            max_concurrency=_bounded_int("HUAMEI_LANGGRAPH_MAX_CONCURRENCY", 20, 1, 200),
        )
        value.validate()
        return value
