import { createFieldEncryption } from "../platform/field-encryption.mjs";
import { ensureTenant, jsonValue, postgres } from "./postgres-helpers.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));

export function createPostgresAgentRunStore(options = {}) {
  const database = options.postgres || postgres();
  const fieldEncryption = options.fieldEncryption || createFieldEncryption({ env:options.env || process.env });
  const responseContext = (tenantId, runId) => ({ tenantId, scope:"agent_run.response", recordId:runId });
  const auditContext = (tenantId, runId) => ({ tenantId, scope:"agent_run.audit", recordId:runId });

  const upsert = async ({ response, audit }) => database.tenantTransaction(audit.tenant_id, async (client) => {
    const tenantId = audit.tenant_id;
    await ensureTenant(client, tenantId);
    await client.query(
      `INSERT INTO agent_runs
        (tenant_id, run_id, request_id, agent_id, agent_version, status,
         channel, caller, decision, response, audit, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11::jsonb,$12)
       ON CONFLICT (tenant_id, run_id)
       DO UPDATE SET
         status=EXCLUDED.status,
         response=EXCLUDED.response,
         audit=EXCLUDED.audit`,
      [tenantId, audit.run_id, audit.request_id, audit.agent_id, audit.agent_version,
        audit.status, audit.channel || "api", audit.caller || null, audit.decision || null,
        JSON.stringify(fieldEncryption.encryptJson(response, responseContext(tenantId, audit.run_id))),
        JSON.stringify(fieldEncryption.encryptJson(audit, auditContext(tenantId, audit.run_id))),
        audit.created_at]
    );
    await client.query(
      `INSERT INTO audit_events
        (tenant_id, event_id, actor_type, actor_id, action, resource_type,
         resource_id, request_id, outcome, details, occurred_at)
       VALUES ($1,$2,'service',$3,'agent.run.completed','agent_run',$4,$5,'success',$6::jsonb,$7)
       ON CONFLICT (tenant_id, event_id) DO NOTHING`,
      [tenantId, `agent_run:${audit.run_id}`, audit.agent_id, audit.run_id,
        audit.request_id, JSON.stringify({ status:audit.status, decision:audit.decision, caller:audit.caller }), audit.created_at]
    );
    return { response:clone(response), audit:clone(audit) };
  });

  const get = async (runId, tenantId) => {
    if (!tenantId) {
      const error = new Error("tenantId is required when reading an agent run");
      error.code = "POSTGRES_TENANT_CONTEXT_REQUIRED";
      throw error;
    }
    const values = [runId];
    const tenantClause = tenantId ? `AND tenant_id=$${values.push(tenantId)}` : "";
    const result = await database.tenantQuery(tenantId,
      `SELECT response, audit FROM agent_runs WHERE run_id=$1 ${tenantClause}
       ORDER BY created_at DESC LIMIT 1`,
      values
    );
    if (!result.rows[0]) return null;
    return {
      response:clone(fieldEncryption.decryptJson(
        jsonValue(result.rows[0].response, {}),
        responseContext(tenantId, runId)
      )),
      audit:clone(fieldEncryption.decryptJson(
        jsonValue(result.rows[0].audit, {}),
        auditContext(tenantId, runId)
      ))
    };
  };

  const list = async ({ tenantId, agentId = "", limit = 50 } = {}) => {
    if (!tenantId) {
      const error = new Error("tenantId is required when listing agent runs");
      error.code = "POSTGRES_TENANT_CONTEXT_REQUIRED";
      throw error;
    }
    const clauses = [];
    const values = [];
    if (tenantId) clauses.push(`tenant_id=$${values.push(tenantId)}`);
    if (agentId) clauses.push(`agent_id=$${values.push(agentId)}`);
    values.push(Math.min(Math.max(Number(limit) || 50, 1), 100));
    const result = await database.tenantQuery(tenantId,
      `SELECT run_id, audit FROM agent_runs
       ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
       ORDER BY created_at DESC LIMIT $${values.length}`,
      values
    );
    return result.rows.map((row) => clone(fieldEncryption.decryptJson(
      jsonValue(row.audit, {}),
      auditContext(tenantId, row.run_id)
    )));
  };

  return { upsert, get, list };
}

let defaultStore;
export const getPostgresAgentRunStore = () => {
  if (!defaultStore) defaultStore = createPostgresAgentRunStore();
  return defaultStore;
};
