import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const runtimeUrl = String(process.env.HUAMEI_DATABASE_URL || "");
const migrationUrl = String(process.env.HUAMEI_MIGRATION_DATABASE_URL || "");
if (!runtimeUrl || !migrationUrl) {
  throw new Error("联系方式保险库集成测试需要runtime与migrator PostgreSQL URL");
}

const suffix = randomUUID().slice(0, 8);
const tenantId = `contact-vault-${suffix}`;
const otherTenantId = `contact-other-${suffix}`;
const sessionId = `captured-contact-${suffix}`;
const internalSessionId = `${tenantId}:web:${sessionId}`;
const mobile = "13876543210";
const actor = `advisor-${suffix}`;
const otherActor = `other-${suffix}`;
const fieldKey = randomBytes(32).toString("base64");
const contactKey = randomBytes(32).toString("base64");

process.env.HUAMEI_RUNTIME_ENV = "development";
process.env.HUAMEI_PERSISTENCE_BACKEND = "postgres";
process.env.HUAMEI_DATABASE_URL = runtimeUrl;
process.env.HUAMEI_DEFAULT_TENANT_ID = tenantId;
process.env.HUAMEI_IDENTITY_PEPPER = `contact_identity_${randomBytes(32).toString("base64url")}`;
process.env.HUAMEI_FIELD_ENCRYPTION_KEYRING_JSON = JSON.stringify({
  active_key_id:"contact-it-field-v1",
  keys:{ "contact-it-field-v1":fieldKey }
});
process.env.HUAMEI_CONTACT_VAULT_KEYRING_JSON = JSON.stringify({
  active_key_id:"contact-it-v1",
  keys:{ "contact-it-v1":contactKey }
});

const { createPostgresClient } = await import("../server/platform/postgres.mjs");
const { ensureTenant } = await import("../server/persistence/postgres-helpers.mjs");
const { createPostgresOperationsStore } = await import("../server/persistence/postgres-operations-store.mjs");
const { createPostgresContactVaultStore } = await import("../server/persistence/postgres-contact-vault-store.mjs");
const { mobileIdentityHmac, upsertAcquisitionLead } = await import("../server/lead-store.mjs");

const runtime = createPostgresClient({ connectionString:runtimeUrl, applicationName:"huamei-contact-vault-runtime-it" });
const migrator = createPostgresClient({ connectionString:migrationUrl, applicationName:"huamei-contact-vault-migrator-it" });
const subject = mobileIdentityHmac(mobile, tenantId);

