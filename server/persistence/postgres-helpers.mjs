import { randomUUID } from "node:crypto";
import { getPostgresClient } from "../platform/postgres.mjs";
import { redactContactPii, redactContactPiiDeep } from "../platform/contact-pii-redaction.mjs";

export const postgresPersistenceEnabled = (env = process.env) => String(
  env.HUAMEI_PERSISTENCE_BACKEND || env.HUAMEI_PERSISTENCE_DRIVER || "local_json"
).trim().toLowerCase() === "postgres";

export const postgres = () => getPostgresClient();

const productionRuntime = () => ["prod", "production"].includes(String(
  process.env.HUAMEI_RUNTIME_ENV || process.env.HUAMEI_DEPLOYMENT_ENV || process.env.NODE_ENV || "development"
).trim().toLowerCase());

export async function setTenantContext(client, tenantId) {
  await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
}

export async function ensureTenant(client, tenantId) {
  if (productionRuntime()) {
    const existing = await client.query(
      "SELECT 1 FROM tenants WHERE tenant_id=$1 AND status='active'",
      [tenantId]
    );
    if (!existing.rowCount) {
      const error = new Error(`Tenant ${tenantId} is not provisioned or active`);
      error.code = "TENANT_NOT_PROVISIONED";
      throw error;
    }
    return;
  }
  await client.query(
    `INSERT INTO tenants (tenant_id, display_name)
     VALUES ($1, $2)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId, tenantId]
  );
}

export async function appendAuditEvent(client, {
  tenantId,
  eventId:requestedEventId = null,
  action,
  resourceType,
  resourceId = null,
  actorType = "service",
  actorId = "huamei-acquisition-agent",
  requestId = null,
  traceId = null,
  outcome = "success",
  details = {}
}) {
  const eventId = String(requestedEventId || `audit_${randomUUID()}`).slice(0, 160);
  const auditIdentifier = (value) => value === null || value === undefined
    ? value
    : redactContactPii(String(value), { replacement:"[mobile-redacted]" });
  const auditDetails = redactContactPiiDeep(details || {}, { replacement:"[mobile-redacted]" });
  await client.query(
    `INSERT INTO audit_events
      (tenant_id, event_id, actor_type, actor_id, action, resource_type,
       resource_id, request_id, trace_id, outcome, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb)
     ON CONFLICT (tenant_id, event_id) DO NOTHING`,
    [tenantId, eventId, actorType, auditIdentifier(actorId), action, resourceType,
      auditIdentifier(resourceId), auditIdentifier(requestId), traceId, outcome, JSON.stringify(auditDetails)]
  );
  return eventId;
}

export async function appendOutboxEvent(client, {
  tenantId,
  eventId:requestedEventId = null,
  aggregateType,
  aggregateId,
  eventType,
  payload = {},
  headers = {}
}) {
  const eventId = String(requestedEventId || `outbox_${randomUUID()}`).slice(0, 160);
  const safePayload = redactContactPiiDeep(payload || {}, {
    replacement:"[mobile-redacted]",
    preserveEncryptedEnvelopes:true
  });
  const safeHeaders = redactContactPiiDeep(headers || {}, {
    replacement:"[mobile-redacted]",
    preserveEncryptedEnvelopes:true
  });
  await client.query(
    `INSERT INTO outbox_events
      (tenant_id, event_id, aggregate_type, aggregate_id, event_type, payload, headers)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb)
     ON CONFLICT (tenant_id, event_id) DO NOTHING`,
    [tenantId, eventId, aggregateType, aggregateId, eventType,
      JSON.stringify(safePayload), JSON.stringify(safeHeaders)]
  );
  return eventId;
}

export async function ensureConversationSession(client, {
  tenantId,
  sessionId,
  channel = "web",
  externalConversationId = null,
  state = {},
  expiresAt = null
}) {
  await ensureTenant(client, tenantId);
  const result = await client.query(
    `INSERT INTO conversation_sessions
      (tenant_id, session_id, channel, external_conversation_id, state, expires_at)
     VALUES ($1,$2,$3,$4,$5::jsonb,$6)
     ON CONFLICT (tenant_id, channel, session_id)
     DO UPDATE SET
       external_conversation_id = COALESCE(conversation_sessions.external_conversation_id, EXCLUDED.external_conversation_id),
       last_activity_at = clock_timestamp(),
       expires_at = EXCLUDED.expires_at
     RETURNING id, tenant_id, session_id, channel, external_conversation_id,
       state, status, started_at, last_activity_at, expires_at`,
    [tenantId, sessionId, channel, externalConversationId, JSON.stringify(state || {}), expiresAt]
  );
  return result.rows[0];
}

export const jsonValue = (value, fallback) => {
  if (value === null || value === undefined) return fallback;
  if (typeof value === "string") {
    try { return JSON.parse(value); } catch { return fallback; }
  }
  return value;
};
