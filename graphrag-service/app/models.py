from __future__ import annotations

from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator


class RetrievalFilters(BaseModel):
    model_config = ConfigDict(extra="forbid")
    record_types: list[str] = Field(default_factory=list, max_length=8)
    path_prefixes: list[str] = Field(default_factory=list, max_length=8)


class RetrievalRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tenant_id: str = Field(default="huamei-shanghai", min_length=2, max_length=64, pattern=r"^[A-Za-z0-9._-]+$")
    query: str = Field(min_length=1, max_length=1200)
    mode: Literal["local", "global"] = "local"
    top_k: int = Field(default=6, ge=1, le=20)
    top_k_entities: int | None = Field(default=None, ge=1, le=30)
    top_k_relationships: int | None = Field(default=None, ge=1, le=30)
    max_context_tokens: int | None = Field(default=None, ge=1000, le=32000)
    evidence_only: bool = False
    release_id: str | None = Field(default=None, max_length=128)
    index_version: str | None = Field(default=None, max_length=160)
    readiness_probe: bool = False
    filters: RetrievalFilters = Field(default_factory=RetrievalFilters)

    @field_validator("query")
    @classmethod
    def normalize_query(cls, value: str) -> str:
        return " ".join(value.strip().split())


class Evidence(BaseModel):
    record_id: str
    record_type: str
    title: str
    content: str
    source_relative_path: str
    sensitivity: str = "internal"
    verification_note: str = ""
    score: float
    graph_paths: list[str] = Field(default_factory=list)
    metadata: dict[str, Any] = Field(default_factory=dict)


class RetrievalResult(BaseModel):
    engine: str
    index_version: str
    mode: str
    evidence: list[Evidence]
    answer_draft: str | None = None
    graph_entities: list[str] = Field(default_factory=list)
    query_model_usage: dict[str, Any] = Field(default_factory=dict)


class RetrievalResponse(BaseModel):
    request_id: str
    tenant_id: str
    index_version: str
    engine: str
    retrieval_mode: str
    evidence: list[Evidence]
    answer_draft: str | None = None
    graph_entities: list[str] = Field(default_factory=list)
    context_tokens: int | None = None
    cache_hit: bool
    timing_ms: float
    query_sha256: str = Field(pattern=r"^[a-f0-9]{64}$")
