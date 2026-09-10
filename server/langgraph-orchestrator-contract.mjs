import { createHash, createHmac } from "node:crypto";
import { redactContactPii } from "./platform/contact-pii-redaction.mjs";

export const LANGGRAPH_CONTRACT_VERSION = "2026-09-04.1";
export const LANGGRAPH_AUDIENCE = "huamei-agent-orchestrator";
const TENANT_ID = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const OPAQUE_ID = /^[A-Za-z0-9._:-]{1,160}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ENGINES = new Set(["legacy", "shadow", "langgraph"]);
const DECISION_STATUS = new Set(["prepared", "interrupted", "policy_blocked", "retryable_error"]);
const POLICY_DECISIONS = new Set(["allow", "clarify", "handover", "block"]);

const base64url = (value) => Buffer.from(value).toString("base64url");
const json = (value) => JSON.stringify(value);
const hmac = (secret, value) => createHmac("sha256", secret).update(value).digest("base64url");
const opaque = (name, value, { pattern = OPAQUE_ID } = {}) => {
  const normalized = String(value || "").trim();
  if (!pattern.test(normalized)) {
    const error = new Error(`${name} is invalid`);
    error.code = "LANGGRAPH_CONTRACT_FIELD_INVALID";
    error.details = { field:name };
    throw error;
  }
  return normalized;
};

export const authorizationContextHash = (value) => createHash("sha256").update(String(value || "")).digest("hex");

export function deriveLangGraphThreadId({ tenantId, channel, conversationId, engineEpoch = "v1", secret }) {
  const key = String(secret || "").trim();
  if (key.length < 32) {
    const error = new Error("LangGraph thread secret is required");
    error.code = "LANGGRAPH_THREAD_SECRET_REQUIRED";
    throw error;
  }
  const source = [
    opaque("tenant_id", tenantId, { pattern:TENANT_ID }),
    opaque("channel", channel),
    opaque("conversation_id", conversationId),
    opaque("engine_epoch", engineEpoch)
  ].join("\u0000");
  return `lgth_${createHmac("sha256", key).update(source).digest("base64url").slice(0, 43)}`;
}

export function issueLangGraphServiceToken({
  secret,
  subject = "huamei-web-gateway",
  audience = LANGGRAPH_AUDIENCE,
  tenantId,
  authorizationContext,
  ttlSeconds = 60,
  now = Math.floor(Date.now() / 1000)
} = {}) {
  const key = String(secret || "").trim();
  if (key.length < 32) {
    const error = new Error("LangGraph service auth secret is required");
    error.code = "LANGGRAPH_SERVICE_AUTH_SECRET_REQUIRED";
    throw error;
  }
  const header = base64url(json({ alg:"HS256", typ:"HMAC-JWT" }));
  const payload = base64url(json({
    sub:opaque("subject", subject),
    aud:opaque("audience", audience),
    tenant_id:opaque("tenant_id", tenantId, { pattern:TENANT_ID }),
    authorization_context_hash:authorizationContextHash(authorizationContext),
    iat:now,
    exp:now + Math.max(1, Math.min(120, Number(ttlSeconds) || 60))
  }));
  const signingInput = `${header}.${payload}`;
  return `${signingInput}.${hmac(key, signingInput)}`;
}

const normalizeMessage = (value) => redactContactPii(String(value || ""))
  .replace(/\s+/g, " ").trim().slice(0, 2_000);

export function createLangGraphTurnRequest({
  tenantId,
  channel,
  conversationId,
  messageId,
  message,
  turnSequence,
  expectedStateVersion,
  fencingToken,
  enginePin = {},
  authorizationContext,
  traceId,
  threadSecret
} = {}) {
  const redactedMessage = normalizeMessage(message);
  if (!redactedMessage) {
    const error = new Error("A non-empty redacted message is required");
    error.code = "LANGGRAPH_REDACTED_MESSAGE_REQUIRED";
    throw error;
  }
  const normalizedTenantId = opaque("tenant_id", tenantId, { pattern:TENANT_ID });
  const normalizedChannel = opaque("channel", channel || "web");
  const normalizedConversationId = opaque("conversation_id", conversationId);
  const threadId = deriveLangGraphThreadId({
    tenantId:normalizedTenantId,
    channel:normalizedChannel,
    conversationId:normalizedConversationId,
    engineEpoch:enginePin.engine_epoch || enginePin.graph_version || "v1",
    secret:threadSecret
  });
  const payloadHash = createHash("sha256").update(redactedMessage).digest("hex");
  const normalizedAuthorizationContext = opaque("authorization_context", authorizationContext);
  if (normalizedAuthorizationContext.length < 16) {
    const error = new Error("authorization_context is too short");
    error.code = "LANGGRAPH_CONTRACT_FIELD_INVALID";
    error.details = { field:"authorization_context" };
    throw error;
  }
  const request = {
    contract_version:LANGGRAPH_CONTRACT_VERSION,
    turn:{
      tenant_id:normalizedTenantId,
      conversation_id:normalizedConversationId,
      thread_id:threadId,
      message_id:opaque("message_id", messageId),
      turn_seq:Math.max(1, Number(turnSequence) || 1),
      payload_hash:payloadHash,
      expected_state_version:Math.max(0, Number(expectedStateVersion) || 0),
      fencing_token:Math.max(1, Number(fencingToken) || 1),
      engine_pin:{
        engine:ENGINES.has(enginePin.engine) ? enginePin.engine : "langgraph",
        graph_version:opaque("graph_version", enginePin.graph_version || "v1"),
        state_schema_version:opaque("state_schema_version", enginePin.state_schema_version || "v1")
      }
    },
    input:{ redacted_message:redactedMessage, attachment_refs:[], language:"zh-CN" },
    authorization_context:normalizedAuthorizationContext,
    trace:{ trace_id:opaque("trace_id", traceId) }
  };
  return { request, threadId, authorizationContextHash:authorizationContextHash(authorizationContext) };
}

export function assertLangGraphTurnDecision(value, expected = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const error = new Error("LangGraph response must be an object");
    error.code = "LANGGRAPH_DECISION_INVALID";
    throw error;
  }
  if (!DECISION_STATUS.has(value.status)) {
    const error = new Error("LangGraph decision status is invalid");
    error.code = "LANGGRAPH_DECISION_STATUS_INVALID";
    throw error;
  }
  opaque("run_id", value.run_id);
  if (value.checkpoint_id !== null && value.checkpoint_id !== undefined) opaque("checkpoint_id", value.checkpoint_id);
  opaque("decision_hash", value.decision_hash, { pattern:SHA256 });
  if (!value.policy || !POLICY_DECISIONS.has(value.policy.decision)) {
    const error = new Error("LangGraph policy decision is invalid");
    error.code = "LANGGRAPH_POLICY_INVALID";
    throw error;
  }
  if (!value.conversation_update || value.conversation_update.state_schema_version !== expected.stateSchemaVersion) {
    const error = new Error("LangGraph state schema version is invalid");
    error.code = "LANGGRAPH_STATE_SCHEMA_MISMATCH";
    throw error;
  }
  if (!value.response || !Array.isArray(value.response.segments) || value.response.segments.some((item) => typeof item !== "string" || item.length > 360)) {
    const error = new Error("LangGraph response segments are invalid");
    error.code = "LANGGRAPH_RESPONSE_INVALID";
    throw error;
  }
  if (value.status === "interrupted" && value.pending_action_preview?.external_effect !== false) {
    const error = new Error("Interrupted decision must not execute an external effect");
    error.code = "LANGGRAPH_PENDING_ACTION_UNSAFE";
    throw error;
  }
  return value;
}