try {
  await migrator.transaction(async (client) => {
    await client.query("SET LOCAL ROLE huamei_owner");
    await client.query(
      `INSERT INTO tenants (tenant_id,display_name) VALUES ($1,$1),($2,$2)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantId, otherTenantId]
    );
  });
  await runtime.tenantTransaction(tenantId, async (client) => {
    await ensureTenant(client, tenantId);
    await client.query(
      `INSERT INTO conversation_sessions
        (tenant_id,session_id,channel,external_conversation_id,state)
       VALUES ($1,$2,'web',$3,'{}'::jsonb)`,
      [tenantId, internalSessionId, sessionId]
    );
  });

  const captured = await upsertAcquisitionLead({
    tenant_id:tenantId,
    session_id:sessionId,
    channel:"web",
    mobile,
    name:"保险库测试客户",
    service_consent:true,
    interests:["眼部整形"],
    messages:[{ role:"user", content:"我想继续了解" }]
  });
  assert.equal(captured.verification_status, "pending_manual");
  assert.deepEqual(captured.contact, {
    contact_reference:captured.contact.contact_reference,
    contact_type:"mobile",
    masked_value:"138****3210",
    purpose:"service_callback",
    phone_verification_status:"pending_manual",
    durable:true,
    encrypted:true
  });
  assert.match(captured.contact.contact_reference, /^contact_[a-f0-9]{32}$/);

  const encryptedRows = await runtime.tenantQuery(tenantId,
    `SELECT contact_reference,encrypted_value::text AS envelope,masked_value,
       ownership_verification_id,ownership_verification_method,ownership_verified_at,
       phone_verification_status,encryption_key_id
     FROM contact_vault_entries WHERE tenant_id=$1`,
    [tenantId]
  );
  assert.equal(encryptedRows.rowCount, 1);
  assert.match(encryptedRows.rows[0].envelope, /huamei\.contact-vault\.a256gcm\.v1/);
  const storedEnvelope = JSON.parse(encryptedRows.rows[0].envelope);
  assert.equal(storedEnvelope.wrapped_data_key?.algorithm, "A256GCM");
  assert.equal(storedEnvelope.wrapped_data_key?.kind, "data_key");
  assert.ok(storedEnvelope.wrapped_data_key?.ciphertext, "数据库必须保存由独立contact KEK包装的随机DEK");
  assert.equal(storedEnvelope.wrapped_data_key?.key, undefined, "数据库不得保存明文DEK");
  assert.equal(encryptedRows.rows[0].encryption_key_id, "contact-it-v1");
  assert.equal(encryptedRows.rows[0].ownership_verification_method, "format_validation");
  assert.equal(encryptedRows.rows[0].ownership_verified_at, null);
  assert.equal(encryptedRows.rows[0].phone_verification_status, "pending_manual");
  assert.doesNotMatch(JSON.stringify(encryptedRows.rows), new RegExp(mobile));
  const crossTenantRows = await runtime.tenantQuery(otherTenantId,
    "SELECT contact_reference FROM contact_vault_entries WHERE tenant_id=$1",
    [otherTenantId]
  );
  assert.equal(crossTenantRows.rowCount, 0);

  const operations = createPostgresOperationsStore({ postgres:runtime });
  const handover = await operations.ensureHandoverTask({
    envelope:{
      tenant_id:tenantId,
      channel:"web",
      conversation_id:sessionId,
      actor:{ external_user_id:"browser-user", customer_id:null },
      message:{ id:`contact-handover-${suffix}`, text:"请人工回访" }
    },
    result:{ status:"handover_required", handover:{ required:true, reason:"human_requested", to_team:"人工咨询" } },
    sessionSnapshot:{ conversation_summary:"客户请求回访", known_slots:{}, projects:["眼部整形"] },
    contactInitiation:"customer_inbound",
    safeText:(value, limit = 500) => String(value || "").slice(0, limit)
  });
  await operations.claimHandover({ handoverId:handover.id, tenantId, assignee:actor });
  const vault = createPostgresContactVaultStore({ postgres:runtime });
  const revealRequestId = `reveal-${randomUUID()}`;
  const revealed = await vault.revealForClaimedHandover({
    tenantId,
    handoverId:handover.id,
    actor,
    revealRequestId,
    requestId:`request-${suffix}`
  });
  assert.equal(revealed.value, mobile);
  assert.equal(revealed.browser_storage_allowed, false);
  assert.equal(revealed.disclosure, "explicit_one_time_view");

  await assert.rejects(
    () => vault.revealForClaimedHandover({ tenantId, handoverId:handover.id, actor, revealRequestId }),
    (error) => error.code === "CONTACT_REVEAL_REPLAYED" && error.status === 409
  );
  await assert.rejects(
    () => vault.revealForClaimedHandover({
      tenantId,
      handoverId:handover.id,
      actor:otherActor,
      revealRequestId:`reveal-${randomUUID()}`
    }),
    (error) => error.code === "CONTACT_REVEAL_ASSIGNEE_MISMATCH" && error.status === 403
  );
  await assert.rejects(
    () => vault.revealForClaimedHandover({
      tenantId:otherTenantId,
      handoverId:handover.id,
      actor,
      revealRequestId:`reveal-${randomUUID()}`
    }),
    (error) => error.code === "HANDOVER_NOT_FOUND" && error.status === 404
  );

  await runtime.tenantQuery(tenantId,
    `UPDATE consents SET is_current=false
     WHERE tenant_id=$1 AND consent_type='service' AND is_current`,
    [tenantId]
  );
  await assert.rejects(
    () => vault.revealForClaimedHandover({
      tenantId,
      handoverId:handover.id,
      actor,
      revealRequestId:`reveal-${randomUUID()}`
    }),
    (error) => error.code === "CONTACT_REVEAL_SERVICE_CONSENT_REQUIRED"
  );
  await runtime.tenantQuery(tenantId,
    `UPDATE consents SET is_current=true
     WHERE tenant_id=$1 AND consent_type='service'`,
    [tenantId]
  );

  const privacyRequestId = `dsr_contact_${suffix}`;
  const privacyActionId = `pact_contact_${suffix}`;
  await runtime.tenantTransaction(tenantId, async (client) => {
    await client.query(
      `INSERT INTO data_subject_requests
        (tenant_id,request_id,request_type,subject_reference_hmac,status,scope,due_at,created_by)
       VALUES ($1,$2,'restrict',$3,'fulfilled',$4::jsonb,clock_timestamp()+interval '1 day','contact-vault-it')`,
      [tenantId, privacyRequestId, subject, JSON.stringify({ purposes:["service"] })]
    );
    await client.query(
      `INSERT INTO privacy_execution_actions
        (tenant_id,action_id,request_id,action_type,execution_mode,status,purposes,
         input_checksum,processor_id,approver_id,requirements,outcome,approved_at,completed_at)
       VALUES ($1,$2,$3,'restrict_contact','automatic','executed',ARRAY['service']::text[],
         $4,$5,$6,'{}'::jsonb,'{}'::jsonb,clock_timestamp(),clock_timestamp())`,
      [tenantId, privacyActionId, privacyRequestId,
        createHash("sha256").update(privacyActionId).digest("hex"),
        `processor-${suffix}`, `approver-${suffix}`]
    );
    await client.query(
      `INSERT INTO contact_suppressions
        (tenant_id,subject_reference_hmac,purpose,status,reason,origin_request_id,
         last_request_id,last_action_id,created_by)
       VALUES ($1,$2,'service','active','processing_restricted',$3,$3,$4,$5)`,
      [tenantId, subject, privacyRequestId, privacyActionId, `approver-${suffix}`]
    );
  });
  await assert.rejects(
    () => vault.revealForClaimedHandover({
      tenantId,
      handoverId:handover.id,
      actor,
      revealRequestId:`reveal-${randomUUID()}`
    }),
    (error) => error.code === "CONTACT_REVEAL_SUPPRESSED"
  );

  const audit = await runtime.tenantQuery(tenantId,
    `SELECT action,actor_id,resource_id,details::text AS details
     FROM audit_events WHERE tenant_id=$1 AND action LIKE 'contact.%'
     ORDER BY created_at,event_id`,
    [tenantId]
  );
  assert.ok(audit.rows.some((row) => row.action === "contact.vault_created"));
  assert.ok(audit.rows.some((row) => row.action === "contact.revealed" && row.actor_id === actor));
  assert.ok(audit.rows.some((row) => row.action === "contact.reveal_denied"));
  assert.doesNotMatch(JSON.stringify(audit.rows), new RegExp(mobile));
  assert.doesNotMatch(JSON.stringify(audit.rows), new RegExp(subject));

  const plaintextProbe = await runtime.tenantQuery(tenantId,
    `SELECT
       (SELECT profile::text FROM leads WHERE tenant_id=$1 LIMIT 1) AS profile,
       (SELECT string_agg(details::text,'') FROM audit_events WHERE tenant_id=$1) AS audits`,
    [tenantId]
  );
  assert.doesNotMatch(JSON.stringify(plaintextProbe.rows), new RegExp(mobile));

  console.log("✓ PostgreSQL联系方式保险库原子密文留资、RLS、本人接管显示、撤回抑制、防重放与脱敏审计通过");
} finally {
  await Promise.allSettled([runtime.close(), migrator.close()]);
}
