import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";

if (String(process.env.HUAMEI_PERSISTENCE_BACKEND || "").toLowerCase() !== "postgres") {
  throw new Error("手机号直接留资集成测试必须显式设置 HUAMEI_PERSISTENCE_BACKEND=postgres");
}
const runtimeUrl = String(process.env.HUAMEI_DATABASE_URL || "");
const migrationUrl = String(process.env.HUAMEI_MIGRATION_DATABASE_URL || "");
if (!runtimeUrl || !migrationUrl) throw new Error("手机号直接留资集成测试需要runtime与migrator PostgreSQL URL");

const suffix = randomUUID().slice(0, 8);
const tenantA = `lead-capture-a-${suffix}`;
const tenantB = `lead-capture-b-${suffix}`;
const mobile = "13876543210";
process.env.HUAMEI_RUNTIME_ENV = "development";
process.env.HUAMEI_DEFAULT_TENANT_ID = tenantA;
process.env.HUAMEI_IDENTITY_PEPPER = `lead_capture_pepper_${randomBytes(32).toString("base64url")}`;
process.env.HUAMEI_FIELD_ENCRYPTION_KEYRING_JSON = JSON.stringify({
  active_key_id:"lead-capture-v1",
  keys:{ "lead-capture-v1":randomBytes(32).toString("base64") }
});
process.env.HUAMEI_CONTACT_VAULT_KEYRING_JSON = JSON.stringify({
  active_key_id:"lead-contact-v1",
  keys:{ "lead-contact-v1":randomBytes(32).toString("base64") }
});
process.env.HUAMEI_MEMBER_CHECK_ENABLED = "false";

const { createPostgresClient } = await import("../server/platform/postgres.mjs");
const {
  acquisitionCustomerSnapshot,
  getCapturedLeadReferenceForSession,
  mobileIdentityHmac,
  upsertAcquisitionLead
} = await import("../server/lead-store.mjs");
const { createPostgresLeadStore } = await import("../server/persistence/postgres-lead-store.mjs");

const runtime = createPostgresClient({ connectionString:runtimeUrl, applicationName:"huamei-lead-capture-runtime" });
const migrator = createPostgresClient({ connectionString:migrationUrl, applicationName:"huamei-lead-capture-migrator" });
const subject = () => mobileIdentityHmac(mobile, tenantA);
const submit = (overrides = {}) => upsertAcquisitionLead({
  tenant_id:tenantA,
  mobile,
  service_consent:true,
  interests:["原始项目"],
  messages:[{ role:"user", content:"原始咨询" }],
  ...overrides
});

try {
  await migrator.transaction(async (client) => {
    await client.query("SET LOCAL ROLE huamei_owner");
    await client.query(
      `INSERT INTO tenants (tenant_id,display_name) VALUES ($1,$1),($2,$2)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantA, tenantB]
    );
  });

  await runtime.tenantQuery(tenantA, "INSERT INTO conversation_sessions(tenant_id,session_id,channel,external_conversation_id,state) VALUES($1,'internal-capture-session','web',$2,'{}'::jsonb)", [tenantA, `capture-a-${suffix}`]);
  const first = await submit({ session_id:`capture-a-${suffix}`, name:"测试客户" });
  assert.equal(first.verification_status, "pending_manual");
  assert.equal(first.is_existing, false);
  const capturedReference = await getCapturedLeadReferenceForSession({ tenant_id:tenantA, session_id:`capture-a-${suffix}` });
  assert.match(capturedReference.customer_reference, /^APR-/);
  assert.equal(capturedReference.phone_verification_status, "pending_manual");
  assert.doesNotMatch(JSON.stringify(capturedReference), new RegExp(mobile));
  assert.equal(await getCapturedLeadReferenceForSession({ tenant_id:tenantB, session_id:`capture-a-${suffix}` }), null);
  assert.equal(await getCapturedLeadReferenceForSession({ tenant_id:tenantA, session_id:"no-capture-session" }), null);
  assert.equal(first.lead.customer.phoneVerificationStatus, "pending_manual");
  const customerId = first.lead.customer.id;

  const second = await submit({
    session_id:`capture-b-${suffix}`,
    mobile:"+86 138 7654 3210",
    interests:["新增项目"],
    messages:[{ role:"user", content:"补充咨询" }]
  });
  assert.equal(second.verification_status, "pending_manual");
  assert.equal(second.is_existing, true);
  assert.equal(second.lead.customer.id, customerId);
  assert.equal(second.lead.customer.name, "测试客户");
  assert.ok(second.lead.customer.interests.some((item) => item.name === "新增项目"));

  const snapshot = await acquisitionCustomerSnapshot(tenantA);
  assert.equal(snapshot.customers.length, 1);
  assert.equal(snapshot.conversations.length, 2);
  assert.doesNotMatch(JSON.stringify(snapshot), new RegExp(mobile));

  const contactRows = await runtime.tenantQuery(tenantA,
    `SELECT ownership_verification_method,ownership_verified_at,phone_verification_status,
       encrypted_value::text AS encrypted_value
     FROM contact_vault_entries WHERE tenant_id=$1`,
    [tenantA]
  );
  assert.equal(contactRows.rowCount, 1);
  assert.equal(contactRows.rows[0].ownership_verification_method, "format_validation");
  assert.equal(contactRows.rows[0].ownership_verified_at, null);
  assert.equal(contactRows.rows[0].phone_verification_status, "pending_manual");
  assert.doesNotMatch(contactRows.rows[0].encrypted_value, new RegExp(mobile));

  const candidateRows = await runtime.tenantQuery(tenantA,
    "SELECT candidate_id FROM lead_candidates WHERE tenant_id=$1",
    [tenantA]
  );
  assert.equal(candidateRows.rowCount, 0, "格式有效的手机号应直接保存，不再进入OTP候选区");

  const directStore = createPostgresLeadStore({ postgres:runtime });
  await assert.rejects(
    () => directStore.upsert({
      tenantId:tenantA,
      identity:subject(),
      payload:{ session_id:`direct-${suffix}` },
      verification:{ verified:true },
      buildLead:() => ({})
    }),
    (error) => error?.code === "CONTACT_CAPTURE_REQUIRED"
  );

  const tenantBVisible = await runtime.tenantQuery(tenantB,
    "SELECT lead_id FROM leads WHERE tenant_id=$1",
    [tenantB]
  );
  assert.equal(tenantBVisible.rowCount, 0, "手机号线索必须tenant隔离");

  const eventText = JSON.stringify((await runtime.tenantQuery(tenantA,
    `SELECT details::text AS payload FROM audit_events WHERE tenant_id=$1
     UNION ALL
     SELECT payload::text AS payload FROM outbox_events WHERE tenant_id=$1`,
    [tenantA]
  )).rows);
  assert.doesNotMatch(eventText, new RegExp(mobile));
  assert.doesNotMatch(eventText, new RegExp(subject(), "i"));

  console.log("✓ PostgreSQL手机号格式校验即留资、待人工核号、密文保险库、同号归并与RLS通过");
} finally {
  try {
    await migrator.query("SET ROLE huamei_owner");
    await migrator.query("DELETE FROM tenants WHERE tenant_id = ANY($1::text[])", [[tenantA, tenantB]]);
  } catch {}
  await Promise.allSettled([runtime.close(), migrator.close()]);
}
