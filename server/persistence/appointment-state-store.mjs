import { createHash } from "node:crypto";
import { createJsonStateStore } from "../platform/json-state-store.mjs";
import { createFieldEncryption, createFieldRecordId } from "../platform/field-encryption.mjs";
import { normalizeTenantId } from "../platform/tenant-context.mjs";
import { postgres, postgresPersistenceEnabled, ensureTenant, appendAuditEvent } from "./postgres-helpers.mjs";

const initial = () => ({ registrations:[], receipts:[], events:[], followups:[], notices:[] });
const clone = (v) => structuredClone(v);
let local;
const localStore = () => local ||= createJsonStateStore({ envName:"HUAMEI_APPOINTMENT_REGISTRATION_FILE", defaultFile:".local-data/appointment-registrations.json", initialState:{ scopes:{} } });
const scopeKey = ({ channel = "web", conversation_id }) => createHash("sha256").update(JSON.stringify([channel, conversation_id])).digest("hex");
const context = (tenantId, key) => ({ tenantId, scope:"appointment.registration", recordId:createFieldRecordId("appointment.session", { key }) });
const production = () => ["production", "prod"].includes(String(process.env.HUAMEI_RUNTIME_ENV || process.env.HUAMEI_DEPLOYMENT_ENV || process.env.NODE_ENV || "").toLowerCase());
const missingPersistence = () => Object.assign(new Error("预约登记需要数据库持久化，暂时无法保存。"), { status:503, code:"APPOINTMENT_PERSISTENCE_REQUIRED" });

export async function appointmentStateTransaction(scope, operation) {
  const tenant = normalizeTenantId(scope.tenant_id);
  if (!postgresPersistenceEnabled()) {
    if (production()) throw missingPersistence();
    const store = localStore();
    const state = store.load();
    const key = scope.conversation_id ? `${tenant}:${scopeKey(scope)}` : Object.keys(state.scopes).find((key) => key.startsWith(`${tenant}:`) && state.scopes[key].registrations.some((r) => r.id === scope.appointment_intake_id));
    if (!key) return null;
    const current = state.scopes[key] || initial();
    const before = JSON.stringify(current);
    const result = operation(current);
    if (result && typeof result.then === "function") throw new TypeError("Appointment state operations must be synchronous");
    if (JSON.stringify(current) !== before) { state.scopes[key] = current; store.save(state); }
    return clone(result);
  }
  return postgres().tenantTransaction(tenant, async (client) => {
    await ensureTenant(client, tenant);
    let key = scope.conversation_id ? scopeKey(scope) : null;
    if (!key) {
      const row = await client.query("SELECT scope_key FROM appointment_sessions WHERE tenant_id=$1 AND appointment_ids @> ARRAY[$2]::text[]", [tenant, scope.appointment_intake_id]);
      key = row.rows[0]?.scope_key;
      if (!key) return null;
    }
    const encryption = createFieldEncryption();
    await client.query("INSERT INTO appointment_sessions(tenant_id,scope_key,payload) VALUES($1,$2,$3::jsonb) ON CONFLICT DO NOTHING", [tenant, key, JSON.stringify(encryption.encryptJson(initial(), context(tenant, key)))]);
    const row = await client.query("SELECT payload FROM appointment_sessions WHERE tenant_id=$1 AND scope_key=$2 FOR UPDATE", [tenant, key]);
    const state = encryption.decryptJson(row.rows[0].payload, context(tenant, key));
    const before = JSON.stringify(state);
    const previousEvents = new Set(state.events.map((e) => e.id));
    const result = operation(state);
    if (result && typeof result.then === "function") throw new TypeError("Appointment state operations must be synchronous");
    if (JSON.stringify(state) !== before) {
      await client.query("UPDATE appointment_sessions SET payload=$3::jsonb,appointment_ids=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND scope_key=$2", [tenant, key,
        JSON.stringify(encryption.encryptJson(state, context(tenant, key))), state.registrations.map((r) => r.id)]);
      for (const event of state.events.filter((e) => !previousEvents.has(e.id))) await appendAuditEvent(client, {
        tenantId:tenant, eventId:event.id, action:event.type, resourceType:"appointment_registration", resourceId:event.appointment_id,
        actorId:event.actor || "customer", details:{ version:event.version }
      });
    }
    return result;
  });
}

export async function readAppointmentStates({ tenant_id, limit = 100 } = {}) {
  const tenant = normalizeTenantId(tenant_id);
  if (!postgresPersistenceEnabled()) {
    if (production()) throw missingPersistence();
    return Object.entries(localStore().load().scopes).filter(([key]) => key.startsWith(`${tenant}:`)).map(([, state]) => state);
  }
  return postgres().tenantTransaction(tenant, async (client) => {
    const rows = await client.query("SELECT scope_key,payload FROM appointment_sessions WHERE tenant_id=$1 ORDER BY updated_at DESC LIMIT $2", [tenant, Math.min(500, Math.max(1, Number(limit) || 100))]);
    const encryption = createFieldEncryption();
    return rows.rows.map((row) => encryption.decryptJson(row.payload, context(tenant, row.scope_key)));
  });
}

// Used only by the audited contact-vault service. Locking this row serializes
// disclosure with customer cancellation and assignment changes.
export async function lockAppointmentForContact(client, tenantId, appointmentId) {
  const rows = await client.query("SELECT scope_key,payload FROM appointment_sessions WHERE tenant_id=$1 AND appointment_ids @> ARRAY[$2]::text[] FOR UPDATE", [tenantId, appointmentId]);
  const row = rows.rows[0];
  if (!row) return null;
  const state = createFieldEncryption().decryptJson(row.payload, context(tenantId, row.scope_key));
  return state.registrations.find((item) => item.id === appointmentId) || null;
}

// Called inside the account-change transaction, sharing its commit/rollback.
// Contact disclosure locks these same rows, so ownership cannot change halfway
// through a disclosure decision.
export async function transferAccountAppointments(client, tenantId, from, to = null) {
  const rows=await client.query('SELECT scope_key,payload FROM appointment_sessions WHERE tenant_id=$1 ORDER BY scope_key FOR UPDATE',[tenantId]);
  const encryption=createFieldEncryption();
  let count=0;
  for(const row of rows.rows){
    const state=encryption.decryptJson(row.payload,context(tenantId,row.scope_key));
    const active=state.registrations.filter(r=>r.assignee===from&&r.status==='registered'&&r.followup_status!=='completed');
    count+=active.length;
    if(!to||!active.length)continue;
    for(const item of active){
      item.assignee=to;
      const task=state.followups.find(t=>t.appointment_id===item.id);if(task)task.assignee=to;
    }
    await client.query('UPDATE appointment_sessions SET payload=$3::jsonb,updated_at=clock_timestamp() WHERE tenant_id=$1 AND scope_key=$2',[tenantId,row.scope_key,JSON.stringify(encryption.encryptJson(state,context(tenantId,row.scope_key)))]);
  }
  return count;
}
