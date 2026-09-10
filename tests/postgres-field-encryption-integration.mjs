import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

if (String(process.env.HUAMEI_PERSISTENCE_BACKEND || "").toLowerCase() !== "postgres") {
  throw new Error("字段加密集成测试必须显式设置 HUAMEI_PERSISTENCE_BACKEND=postgres");
}
const runtimeUrl = String(process.env.HUAMEI_DATABASE_URL || "");
const migrationUrl = String(process.env.HUAMEI_MIGRATION_DATABASE_URL || "");
if (!runtimeUrl || !migrationUrl) {
  throw new Error("字段加密集成测试需要runtime与migrator PostgreSQL URL");
}

const suffix = randomUUID().slice(0, 8);
const tenantId = `encryption-${suffix}`;
const channel = "web";
const externalConversationId = `secure-conversation-${suffix}`;
const sessionId = `${tenantId}:${channel}:${externalConversationId}`;
const messageId = `secure-inbound-${suffix}`;
const staffId = `staff-${suffix}`;
const recordedAt = new Date().toISOString();
const identity = createHash("sha256").update(`identity-${suffix}`).digest("hex");
const oldKey = randomBytes(32).toString("base64");
const newKey = randomBytes(32).toString("base64");
const oldKeyring = JSON.stringify({ active_key_id:"phase1-v1", keys:{ "phase1-v1":oldKey } });
const rotatedKeyring = JSON.stringify({
  active_key_id:"phase1-v2",
  keys:{ "phase1-v1":oldKey, "phase1-v2":newKey }
});
process.env.HUAMEI_CONTACT_VAULT_KEYRING_JSON = JSON.stringify({
  active_key_id:"field-test-contact-v1",
  keys:{ "field-test-contact-v1":randomBytes(32).toString("base64") }
});

const secrets = {
  mobile:"13987654321",
  displayName:`ENC_NAME_${suffix}_王女士`,
  interest:`ENC_INTEREST_${suffix}_私密咨询`,
  userMessage:`ENC_USER_${suffix}_这是只属于本人的问题`,
  assistantMessage:`ENC_ASSISTANT_${suffix}_这是顾问回复`,
  state:`ENC_STATE_${suffix}_会话摘要`,
  handoverSummary:`ENC_HANDOVER_SUMMARY_${suffix}_人工交接摘要`,
  externalUser:`ENC_EXTERNAL_USER_${suffix}`,
  handoverInbound:`ENC_HANDOVER_INBOUND_${suffix}_补充问题`,
  resolution:`ENC_RESOLUTION_${suffix}_已由人工解释`,
  workNotes:`ENC_WORK_NOTES_${suffix}_人工跟进备注`,
  modelResponse:`ENC_MODEL_RESPONSE_${suffix}_模型完整回复`,
  modelAudit:`ENC_MODEL_AUDIT_${suffix}_模型输入摘要`,
  migrationState:`ENC_MIGRATION_STATE_${suffix}_旧会话状态`,
  migrationName:`ENC_MIGRATION_NAME_${suffix}_迁移客户`,
  migrationInterest:`ENC_MIGRATION_INTEREST_${suffix}_历史兴趣`
};
const maskedMobile = "139****4321";
const migratedMaskedMobile = "138****2468";
const safeText = (value, limit = 1_000) => String(value || "").slice(0, limit);
const payloadHash = createHash("sha256").update(secrets.userMessage).digest("hex");

const { createPostgresClient } = await import("../server/platform/postgres.mjs");
const { createFieldEncryption, createFieldRecordId, isFieldEncryptionEnvelope } = await import("../server/platform/field-encryption.mjs");
const { createPostgresAcquisitionSessionStore } = await import("../server/persistence/postgres-session-store.mjs");
const { createPostgresLeadStore } = await import("../server/persistence/postgres-lead-store.mjs");
const { createPostgresOperationsStore } = await import("../server/persistence/postgres-operations-store.mjs");
const { createPostgresAgentRunStore } = await import("../server/persistence/postgres-agent-run-store.mjs");

