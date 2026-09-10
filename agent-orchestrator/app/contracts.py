from __future__ import annotations

import re
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


OPAQUE_ID = r"^[A-Za-z0-9._:-]{1,160}$"
TENANT_ID = r"^[a-z0-9][a-z0-9_-]{2,63}$"
SHA256 = r"^[a-f0-9]{64}$"
MOBILE_PATTERN = re.compile(r"(?<!\d)(?:\+?86[- ]?)?1[3-9]\d[- ]?\d{4}[- ]?\d{4}(?!\d)")


class EnginePin(BaseModel):
    model_config = ConfigDict(extra="forbid")
    engine: Literal["legacy", "shadow", "langgraph"] = "langgraph"
    graph_version: str = Field(min_length=1, max_length=64, pattern=OPAQUE_ID)
    state_schema_version: str = Field(min_length=1, max_length=64, pattern=OPAQUE_ID)


class TurnContext(BaseModel):
    model_config = ConfigDict(extra="forbid")
    tenant_id: str = Field(pattern=TENANT_ID)
    conversation_id: str = Field(pattern=OPAQUE_ID)
    thread_id: str = Field(pattern=OPAQUE_ID)
    message_id: str = Field(pattern=OPAQUE_ID)
    turn_seq: int = Field(ge=1, le=2_147_483_647)
    payload_hash: str = Field(pattern=SHA256)
    expected_state_version: int = Field(ge=0, le=9_223_372_036_854_775_807)
    fencing_token: int = Field(ge=1, le=9_223_372_036_854_775_807)
    engine_pin: EnginePin


class TurnInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    redacted_message: str = Field(min_length=1, max_length=8000)
    attachment_refs: list[str] = Field(default_factory=list, max_length=4)
    language: Literal["zh-CN"] = "zh-CN"

    @field_validator("redacted_message")
    @classmethod
    def require_minimized_text(cls, value: str) -> str:
        normalized = " ".join(value.strip().split())
        if MOBILE_PATTERN.search(normalized):
            raise ValueError("RAW_PII_NOT_ALLOWED")
        return normalized

    @field_validator("attachment_refs")
    @classmethod
    def require_opaque_attachment_refs(cls, values: list[str]) -> list[str]:
        if any(not re.fullmatch(OPAQUE_ID, value) for value in values):
            raise ValueError("ATTACHMENT_REFERENCE_INVALID")
        return values


class TraceContext(BaseModel):
    model_config = ConfigDict(extra="forbid")
    trace_id: str = Field(pattern=OPAQUE_ID)


class OrchestrateRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    contract_version: Literal["2026-09-04.1"] = "2026-09-04.1"
    turn: TurnContext
    input: TurnInput
    authorization_context: str = Field(min_length=16, max_length=4096)
    trace: TraceContext

    @model_validator(mode="after")
    def bind_redacted_payload_hash(self) -> "OrchestrateRequest":
        import hashlib

        expected = hashlib.sha256(self.input.redacted_message.encode("utf-8")).hexdigest()
        if self.turn.payload_hash != expected:
            raise ValueError("PAYLOAD_HASH_MISMATCH")
        return self


class ConversationUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    safe_summary_ref: str | None = Field(default=None, max_length=160, pattern=OPAQUE_ID)
    slot_updates: list[dict[str, str]] = Field(default_factory=list, max_length=8)
    state_schema_version: str = Field(min_length=1, max_length=64, pattern=OPAQUE_ID)


class ResponseDraft(BaseModel):
    model_config = ConfigDict(extra="forbid")
    segments: list[str] = Field(default_factory=list, max_length=6)
    citations: list[dict[str, str]] = Field(default_factory=list, max_length=8)
    media_asset_ids: list[str] = Field(default_factory=list, max_length=4)
    suggested_next_step: str = Field(default="", max_length=240)

    @field_validator("segments")
    @classmethod
    def cap_segments(cls, values: list[str]) -> list[str]:
        normalized = [" ".join(item.strip().split())[:360] for item in values if item and item.strip()]
        if len(normalized) != len(values):
            raise ValueError("RESPONSE_SEGMENT_INVALID")
        return normalized


class EvidenceRef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    release_id: str | None = Field(default=None, max_length=160, pattern=OPAQUE_ID)
    snapshot_id: str | None = Field(default=None, max_length=160, pattern=OPAQUE_ID)


class PolicyResult(BaseModel):
    model_config = ConfigDict(extra="forbid")
    decision: Literal["allow", "clarify", "handover", "block"]
    reason_code: str = Field(default="", max_length=96, pattern=r"^[A-Z0-9_]*$")


class TurnDecision(BaseModel):
    model_config = ConfigDict(extra="forbid")
    status: Literal["prepared", "interrupted", "policy_blocked", "retryable_error"]
    run_id: str = Field(pattern=OPAQUE_ID)
    checkpoint_id: str | None = Field(default=None, max_length=160, pattern=OPAQUE_ID)
    decision_hash: str = Field(pattern=SHA256)
    conversation_update: ConversationUpdate
    response: ResponseDraft
    handover: dict[str, str] | None = None
    pending_action_preview: dict[str, Any] | None = None
    evidence: EvidenceRef = Field(default_factory=EvidenceRef)
    policy: PolicyResult
