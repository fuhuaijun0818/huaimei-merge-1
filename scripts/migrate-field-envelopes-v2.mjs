import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { createPostgresClient } from "../server/platform/postgres.mjs";
import {
  createFieldEncryption,
  createFieldRecordId,
  getFieldEncryptionEnvelopeMetadata
} from "../server/platform/field-encryption.mjs";

export const LEGACY_FIELD_ENVELOPE_MARKER = "huamei.field.a256gcm.v1";
const MIGRATION_LOCK_ID = 2_026_082_602;
const WRITE_STOP_CONFIRMATION = "--confirm-write-stop";

const jsonContext = (tenantId, scope, recordId, legacyRecordId = recordId) => ({
  tenantId,
  scope,
  recordId,
  legacyRecordId
});

const sessionRecordId = (row) => createFieldRecordId("conversation.session", {
  channel:row.channel,
  session_id:row.session_id
});
const messageRecordId = (row) => createFieldRecordId("conversation.message", {
  channel:row.channel,
  message_id:row.message_id,
  session_id:row.session_id
});
const consentSubjectReference = (row) => String(row.normalized_mobile_hmac || row.lead_id || "").trim();
const recordedAtIso = (row) => new Date(row.recorded_at).toISOString();

const jsonField = ({ name, table, selectSql, updateSql, context }) => ({
  name,
  table,
  kind:"json",
  selectSql,
  updateSql,
  context,
  value:(row) => row.encrypted_value,
  updateValue:(value) => JSON.stringify(value)
});

const textField = ({ name, table, selectSql, updateSql, context }) => ({
  name,
  table,
  kind:"text",
  selectSql,
  updateSql,
  context,
  value:(row) => row.encrypted_value,
  updateValue:(value) => value
});

/**
 * Every application field protected by field-encryption v1/v2. Context builders
 * intentionally mirror the persistence adapters. The old delimiter identity is
 * retained only long enough to authenticate a v1 envelope and is never logged.
 */