const runtime = createPostgresClient({ connectionString:runtimeUrl, applicationName:"huamei-field-encryption-runtime-it" });
const migrator = createPostgresClient({ connectionString:migrationUrl, applicationName:"huamei-field-encryption-migrator-it" });
const oldEncryption = createFieldEncryption({ keyringJson:oldKeyring, production:true });
const rotatedEncryption = createFieldEncryption({ keyringJson:rotatedKeyring, production:true });
const sessionStore = createPostgresAcquisitionSessionStore({ postgres:runtime, fieldEncryption:oldEncryption });
const leadStore = createPostgresLeadStore({ postgres:runtime, fieldEncryption:oldEncryption });
const operationsStore = createPostgresOperationsStore({ postgres:runtime, fieldEncryption:oldEncryption });
const agentRunStore = createPostgresAgentRunStore({ postgres:runtime, fieldEncryption:oldEncryption });
const projectRoot = fileURLToPath(new URL("../", import.meta.url));
let migrationSourceRoot = null;

const runMigration = (sourceRoot) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [
    "scripts/migrate-local-json-to-postgres.mjs",
    "--apply",
    `--source=${sourceRoot}`,
    `--tenant=${tenantId}`
  ], {
    cwd:projectRoot,
    env:{
      ...process.env,
      NODE_ENV:"production",
      HUAMEI_PERSISTENCE_BACKEND:"postgres",
      HUAMEI_DATABASE_URL:runtimeUrl,
      HUAMEI_MIGRATION_DATABASE_URL:migrationUrl,
      HUAMEI_FIELD_ENCRYPTION_KEYRING_JSON:oldKeyring
    },
    stdio:["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-40_000); });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-40_000); });
  child.once("error", reject);
  child.once("exit", (code) => resolve({ code, stdout, stderr }));
});

const stateContext = {
  tenantId,
  scope:"conversation.session.state",
  recordId:createFieldRecordId("conversation.session", { channel, session_id:sessionId }),
  legacyRecordId:`${channel}:${sessionId}`
};
const messageContext = (id) => ({
  tenantId,
  scope:"conversation.message.content",
  recordId:createFieldRecordId("conversation.message", { channel, message_id:id, session_id:sessionId }),
  legacyRecordId:`${channel}:${sessionId}:${id}`
});
const consentEvidenceContext = (consentType, evidenceHash) => ({
  tenantId,
  scope:"lead.consent.evidence",
  recordId:createFieldRecordId("lead.consent", {
    consent_type:consentType,
    evidence_hash:evidenceHash,
    subject_reference_hmac:identity
  }),
  legacyRecordId:`${identity}:${consentType}:${evidenceHash}`
});

