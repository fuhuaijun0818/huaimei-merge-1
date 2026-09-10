import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

const runtimeUrl = String(process.env.HUAMEI_DATABASE_URL || "").trim();
const migrationUrl = String(process.env.HUAMEI_MIGRATION_DATABASE_URL || "").trim();
if (!runtimeUrl || !migrationUrl) {
  throw new Error("v1→v2字段加密迁移测试需要runtime与migrator PostgreSQL URL");
}

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const suffix = randomUUID().slice(0, 8);
const tenantId = `aad-migration-${suffix}`;
const channel = "web";
const sessionId = "case";
const externalConversationId = `conversation-${suffix}`;
const messageId = "turn:1";
const leadId = `lead-${suffix}`;
const candidateId = `candidate-${suffix}`;
const handoverId = `handover-${suffix}`;
const runId = `run-${suffix}`;
const requestId = `dsr_${suffix}_migration`;
const staffId = `staff-${suffix}`;
const subjectReference = createHash("sha256").update(`subject-${suffix}`).digest("hex");
const candidateSubject = createHash("sha256").update(`candidate-subject-${suffix}`).digest("hex");
const candidateSession = createHash("sha256").update(`candidate-session-${suffix}`).digest("hex");
const evidenceHash = createHash("sha256").update(`consent-evidence-${suffix}`).digest("hex");
const oldKeyBytes = randomBytes(32);
const newKeyBytes = randomBytes(32);
const oldKeyId = "legacy-aad-v1";
const newKeyId = "structured-aad-v2";
const completeKeyring = JSON.stringify({
  active_key_id:newKeyId,
  keys:{
    [oldKeyId]:oldKeyBytes.toString("base64"),
    [newKeyId]:newKeyBytes.toString("base64")
  }
});
const missingOldKeyring = JSON.stringify({
  active_key_id:newKeyId,
  keys:{ [newKeyId]:newKeyBytes.toString("base64") }
});

const secrets = Object.freeze({
  state:`V1_STATE_${suffix}`,
  content:`V1_CONTENT_${suffix}`,
  snapshot:`V1_SNAPSHOT_${suffix}`,
  lead:`V1_LEAD_${suffix}`,
  candidate:`V1_CANDIDATE_${suffix}`,
  consent:`V1_CONSENT_${suffix}`,
  handover:`V1_HANDOVER_${suffix}`,
  notes:`V1_NOTES_${suffix}`,
  response:`V1_RESPONSE_${suffix}`,
  audit:`V1_AUDIT_${suffix}`,
  identity:`V1_IDENTITY_${suffix}`,
  scope:`V1_SCOPE_${suffix}`,
  result:`V1_RESULT_${suffix}`
});

const {
  createFieldEncryption,
  createFieldRecordId,
  getFieldEncryptionEnvelopeMetadata
} = await import("../server/platform/field-encryption.mjs");
const { createPostgresClient } = await import("../server/platform/postgres.mjs");
const {
  LEGACY_FIELD_ENVELOPE_FIELDS,
  LEGACY_FIELD_ENVELOPE_MARKER,
  legacyFieldEnvelopeInventorySql,
  summarizeLegacyFieldEnvelopeInventory
} = await import("../scripts/migrate-field-envelopes-v2.mjs");

const migrator = createPostgresClient({
  connectionString:migrationUrl,
  applicationName:"huamei-field-envelope-v2-migration-it"
});
const runtime = createPostgresClient({
  connectionString:runtimeUrl,
  applicationName:"huamei-field-envelope-v2-runtime-it"
});
const encryption = createFieldEncryption({ keyringJson:completeKeyring, production:true });

const legacyEnvelope = (kind, value, context) => {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", oldKeyBytes, iv);
  cipher.setAAD(Buffer.from(JSON.stringify({
    schema:"huamei.field.aad.v1",
    algorithm:"A256GCM",
    key_id:oldKeyId,
    kind,
    tenant_id:context.tenantId,
    scope:context.scope,
    record_id:context.legacyRecordId || context.recordId
  }), "utf8"));
  const plaintext = kind === "json" ? JSON.stringify(value) : String(value);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, "utf8")), cipher.final()]);
  const envelope = {
    _encrypted:LEGACY_FIELD_ENVELOPE_MARKER,
    version:1,
    algorithm:"A256GCM",
    key_id:oldKeyId,
    kind,
    iv:iv.toString("base64url"),
    tag:cipher.getAuthTag().toString("base64url"),
    ciphertext:ciphertext.toString("base64url")
  };
  return kind === "json" ? envelope : JSON.stringify(envelope);
};