export const FIELD_ENVELOPE_V2_SPECS = Object.freeze([
  jsonField({
    name:"conversation_sessions.state",
    table:"conversation_sessions",
    selectSql:`SELECT id,tenant_id,channel,session_id,state AS encrypted_value
      FROM conversation_sessions ORDER BY tenant_id,id`,
    updateSql:"UPDATE conversation_sessions SET state=$3::jsonb WHERE tenant_id=$1 AND id=$2",
    context:(row) => jsonContext(
      row.tenant_id,
      "conversation.session.state",
      sessionRecordId(row),
      `${row.channel}:${row.session_id}`
    )
  }),
  textField({
    name:"conversation_messages.content",
    table:"conversation_messages",
    selectSql:`SELECT m.id,m.tenant_id,m.message_id,m.content AS encrypted_value,
        s.channel,s.session_id
      FROM conversation_messages m
      JOIN conversation_sessions s ON s.tenant_id=m.tenant_id AND s.id=m.session_record_id
      ORDER BY m.tenant_id,m.id`,
    updateSql:"UPDATE conversation_messages SET content=$3 WHERE tenant_id=$1 AND id=$2",
    context:(row) => jsonContext(
      row.tenant_id,
      "conversation.message.content",
      messageRecordId(row),
      `${row.channel}:${row.session_id}:${row.message_id}`
    )
  }),
  jsonField({
    name:"conversation_messages.metadata.session_snapshot",
    table:"conversation_messages",
    selectSql:`SELECT m.id,m.tenant_id,m.message_id,
        m.metadata->'session_snapshot' AS encrypted_value,s.channel,s.session_id
      FROM conversation_messages m
      JOIN conversation_sessions s ON s.tenant_id=m.tenant_id AND s.id=m.session_record_id
      WHERE m.metadata ? 'session_snapshot'
      ORDER BY m.tenant_id,m.id`,
    updateSql:`UPDATE conversation_messages
      SET metadata=jsonb_set(metadata,'{session_snapshot}',$3::jsonb,false)
      WHERE tenant_id=$1 AND id=$2`,
    context:(row) => jsonContext(
      row.tenant_id,
      "conversation.message.session_snapshot",
      messageRecordId(row),
      `${row.channel}:${row.session_id}:${row.message_id}`
    )
  }),
  jsonField({
    name:"leads.profile",
    table:"leads",
    selectSql:`SELECT id,tenant_id,lead_id,normalized_mobile_hmac,profile AS encrypted_value
      FROM leads ORDER BY tenant_id,id`,
    updateSql:"UPDATE leads SET profile=$3::jsonb WHERE tenant_id=$1 AND id=$2",
    context:(row) => {
      const identity = consentSubjectReference(row);
      return jsonContext(row.tenant_id, "lead.profile", identity, identity);
    }
  }),
  jsonField({
    name:"lead_candidates.profile",
    table:"lead_candidates",
    selectSql:`SELECT id,tenant_id,candidate_id,profile AS encrypted_value
      FROM lead_candidates ORDER BY tenant_id,id`,
    updateSql:"UPDATE lead_candidates SET profile=$3::jsonb WHERE tenant_id=$1 AND id=$2",
    context:(row) => jsonContext(
      row.tenant_id,
      "lead.candidate.profile",
      row.candidate_id,
      row.candidate_id
    )
  }),
  jsonField({
    name:"consents.evidence",
    table:"consents",
    selectSql:`SELECT c.id,c.tenant_id,c.consent_type,c.evidence_hash,
        c.evidence AS encrypted_value,l.lead_id,l.normalized_mobile_hmac
      FROM consents c
      JOIN leads l ON l.tenant_id=c.tenant_id AND l.id=c.lead_record_id
      ORDER BY c.tenant_id,c.id`,
    updateSql:"UPDATE consents SET evidence=$3::jsonb WHERE tenant_id=$1 AND id=$2",
    context:(row) => {
      const subjectReferenceHmac = consentSubjectReference(row);
      const evidenceHash = String(row.evidence_hash || "").trim();
      return jsonContext(
        row.tenant_id,
        "lead.consent.evidence",
        createFieldRecordId("lead.consent", {
          consent_type:row.consent_type,
          evidence_hash:evidenceHash,
          subject_reference_hmac:subjectReferenceHmac
        }),
        `${subjectReferenceHmac}:${row.consent_type}:${evidenceHash}`
      );
    }
  }),
  jsonField({
    name:"handovers.snapshot",
    table:"handovers",
    selectSql:`SELECT id,tenant_id,handover_id,snapshot AS encrypted_value
      FROM handovers ORDER BY tenant_id,id`,
    updateSql:"UPDATE handovers SET snapshot=$3::jsonb WHERE tenant_id=$1 AND id=$2",
    context:(row) => jsonContext(
      row.tenant_id,
      "handover.snapshot",
      createFieldRecordId("handover", { handover_id:row.handover_id }),
      row.handover_id
    )
  }),
  textField({
    name:"human_work.notes",
    table:"human_work",
    selectSql:`SELECT w.id,w.tenant_id,w.staff_id,w.recorded_at,w.notes AS encrypted_value,
        s.external_conversation_id
      FROM human_work w
      JOIN conversation_sessions s ON s.tenant_id=w.tenant_id AND s.id=w.session_record_id
      WHERE w.notes IS NOT NULL
      ORDER BY w.tenant_id,w.id`,
    updateSql:"UPDATE human_work SET notes=$3 WHERE tenant_id=$1 AND id=$2",
    context:(row) => {
      const timestamp = recordedAtIso(row);
      const conversationId = String(row.external_conversation_id || "").trim();
      return jsonContext(
        row.tenant_id,
        "human_work.notes",
        createFieldRecordId("human_work", {
          conversation_id:conversationId,
          recorded_at:timestamp,
          staff_id:row.staff_id
        }),
        `${conversationId}:${row.staff_id}:${timestamp}`
      );
    }
  }),
  jsonField({
    name:"agent_runs.response",
    table:"agent_runs",
    selectSql:`SELECT id,tenant_id,run_id,response AS encrypted_value
      FROM agent_runs ORDER BY tenant_id,id`,
    updateSql:"UPDATE agent_runs SET response=$3::jsonb WHERE tenant_id=$1 AND id=$2",
    context:(row) => jsonContext(row.tenant_id, "agent_run.response", row.run_id, row.run_id)
  }),
  jsonField({
    name:"agent_runs.audit",
    table:"agent_runs",
    selectSql:`SELECT id,tenant_id,run_id,audit AS encrypted_value
      FROM agent_runs ORDER BY tenant_id,id`,
    updateSql:"UPDATE agent_runs SET audit=$3::jsonb WHERE tenant_id=$1 AND id=$2",
    context:(row) => jsonContext(row.tenant_id, "agent_run.audit", row.run_id, row.run_id)
  }),
  ...["identity_evidence", "scope", "result"].map((field) => jsonField({
    name:`data_subject_requests.${field}`,
    table:"data_subject_requests",
    selectSql:`SELECT id,tenant_id,request_id,${field} AS encrypted_value
      FROM data_subject_requests
      WHERE ${field} IS NOT NULL
      ORDER BY tenant_id,id`,
    updateSql:`UPDATE data_subject_requests SET ${field}=$3::jsonb WHERE tenant_id=$1 AND id=$2`,
    context:(row) => jsonContext(
      row.tenant_id,
      `privacy.request.${field}`,
      row.request_id,
      row.request_id
    )
  }))
]);