try {
  await migrator.query("SET ROLE huamei_owner");
  await migrator.query(
    "INSERT INTO tenants (tenant_id,display_name) VALUES ($1,$1) ON CONFLICT (tenant_id) DO NOTHING",
    [tenantId]
  );

  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const initialState = { marker:secrets.state, known_slots:{ interest:secrets.interest } };
  await sessionStore.beginTurn({
    tenantId,
    sessionId,
    channel,
    externalConversationId,
    expiresAt,
    initialState,
    messageId,
    message:secrets.userMessage,
    payloadHash,
    occurredAt:new Date().toISOString(),
    operation:async (current) => ({
      state:{ ...current, processing:true },
      result:{ accepted:true }
    })
  });
  const completed = await sessionStore.recordTurn({
    tenantId,
    sessionId,
    channel,
    externalConversationId,
    expiresAt,
    initialState,
    messageId,
    payloadHash,
    assistantMessage:secrets.assistantMessage,
    status:"completed",
    operation:async (current) => ({
      state:{ ...current, processing:false, marker:secrets.state },
      result:{ ...current, processing:false, marker:secrets.state, customer_visible:true }
    })
  });
  assert.equal(completed.result.marker, secrets.state);
  assert.equal((await sessionStore.get({ tenantId, sessionId, channel })).marker, secrets.state);

  const now = new Date().toISOString();
  const customerId = `C-ENC-${suffix}`;
  const leadDocument = {
    tenant_id:tenantId,
    created_at:now,
    updated_at:now,
    interactions:1,
    customer:{
      id:customerId,
      name:secrets.displayName,
      mobile:maskedMobile,
      firstChannel:channel,
      latestChannel:channel,
      macroStage:"售前",
      microStage:"留资待预约",
      interests:[{ name:secrets.interest, score:88 }],
      profile:{ concern:secrets.interest }
    },
    conversations:[{
      id:`V-ENC-${suffix}`,
      customerId,
      messages:[{ from:"customer", text:secrets.userMessage, at:now }]
    }],
    task:{ id:`T-ENC-${suffix}`, title:secrets.interest }
  };
  const leadResult = await leadStore.upsert({
    tenantId,
    identity,
    verification:{
      schema:"huamei.contact-capture.v1",
      verified:false,
      status:"pending_manual",
      method:"format_validation",
      tenant_id:tenantId,
      subject_reference_hmac:identity,
      session_id:externalConversationId,
      verification_id:`format-${suffix}`,
      captured_at:now
    },
    payload:{
      session_id:externalConversationId,
      channel,
      mobile:secrets.mobile,
      name:secrets.displayName,
      interests:[secrets.interest],
      marketing_consent:true
    },
    buildLead:() => leadDocument
  });
  assert.equal(leadResult.lead.customer.name, secrets.displayName);
  assert.equal((await leadStore.snapshot(tenantId))[0].customer.interests[0].name, secrets.interest);

  const envelope = {
    tenant_id:tenantId,
    channel,
    conversation_id:externalConversationId,
    actor:{ external_user_id:secrets.externalUser, customer_id:customerId },
    message:{ id:`handover-trigger-${suffix}`, text:secrets.handoverSummary }
  };
  const handover = await operationsStore.ensureHandoverTask({
    envelope,
    result:{ status:"handover_required", handover:{ required:true, reason:"human_requested", to_team:"人工咨询" } },
    sessionSnapshot:{
      conversation_summary:secrets.handoverSummary,
      known_slots:{ private_interest:secrets.interest },
      projects:[secrets.interest]
    },
    contactInitiation:"customer_inbound",
    safeText
  });
  assert.equal(handover.summary, secrets.handoverSummary);
  assert.equal((await operationsStore.recordInbound(handover, {
    ...envelope,
    message:{ id:`handover-inbound-${suffix}`, text:secrets.handoverInbound }
  }, safeText)).duplicate, false);
  const claimed = await operationsStore.claimHandover({
    tenantId,
    handoverId:handover.id,
    assignee:staffId
  });
  assert.equal(claimed.assignee, staffId);
  const completedHandover = await operationsStore.completeHandover({
    tenantId,
    handoverId:handover.id,
    actor:staffId,
    resolution:secrets.resolution
  });
  assert.equal(completedHandover.resolution, secrets.resolution);
  await operationsStore.recordHumanWork({
    tenant_id:tenantId,
    channel,
    conversation_id:externalConversationId,
    handover_id:handover.id,
    staff_id:staffId,
    work_type:"presales_service",
    minutes:4.5,
    notes:secrets.workNotes,
    occurred_at:recordedAt
  }, safeText);

  const runId = `run-${suffix}`;
  const agentAudit = {
    tenant_id:tenantId,
    run_id:runId,
    request_id:`request-${suffix}`,
    agent_id:"A-01",
    agent_version:"phase1-encryption-it",
    status:"completed",
    channel,
    caller:"field-encryption-integration",
    decision:"completed",
    input_summary:secrets.modelAudit,
    created_at:new Date().toISOString()
  };
  await agentRunStore.upsert({
    response:{ status:"completed", message:secrets.modelResponse },
    audit:agentAudit
  });
  assert.equal((await agentRunStore.get(runId, tenantId)).response.message, secrets.modelResponse);

  migrationSourceRoot = await mkdtemp(join(tmpdir(), "huamei-encrypted-migration-"));
  const migratedSessionId = `${tenantId}:web:migrated-${suffix}`;
  const migratedIdentity = createHash("sha256").update(`migrated-identity-${suffix}`).digest("hex");
  const migrationNow = new Date().toISOString();
  await Promise.all([
    writeFile(join(migrationSourceRoot, "acquisition-sessions.json"), JSON.stringify({
      version:1,
      sessions:{
        [migratedSessionId]:{
          marker:secrets.migrationState,
          known_slots:{ interest:secrets.migrationInterest },
          createdAt:Date.now(),
          updatedAt:Date.now()
        }
      }
    }), { mode:0o600 }),
    writeFile(join(migrationSourceRoot, "acquisition-leads.json"), JSON.stringify({
      version:1,
      leads:[{
        tenant_id:tenantId,
        phone_hash:migratedIdentity,
        created_at:migrationNow,
        updated_at:migrationNow,
        interactions:1,
        customer:{
          id:`C-MIG-${suffix}`,
          name:secrets.migrationName,
          mobile:migratedMaskedMobile,
          firstChannel:"web",
          macroStage:"售前",
          microStage:"新咨询",
          interests:[{ name:secrets.migrationInterest, score:76 }],
          serviceConsent:true
        },
        conversations:[],
        task:null
      }]
    }), { mode:0o600 })
  ]);
  const migration = await runMigration(migrationSourceRoot);
  assert.equal(migration.code, 0, "权限分离的受控本地JSON迁移必须成功");
  for (const secret of [secrets.migrationState, secrets.migrationName, secrets.migrationInterest]) {
    assert.equal(`${migration.stdout}${migration.stderr}`.includes(secret), false, "迁移日志不得输出C3/C2正文");
  }
  const migrationReport = JSON.parse(migration.stdout);
  assert.deepEqual(migrationReport.validation.execution_identity, {
    current_user:"huamei_owner",
    session_user:"huamei_migrator"
  });
  assert.equal(migrationReport.validation.field_encryption, "aes-256-gcm");
  assert.equal(migrationReport.counts.consents, 0);
  assert.equal(migrationReport.counts.legacy_consent_flags_not_promoted, 1);
  assert.equal(migrationReport.validation.legacy_consent_handling.promoted_to_current_consent, 0);
  assert.equal(migrationReport.validation.legacy_consent_handling.fresh_consent_required, true);
  const migratedSessionRows = await runtime.tenantQuery(tenantId,
    "SELECT state FROM conversation_sessions WHERE tenant_id=$1 AND channel='web' AND session_id=$2",
    [tenantId, migratedSessionId]
  );
  assert.equal(oldEncryption.decryptJson(migratedSessionRows.rows[0].state, {
    tenantId,
    scope:"conversation.session.state",
    recordId:createFieldRecordId("conversation.session", { channel:"web", session_id:migratedSessionId }),
    legacyRecordId:`web:${migratedSessionId}`
  }).marker, secrets.migrationState);
  const migratedLeadRows = await runtime.tenantQuery(tenantId,
    `SELECT id, display_name, primary_interest, interests, profile
     FROM leads WHERE tenant_id=$1 AND normalized_mobile_hmac=$2`,
    [tenantId, migratedIdentity]
  );
  const migratedLead = migratedLeadRows.rows[0];
  assert.equal(migratedLead.display_name, null);
  assert.equal(migratedLead.primary_interest, null);
  assert.deepEqual(migratedLead.interests, []);
  const migratedProfile = oldEncryption.decryptJson(migratedLead.profile, {
    tenantId, scope:"lead.profile", recordId:migratedIdentity
  });
  assert.equal(migratedProfile._document.customer.name, secrets.migrationName);
  assert.equal("serviceConsent" in migratedProfile._document.customer, false);
  assert.deepEqual(migratedProfile._document.migration_annotations.legacy_consent_claims, [{
    consent_type:"service",
    original_asserted:true,
    usable_as_consent:false,
    requires_fresh_consent:true,
    status:"unverified_legacy_claim_not_promoted",
    reason:"missing_policy_version_timestamp_source_and_verifiable_evidence",
    migration_batch_id:migrationReport.batch_id
  }]);
  const migratedConsent = await runtime.tenantQuery(tenantId,
    `SELECT consent_type, evidence_hash, evidence FROM consents
     WHERE tenant_id=$1 AND lead_record_id=$2`,
    [tenantId, migratedLead.id]
  );
  assert.equal(migratedConsent.rowCount, 0, "缺少政策版本、时间与来源证据的历史标记不得提升为有效授权");

  const sessionRows = await runtime.tenantQuery(tenantId,
    `SELECT id, session_id, channel, state, lead_id, customer_id
     FROM conversation_sessions WHERE tenant_id=$1 AND channel=$2 AND session_id=$3`,
    [tenantId, channel, sessionId]
  );
  const sessionRow = sessionRows.rows[0];
  const leadRows = await runtime.tenantQuery(tenantId,
    `SELECT id, source_session_id, normalized_mobile_hmac, masked_mobile,
       display_name, primary_interest, interests, profile
     FROM leads WHERE tenant_id=$1 AND normalized_mobile_hmac=$2`,
    [tenantId, identity]
  );
  const leadRow = leadRows.rows[0];
  assert.equal(leadRow.source_session_id, sessionRow.id, "lead必须关联实际网页会话");
  assert.equal(sessionRow.lead_id, leadRow.id, "conversation_session必须反向关联lead");
  assert.equal(sessionRow.customer_id, customerId);
  assert.equal(leadRow.display_name, null);
  assert.equal(leadRow.primary_interest, null);
  assert.deepEqual(leadRow.interests, []);
  assert.equal(leadRow.masked_mobile, maskedMobile, "masked_mobile仅保留不能唯一还原手机号的展示值");

  assert.equal(isFieldEncryptionEnvelope(sessionRow.state), true);
  assert.equal(oldEncryption.decryptJson(sessionRow.state, stateContext).marker, secrets.state);
  const messages = await runtime.tenantQuery(tenantId,
    `SELECT message_id, role, content, metadata
     FROM conversation_messages
     WHERE tenant_id=$1 AND session_record_id=$2
     ORDER BY created_at, id`,
    [tenantId, sessionRow.id]
  );
  const userRow = messages.rows.find((row) => row.message_id === messageId);
  const assistantRow = messages.rows.find((row) => row.role === "assistant");
  const handoverInboundRow = messages.rows.find((row) => row.message_id === `handover-inbound-${suffix}`);
  assert.equal(oldEncryption.decryptText(userRow.content, messageContext(messageId)), secrets.userMessage);
  assert.equal(oldEncryption.decryptText(
    assistantRow.content,
    messageContext(assistantRow.message_id)
  ), secrets.assistantMessage);
  assert.equal(oldEncryption.decryptJson(userRow.metadata.session_snapshot, {
    tenantId,
    scope:"conversation.message.session_snapshot",
    recordId:createFieldRecordId("conversation.message", { channel, message_id:messageId, session_id:sessionId }),
    legacyRecordId:`${channel}:${sessionId}:${messageId}`
  }).marker, secrets.state);
  assert.equal(oldEncryption.decryptText(
    handoverInboundRow.content,
    messageContext(handoverInboundRow.message_id)
  ), secrets.handoverInbound);

  const profile = oldEncryption.decryptJson(leadRow.profile, {
    tenantId, scope:"lead.profile", recordId:identity
  });
  assert.equal(profile._document.customer.name, secrets.displayName);
  const consentRows = await runtime.tenantQuery(tenantId,
    `SELECT consent_type, evidence_hash, evidence
     FROM consents WHERE tenant_id=$1 AND lead_record_id=$2 ORDER BY consent_type`,
    [tenantId, leadRow.id]
  );
  assert.equal(consentRows.rowCount, 2);
  for (const row of consentRows.rows) {
    assert.equal(isFieldEncryptionEnvelope(row.evidence), true);
    const evidence = oldEncryption.decryptJson(row.evidence, consentEvidenceContext(row.consent_type, row.evidence_hash));
    assert.equal(evidence.session_id, externalConversationId);
  }

  const handoverRows = await runtime.tenantQuery(tenantId,
    "SELECT snapshot FROM handovers WHERE tenant_id=$1 AND handover_id=$2",
    [tenantId, handover.id]
  );
  const handoverSnapshot = oldEncryption.decryptJson(handoverRows.rows[0].snapshot, {
    tenantId,
    scope:"handover.snapshot",
    recordId:createFieldRecordId("handover", { handover_id:handover.id }),
    legacyRecordId:handover.id
  });
  assert.equal(handoverSnapshot.summary, secrets.handoverSummary);
  assert.equal(handoverSnapshot.resolution, secrets.resolution);
  assert.equal(handoverSnapshot.external_user_id, secrets.externalUser);

  const humanWorkRows = await runtime.tenantQuery(tenantId,
    `SELECT notes, recorded_at FROM human_work
     WHERE tenant_id=$1 AND staff_id=$2 ORDER BY created_at DESC LIMIT 1`,
    [tenantId, staffId]
  );
  const storedRecordedAt = new Date(humanWorkRows.rows[0].recorded_at).toISOString();
  assert.equal(storedRecordedAt, recordedAt);
  assert.equal(oldEncryption.decryptText(humanWorkRows.rows[0].notes, {
    tenantId,
    scope:"human_work.notes",
    recordId:createFieldRecordId("human_work", {
      conversation_id:externalConversationId,
      recorded_at:storedRecordedAt,
      staff_id:staffId
    }),
    legacyRecordId:`${externalConversationId}:${staffId}:${storedRecordedAt}`
  }), secrets.workNotes);

  const agentRows = await runtime.tenantQuery(tenantId,
    "SELECT response, audit FROM agent_runs WHERE tenant_id=$1 AND run_id=$2",
    [tenantId, runId]
  );
  assert.equal(oldEncryption.decryptJson(agentRows.rows[0].response, {
    tenantId, scope:"agent_run.response", recordId:runId
  }).message, secrets.modelResponse);
  assert.equal(oldEncryption.decryptJson(agentRows.rows[0].audit, {
    tenantId, scope:"agent_run.audit", recordId:runId
  }).input_summary, secrets.modelAudit);

  const scannedTables = [
    "conversation_sessions", "conversation_messages", "leads", "consents",
    "handovers", "tasks", "human_work", "agent_runs", "audit_events", "outbox_events",
    "data_migration_batches"
  ];
  let rawDatabaseText = "";
  for (const table of scannedTables) {
    const rows = await runtime.tenantQuery(
      tenantId,
      `SELECT row_to_json(record_row)::text AS raw
       FROM (SELECT * FROM ${table} WHERE tenant_id=$1) AS record_row`,
      [tenantId]
    );
    rawDatabaseText += rows.rows.map((row) => row.raw).join("\n");
  }
  for (const [name, secret] of Object.entries(secrets)) {
    assert.equal(rawDatabaseText.includes(secret), false, `数据库不得检索到${name}明文`);
  }
  assert.equal(rawDatabaseText.includes(maskedMobile), true, "数据库可保留不能唯一还原原号的脱敏展示值");
  assert.equal(rawDatabaseText.includes(migratedMaskedMobile), true, "迁移链路仅保留脱敏展示值");
  const eventRows = await runtime.tenantQuery(tenantId,
    `SELECT details AS value FROM audit_events WHERE tenant_id=$1
     UNION ALL
     SELECT payload AS value FROM outbox_events WHERE tenant_id=$1`,
    [tenantId]
  );
  const eventText = JSON.stringify(eventRows.rows);
  for (const secret of [
    secrets.userMessage,
    secrets.handoverSummary,
    secrets.handoverInbound,
    secrets.resolution,
    secrets.workNotes,
    secrets.modelResponse,
    secrets.modelAudit
  ]) {
    assert.equal(eventText.includes(secret), false, "audit/outbox不得携带C3正文");
  }

  assert.equal(rotatedEncryption.needsRotation(sessionRow.state), true);
  assert.equal(rotatedEncryption.needsRotation(userRow.content), true, "text JSON字符串封装也必须被轮换检测");
  assert.equal(rotatedEncryption.decryptJson(sessionRow.state, stateContext).marker, secrets.state);
  const rewrappedState = rotatedEncryption.rewrapJson(sessionRow.state, stateContext);
  assert.equal(rewrappedState.key_id, "phase1-v2");
  assert.equal(rotatedEncryption.needsRotation(rewrappedState), false);
  const rewrappedText = rotatedEncryption.rewrapText(userRow.content, messageContext(messageId));
  assert.equal(rotatedEncryption.needsRotation(rewrappedText), false);
  assert.equal(rotatedEncryption.decryptText(rewrappedText, messageContext(messageId)), secrets.userMessage);
  assert.throws(
    () => rotatedEncryption.decryptJson(sessionRow.state, { ...stateContext, tenantId:`other-${suffix}` }),
    (error) => error?.code === "FIELD_DECRYPTION_FAILED"
  );
  const tampered = {
    ...sessionRow.state,
    ciphertext:`${sessionRow.state.ciphertext.startsWith("A") ? "B" : "A"}${sessionRow.state.ciphertext.slice(1)}`
  };
  assert.throws(
    () => rotatedEncryption.decryptJson(tampered, stateContext),
    (error) => error?.code === "FIELD_DECRYPTION_FAILED"
  );

  console.log(`✓ PostgreSQL敏感字段无明文、AAD隔离、轮换、线索会话关联与audit/outbox最小化通过（${tenantId}）`);
} finally {
  try { await migrator.query("RESET ROLE"); } catch {}
  if (migrationSourceRoot) await rm(migrationSourceRoot, { recursive:true, force:true });
  await Promise.allSettled([runtime.close(), migrator.close()]);
}