const stateContext = {
  tenantId,
  scope:"conversation.session.state",
  recordId:createFieldRecordId("conversation.session", { channel, session_id:sessionId }),
  legacyRecordId:`${channel}:${sessionId}`
};
const messageContext = {
  tenantId,
  scope:"conversation.message.content",
  recordId:createFieldRecordId("conversation.message", {
    channel,
    message_id:messageId,
    session_id:sessionId
  }),
  legacyRecordId:`${channel}:${sessionId}:${messageId}`
};
const snapshotContext = { ...messageContext, scope:"conversation.message.session_snapshot" };
const leadContext = { tenantId, scope:"lead.profile", recordId:subjectReference, legacyRecordId:subjectReference };
const candidateContext = { tenantId, scope:"lead.candidate.profile", recordId:candidateId, legacyRecordId:candidateId };
const consentContext = {
  tenantId,
  scope:"lead.consent.evidence",
  recordId:createFieldRecordId("lead.consent", {
    consent_type:"service",
    evidence_hash:evidenceHash,
    subject_reference_hmac:subjectReference
  }),
  legacyRecordId:`${subjectReference}:service:${evidenceHash}`
};
const handoverContext = {
  tenantId,
  scope:"handover.snapshot",
  recordId:createFieldRecordId("handover", { handover_id:handoverId }),
  legacyRecordId:handoverId
};
const recordedAt = new Date(Date.now() - 60_000).toISOString();
const notesContext = {
  tenantId,
  scope:"human_work.notes",
  recordId:createFieldRecordId("human_work", {
    conversation_id:externalConversationId,
    recorded_at:recordedAt,
    staff_id:staffId
  }),
  legacyRecordId:`${externalConversationId}:${staffId}:${recordedAt}`
};
const responseContext = { tenantId, scope:"agent_run.response", recordId:runId, legacyRecordId:runId };
const auditContext = { tenantId, scope:"agent_run.audit", recordId:runId, legacyRecordId:runId };
const privacyContext = (field) => ({
  tenantId,
  scope:`privacy.request.${field}`,
  recordId:requestId,
  legacyRecordId:requestId
});

const executeMigration = (args, keyring) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ["scripts/migrate-field-envelopes-v2.mjs", ...args], {
    cwd:projectRoot,
    env:{
      ...process.env,
      NODE_ENV:"production",
      HUAMEI_RUNTIME_ENV:"production",
      HUAMEI_MIGRATION_DATABASE_URL:migrationUrl,
      HUAMEI_FIELD_ENCRYPTION_KEYRING_JSON:keyring
    },
    stdio:["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-100_000); });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-100_000); });
  child.once("error", reject);
  child.once("exit", (code) => resolve({ code, stdout, stderr }));
});

const inventory = () => migrator.transaction(async (client) => {
  await client.query("SET LOCAL ROLE huamei_owner");
  const result = await client.query(legacyFieldEnvelopeInventorySql, [LEGACY_FIELD_ENVELOPE_MARKER]);
  return summarizeLegacyFieldEnvelopeInventory(result.rows);
});

const assertNoSecretInLogs = (execution) => {
  const output = `${execution.stdout}${execution.stderr}`;
  for (const secret of Object.values(secrets)) {
    assert.equal(output.includes(secret), false, "迁移日志不得复制任何受保护正文");
  }
};

const parseFailure = (execution) => JSON.parse(execution.stderr.trim().split(/\r?\n/).at(-1));