const legacyCountParts = [
  ["conversation_sessions.state", "conversation_sessions", "state->>'_encrypted'=$1"],
  ["conversation_messages.content", "conversation_messages", "position($1 in content)>0"],
  ["conversation_messages.metadata.session_snapshot", "conversation_messages", "metadata#>>'{session_snapshot,_encrypted}'=$1"],
  ["leads.profile", "leads", "profile->>'_encrypted'=$1"],
  ["lead_candidates.profile", "lead_candidates", "profile->>'_encrypted'=$1"],
  ["consents.evidence", "consents", "evidence->>'_encrypted'=$1"],
  ["handovers.snapshot", "handovers", "snapshot->>'_encrypted'=$1"],
  ["human_work.notes", "human_work", "position($1 in notes)>0"],
  ["agent_runs.response", "agent_runs", "response->>'_encrypted'=$1"],
  ["agent_runs.audit", "agent_runs", "audit->>'_encrypted'=$1"],
  ["data_subject_requests.identity_evidence", "data_subject_requests", "identity_evidence->>'_encrypted'=$1"],
  ["data_subject_requests.scope", "data_subject_requests", "scope->>'_encrypted'=$1"],
  ["data_subject_requests.result", "data_subject_requests", "result->>'_encrypted'=$1"]
];

export const LEGACY_FIELD_ENVELOPE_FIELDS = Object.freeze(legacyCountParts.map(([field]) => field));

export const legacyFieldEnvelopeInventorySql = `/* field_encryption_v2_cutover */\n${legacyCountParts
  .map(([field, table, predicate]) => `SELECT '${field}'::text AS field,count(*)::bigint AS legacy_v1_count FROM ${table} WHERE ${predicate}`)
  .join("\nUNION ALL\n")}`;

export function summarizeLegacyFieldEnvelopeInventory(rows = []) {
  const fields = {};
  const invalidFields = [];
  const duplicateFields = [];
  for (const row of rows) {
    const field = String(row.field || "");
    const count = Number(row.legacy_v1_count);
    if (!LEGACY_FIELD_ENVELOPE_FIELDS.includes(field)
        || !Number.isSafeInteger(count)
        || count < 0) {
      invalidFields.push(field || "unknown");
      continue;
    }
    if (Object.hasOwn(fields, field)) duplicateFields.push(field);
    else fields[field] = count;
  }
  const missingFields = LEGACY_FIELD_ENVELOPE_FIELDS.filter((field) => !Object.hasOwn(fields, field));
  const total = Object.values(fields).reduce((sum, value) => sum + value, 0);
  return {
    ok:total === 0 && !missingFields.length && !invalidFields.length && !duplicateFields.length,
    total_legacy_v1:total,
    fields,
    missing_fields:missingFields,
    invalid_fields:invalidFields,
    duplicate_fields:duplicateFields
  };
}

const safeFailure = (error, mode) => ({
  status:"blocked",
  mode,
  code:/^[A-Z0-9_.:-]{2,96}$/.test(String(error?.code || ""))
    ? String(error.code)
    : "FIELD_ENVELOPE_V2_MIGRATION_FAILED",
  ...(error?.migrationField ? { field:error.migrationField } : {})
});

const migrationError = (code, field = null) => {
  const error = new Error(code);
  error.code = code;
  if (field) error.migrationField = field;
  return error;
};

const verifyRole = async (client) => {
  const identity = await client.query("SELECT current_user,session_user");
  const row = identity.rows[0] || {};
  if (row.current_user !== "huamei_owner" || row.session_user !== "huamei_migrator") {
    throw migrationError("FIELD_ENVELOPE_V2_ROLE_SEPARATION_REQUIRED");
  }
  return { current_user:row.current_user, session_user:row.session_user };
};

const countsFor = () => ({
  scanned:0,
  legacy_v1:0,
  current_v2:0,
  other:0,
  migrated:0
});