let sessionRecordId;
try {
  await migrator.transaction(async (client) => {
    await client.query("SET LOCAL ROLE huamei_owner");
    await client.query("INSERT INTO tenants (tenant_id,display_name) VALUES ($1,$1)", [tenantId]);
    const session = await client.query(
      `INSERT INTO conversation_sessions
        (tenant_id,session_id,channel,external_conversation_id,state)
       VALUES ($1,$2,$3,$4,$5::jsonb) RETURNING id`,
      [tenantId, sessionId, channel, externalConversationId,
        JSON.stringify(legacyEnvelope("json", { marker:secrets.state }, stateContext))]
    );
    sessionRecordId = session.rows[0].id;
    await client.query(
      `INSERT INTO conversation_messages
        (tenant_id,session_record_id,message_id,role,direction,content,metadata)
       VALUES ($1,$2,$3,'user','inbound',$4,$5::jsonb)`,
      [tenantId, sessionRecordId, messageId,
        legacyEnvelope("text", secrets.content, messageContext),
        JSON.stringify({ session_snapshot:legacyEnvelope("json", { marker:secrets.snapshot }, snapshotContext) })]
    );
    const lead = await client.query(
      `INSERT INTO leads
        (tenant_id,lead_id,normalized_mobile_hmac,masked_mobile,source_channel,profile)
       VALUES ($1,$2,$3,'138****0000','web',$4::jsonb) RETURNING id`,
      [tenantId, leadId, subjectReference,
        JSON.stringify(legacyEnvelope("json", { marker:secrets.lead }, leadContext))]
    );
    await client.query(
      `INSERT INTO lead_candidates
        (tenant_id,candidate_id,session_reference_hash,submitted_mobile_hmac,masked_mobile,profile)
       VALUES ($1,$2,$3,$4,'139****0000',$5::jsonb)`,
      [tenantId, candidateId, candidateSession, candidateSubject,
        JSON.stringify(legacyEnvelope("json", { marker:secrets.candidate }, candidateContext))]
    );
    await client.query(
      `INSERT INTO consents
        (tenant_id,lead_record_id,consent_type,granted,policy_version,evidence_hash,evidence)
       VALUES ($1,$2,'service',true,'migration-it-v1',$3,$4::jsonb)`,
      [tenantId, lead.rows[0].id, evidenceHash,
        JSON.stringify(legacyEnvelope("json", { marker:secrets.consent }, consentContext))]
    );
    const handover = await client.query(
      `INSERT INTO handovers
        (tenant_id,handover_id,session_record_id,reason,team,snapshot)
       VALUES ($1,$2,$3,'human_requested','advisor',$4::jsonb) RETURNING id`,
      [tenantId, handoverId, sessionRecordId,
        JSON.stringify(legacyEnvelope("json", { marker:secrets.handover }, handoverContext))]
    );
    await client.query(
      `INSERT INTO human_work
        (tenant_id,session_record_id,handover_record_id,staff_id,work_type,minutes,notes,recorded_at)
       VALUES ($1,$2,$3,$4,'presales_service',1,$5,$6)`,
      [tenantId, sessionRecordId, handover.rows[0].id, staffId,
        legacyEnvelope("text", secrets.notes, notesContext), recordedAt]
    );
    const createdAt = new Date().toISOString();
    await client.query(
      `INSERT INTO agent_runs
        (tenant_id,run_id,request_id,agent_id,status,response,audit,created_at)
       VALUES ($1,$2,$3,'migration-it','completed',$4::jsonb,$5::jsonb,$6)`,
      [tenantId, runId, `request-${suffix}`,
        JSON.stringify(legacyEnvelope("json", { marker:secrets.response }, responseContext)),
        JSON.stringify(legacyEnvelope("json", { marker:secrets.audit }, auditContext)), createdAt]
    );
    await client.query(
      `INSERT INTO data_subject_requests
        (tenant_id,request_id,request_type,subject_reference_hmac,status,
         identity_evidence,scope,result,due_at,created_by)
       VALUES ($1,$2,'access',$3,'in_progress',$4::jsonb,$5::jsonb,$6::jsonb,$7,'migration-it')`,
      [tenantId, requestId, subjectReference,
        JSON.stringify(legacyEnvelope("json", { marker:secrets.identity }, privacyContext("identity_evidence"))),
        JSON.stringify(legacyEnvelope("json", { marker:secrets.scope }, privacyContext("scope"))),
        JSON.stringify(legacyEnvelope("json", { marker:secrets.result }, privacyContext("result"))),
        new Date(Date.now() + 86_400_000).toISOString()]
    );
  });

  const before = await inventory();
  assert.equal(before.ok, false, "v1数据不得通过发布预检证据判定");
  assert.equal(before.total_legacy_v1, LEGACY_FIELD_ENVELOPE_FIELDS.length);

  const dryRun = await executeMigration([], completeKeyring);
  assert.equal(dryRun.code, 0, dryRun.stderr);
  assertNoSecretInLogs(dryRun);
  const dryRunReport = JSON.parse(dryRun.stdout);
  assert.equal(dryRunReport.status, "dry_run");
  assert.equal(dryRunReport.legacy_inventory_after.total_legacy_v1, LEGACY_FIELD_ENVELOPE_FIELDS.length);
  assert.equal((await inventory()).total_legacy_v1, LEGACY_FIELD_ENVELOPE_FIELDS.length,
    "dry-run不得改变任何信封");

  const partialV2 = encryption.rewrapJson(
    legacyEnvelope("json", { marker:secrets.state }, stateContext),
    stateContext
  );
  await migrator.transaction(async (client) => {
    await client.query("SET LOCAL ROLE huamei_owner");
    await client.query("UPDATE conversation_sessions SET state=$3::jsonb WHERE tenant_id=$1 AND id=$2",
      [tenantId, sessionRecordId, JSON.stringify(partialV2)]);
  });
  const partial = await inventory();
  assert.equal(partial.ok, false, "部分迁移后仍必须阻断灰度");
  assert.equal(partial.total_legacy_v1, LEGACY_FIELD_ENVELOPE_FIELDS.length - 1);

  const legacyState = legacyEnvelope("json", { marker:secrets.state }, stateContext);
  const setState = async (value) => migrator.transaction(async (client) => {
    await client.query("SET LOCAL ROLE huamei_owner");
    await client.query("UPDATE conversation_sessions SET state=$3::jsonb WHERE tenant_id=$1 AND id=$2",
      [tenantId, sessionRecordId, JSON.stringify(value)]);
  });
  await setState(legacyState);

  const missingOldKey = await executeMigration(["--apply", "--confirm-write-stop"], missingOldKeyring);
  assert.notEqual(missingOldKey.code, 0, "缺少旧key必须fail-closed");
  assert.equal(parseFailure(missingOldKey).code, "FIELD_ENCRYPTION_KEY_UNAVAILABLE");
  assertNoSecretInLogs(missingOldKey);
  assert.equal((await inventory()).total_legacy_v1, LEGACY_FIELD_ENVELOPE_FIELDS.length,
    "缺少旧key的apply必须整批回滚");

  await setState({ plaintext:true });
  const plaintextRejected = await executeMigration([], completeKeyring);
  assert.notEqual(plaintextRejected.code, 0);
  assert.equal(parseFailure(plaintextRejected).code, "FIELD_ENVELOPE_PLAINTEXT_OR_UNKNOWN");
  await setState(legacyState);

  await setState({ _encrypted:"huamei.field.a256gcm.v99", version:99 });
  const unknownRejected = await executeMigration([], completeKeyring);
  assert.notEqual(unknownRejected.code, 0);
  assert.equal(parseFailure(unknownRejected).code, "FIELD_ENVELOPE_PLAINTEXT_OR_UNKNOWN");
  await setState(legacyState);

  const validV2 = encryption.encryptJson({ marker:secrets.state }, stateContext);
  const damagedV2 = {
    ...validV2,
    ciphertext:`${validV2.ciphertext.startsWith("A") ? "B" : "A"}${validV2.ciphertext.slice(1)}`
  };
  await setState(damagedV2);
  const damagedRejected = await executeMigration([], completeKeyring);
  assert.notEqual(damagedRejected.code, 0);
  assert.equal(parseFailure(damagedRejected).code, "FIELD_DECRYPTION_FAILED");
  await setState(legacyState);

  const confirmationRequired = await executeMigration(["--apply"], completeKeyring);
  assert.notEqual(confirmationRequired.code, 0);
  assert.equal(parseFailure(confirmationRequired).code, "FIELD_ENVELOPE_V2_WRITE_STOP_CONFIRMATION_REQUIRED");

  const applied = await executeMigration(["--apply", "--confirm-write-stop"], completeKeyring);
  assert.equal(applied.code, 0, applied.stderr);
  assertNoSecretInLogs(applied);
  const appliedReport = JSON.parse(applied.stdout);
  assert.equal(appliedReport.status, "applied");
  assert.equal(appliedReport.legacy_inventory_after.ok, true);
  assert.equal(appliedReport.legacy_inventory_after.total_legacy_v1, 0);
  assert.equal(Object.values(appliedReport.counts).reduce((sum, count) => sum + count.migrated, 0),
    LEGACY_FIELD_ENVELOPE_FIELDS.length);
  assert.equal((await inventory()).ok, true, "完整apply后发布预检所依据的v1总数必须为0");

  const migrated = await runtime.tenantQuery(tenantId, `
    SELECT s.state,m.content,m.metadata,l.profile,candidate.profile AS candidate_profile,
      consent.evidence,h.snapshot,w.notes,w.recorded_at,r.response,r.audit,
      dsr.identity_evidence,dsr.scope,dsr.result
    FROM conversation_sessions s
    JOIN conversation_messages m ON m.tenant_id=s.tenant_id AND m.session_record_id=s.id
    JOIN leads l ON l.tenant_id=s.tenant_id AND l.lead_id=$2
    JOIN lead_candidates candidate ON candidate.tenant_id=s.tenant_id AND candidate.candidate_id=$3
    JOIN consents consent ON consent.tenant_id=l.tenant_id AND consent.lead_record_id=l.id
    JOIN handovers h ON h.tenant_id=s.tenant_id AND h.session_record_id=s.id
    JOIN human_work w ON w.tenant_id=s.tenant_id AND w.session_record_id=s.id
    JOIN agent_runs r ON r.tenant_id=s.tenant_id AND r.run_id=$4
    JOIN data_subject_requests dsr ON dsr.tenant_id=s.tenant_id AND dsr.request_id=$5
    WHERE s.tenant_id=$1 AND s.id=$6`,
  [tenantId, leadId, candidateId, runId, requestId, sessionRecordId]);
  assert.equal(migrated.rowCount, 1);
  const row = migrated.rows[0];
  const allEnvelopes = [
    row.state,
    JSON.parse(row.content),
    row.metadata.session_snapshot,
    row.profile,
    row.candidate_profile,
    row.evidence,
    row.snapshot,
    JSON.parse(row.notes),
    row.response,
    row.audit,
    row.identity_evidence,
    row.scope,
    row.result
  ];
  assert.ok(allEnvelopes.every((value) => getFieldEncryptionEnvelopeMetadata(value)?.current === true),
    "所有13个受保护字段必须已转为结构化AAD v2");
  assert.equal(encryption.decryptJson(row.state, stateContext).marker, secrets.state);
  assert.equal(encryption.decryptText(row.content, messageContext), secrets.content);
  assert.equal(encryption.decryptJson(row.metadata.session_snapshot, snapshotContext).marker, secrets.snapshot);
  assert.equal(encryption.decryptJson(row.profile, leadContext).marker, secrets.lead);
  assert.equal(encryption.decryptJson(row.candidate_profile, candidateContext).marker, secrets.candidate);
  assert.equal(encryption.decryptJson(row.evidence, consentContext).marker, secrets.consent);
  assert.equal(encryption.decryptJson(row.snapshot, handoverContext).marker, secrets.handover);
  const storedNotesContext = {
    ...notesContext,
    recordId:createFieldRecordId("human_work", {
      conversation_id:externalConversationId,
      recorded_at:new Date(row.recorded_at).toISOString(),
      staff_id:staffId
    })
  };
  assert.equal(encryption.decryptText(row.notes, storedNotesContext), secrets.notes);
  assert.equal(encryption.decryptJson(row.response, responseContext).marker, secrets.response);
  assert.equal(encryption.decryptJson(row.audit, auditContext).marker, secrets.audit);
  assert.equal(encryption.decryptJson(row.identity_evidence, privacyContext("identity_evidence")).marker, secrets.identity);
  assert.equal(encryption.decryptJson(row.scope, privacyContext("scope")).marker, secrets.scope);
  assert.equal(encryption.decryptJson(row.result, privacyContext("result")).marker, secrets.result);

  const collidingStructuredContext = {
    tenantId,
    scope:"conversation.message.content",
    recordId:createFieldRecordId("conversation.message", {
      channel,
      message_id:"1",
      session_id:"case:turn"
    }),
    legacyRecordId:`${channel}:case:turn:1`
  };
  assert.equal(collidingStructuredContext.legacyRecordId, messageContext.legacyRecordId,
    "两组旧分隔符身份应人为构造为同一串");
  await assert.rejects(
    async () => encryption.decryptText(row.content, collidingStructuredContext),
    (error) => error?.code === "FIELD_DECRYPTION_FAILED",
    "v2必须拒绝旧冒号串可碰撞但命名字段不同的AAD"
  );

  console.log("✓ PostgreSQL受控AAD v1→v2：13字段原子迁移、旧key/明文/未知/损坏失败、灰度门禁与冒号碰撞拒绝通过");
} finally {
  await Promise.allSettled([runtime.close(), migrator.close()]);
}