export async function runFieldEnvelopeV2Migration({
  database,
  fieldEncryption,
  apply = false
}) {
  if (!database || !fieldEncryption?.enabled) {
    throw migrationError("FIELD_ENVELOPE_V2_CONFIGURATION_REQUIRED");
  }
  return database.transaction(async (client) => {
    await client.query(apply
      ? "SET TRANSACTION ISOLATION LEVEL SERIALIZABLE"
      : "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY");
    await client.query("SET LOCAL ROLE huamei_owner");
    await client.query("SET LOCAL statement_timeout=0");
    await client.query("SET LOCAL idle_in_transaction_session_timeout=0");
    const executionIdentity = await verifyRole(client);
    await client.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK_ID]);
    if (apply) {
      const tables = [...new Set(FIELD_ENVELOPE_V2_SPECS.map((spec) => spec.table))];
      await client.query(`LOCK TABLE ${tables.join(",")} IN SHARE ROW EXCLUSIVE MODE`);
    }

    const counts = {};
    for (const spec of FIELD_ENVELOPE_V2_SPECS) {
      const fieldCounts = countsFor();
      counts[spec.name] = fieldCounts;
      const rows = await client.query(spec.selectSql);
      fieldCounts.scanned = rows.rowCount;
      for (const row of rows.rows) {
        const value = spec.value(row);
        const metadata = getFieldEncryptionEnvelopeMetadata(value);
        if (!metadata) {
          fieldCounts.other += 1;
          throw migrationError("FIELD_ENVELOPE_PLAINTEXT_OR_UNKNOWN", spec.name);
        }
        let context;
        try { context = spec.context(row); }
        catch (error) {
          error.migrationField = spec.name;
          throw error;
        }
        if (metadata.current) {
          fieldCounts.current_v2 += 1;
          try {
            if (spec.kind === "json") fieldEncryption.decryptJson(value, context);
            else fieldEncryption.decryptText(value, context);
          } catch (error) {
            error.migrationField = spec.name;
            throw error;
          }
          continue;
        }
        if (metadata.version !== 1) {
          throw migrationError("FIELD_ENVELOPE_VERSION_UNSUPPORTED", spec.name);
        }
        fieldCounts.legacy_v1 += 1;
        let upgraded;
        try {
          upgraded = spec.kind === "json"
            ? fieldEncryption.rewrapJson(value, context)
            : fieldEncryption.rewrapText(value, context);
        } catch (error) {
          error.migrationField = spec.name;
          throw error;
        }
        if (!apply) continue;
        const updated = await client.query(spec.updateSql, [
          row.tenant_id,
          row.id,
          spec.updateValue(upgraded)
        ]);
        if (updated.rowCount !== 1) {
          throw migrationError("FIELD_ENVELOPE_ROW_CHANGED", spec.name);
        }
        fieldCounts.migrated += 1;
      }
    }

    const legacyRows = await client.query(legacyFieldEnvelopeInventorySql, [LEGACY_FIELD_ENVELOPE_MARKER]);
    const legacyInventory = summarizeLegacyFieldEnvelopeInventory(legacyRows.rows);
    if (apply && !legacyInventory.ok) {
      throw migrationError("FIELD_ENVELOPE_V2_MIGRATION_INCOMPLETE");
    }
    return {
      status:apply ? "applied" : "dry_run",
      mode:apply ? "apply" : "dry_run",
      execution_identity:executionIdentity,
      counts,
      legacy_inventory_after:legacyInventory
    };
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const apply = argv.includes("--apply");
  if (apply && !argv.includes(WRITE_STOP_CONFIRMATION)) {
    throw migrationError("FIELD_ENVELOPE_V2_WRITE_STOP_CONFIRMATION_REQUIRED");
  }
  const connectionString = String(env.HUAMEI_MIGRATION_DATABASE_URL || "").trim();
  if (!connectionString) throw migrationError("FIELD_ENVELOPE_V2_MIGRATION_DATABASE_URL_REQUIRED");
  const database = createPostgresClient({
    connectionString,
    applicationName:"huamei-field-envelope-v2-migration",
    statementTimeoutMs:2_147_483_647,
    idleInTransactionTimeoutMs:2_147_483_647
  });
  try {
    const fieldEncryption = createFieldEncryption({ env:{ ...env, HUAMEI_RUNTIME_ENV:"production" } });
    const report = await runFieldEnvelopeV2Migration({ database, fieldEncryption, apply });
    console.log(JSON.stringify(report, null, 2));
    return report;
  } finally {
    await database.close();
  }
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    const mode = process.argv.includes("--apply") ? "apply" : "dry_run";
    console.error(JSON.stringify(safeFailure(error, mode)));
    process.exitCode = 1;
  });
}
