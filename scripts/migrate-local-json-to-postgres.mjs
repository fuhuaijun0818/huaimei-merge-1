import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

import { createPostgresClient } from "../server/platform/postgres.mjs";
import { createFieldEncryption, createFieldRecordId } from "../server/platform/field-encryption.mjs";
import { ensureTenant } from "../server/persistence/postgres-helpers.mjs";
import { normalizeTenantId } from "../server/platform/tenant-context.mjs";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const apply = process.argv.includes("--apply");
const sourceArgument = process.argv.find((item) => item.startsWith("--source="));
const sourceRootValue = sourceArgument ? sourceArgument.slice("--source=".length) : ".local-data";
const sourceRoot = isAbsolute(sourceRootValue) ? sourceRootValue : join(projectRoot, sourceRootValue);
const tenantArgument = process.argv.find((item) => item.startsWith("--tenant="));
const defaultTenant = normalizeTenantId(tenantArgument?.slice("--tenant=".length));
if (apply && !tenantArgument) {
  const error = new Error("--apply必须显式指定 --tenant=<approved-tenant-id>");
  error.code = "MIGRATION_TARGET_TENANT_REQUIRED";
  throw error;
}
const sourceFiles = {
  sessions:"acquisition-sessions.json",
  leads:"acquisition-leads.json",
  operations:"acquisition-operations.json",
  releases:"knowledge-releases.json"
};

const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const readOptionalJson = async (name) => {
  try {
    const raw = await readFile(join(sourceRoot, name), "utf8");
    return { raw, data:JSON.parse(raw) };
  } catch (error) {
    if (error.code === "ENOENT") return { raw:"", data:null };
    throw error;
  }
};

const sources = Object.fromEntries(await Promise.all(
  Object.entries(sourceFiles).map(async ([type, name]) => [type, { name, ...(await readOptionalJson(name)) }])
));
if (!Object.values(sources).some((source) => source.data)) throw new Error(`没有在 ${sourceRoot} 找到可迁移JSON`);

const sourceManifest = Object.fromEntries(Object.entries(sources).map(([type, source]) => [type, {
  file:source.name,
  present:Boolean(source.data),
  bytes:Buffer.byteLength(source.raw),
  checksum:source.raw ? sha256(source.raw) : null
}]));
const sourceChecksum = sha256(JSON.stringify(sourceManifest));
const batchId = `local-json-${sourceChecksum.slice(0, 20)}`;
const sessions = Object.entries(sources.sessions.data?.sessions || {});
const leads = Array.isArray(sources.leads.data?.leads) ? sources.leads.data.leads : [];
const handovers = Array.isArray(sources.operations.data?.handovers) ? sources.operations.data.handovers : [];
const workLogs = Array.isArray(sources.operations.data?.human_work_logs) ? sources.operations.data.human_work_logs : [];
const releases = Array.isArray(sources.releases.data?.releases) ? sources.releases.data.releases : [];
const legacyConsentClaimsCount = leads.reduce((total, sourceLead) => {
  const customer = sourceLead?.customer || {};
  return total
    + (typeof customer.serviceConsent === "boolean" ? 1 : 0)
    + (typeof customer.marketingConsent === "boolean" ? 1 : 0);
}, 0);

if (apply) {
  for (const [sourceSessionId] of sessions) {
    const sourceTenant = sourceSessionId.split(":")[0] || "";
    if (!/^[a-z0-9][a-z0-9_-]{2,63}$/.test(sourceTenant) || sourceTenant !== defaultTenant) {
      const error = new Error("单一受控迁移批次中的session租户必须与--tenant一致");
      error.code = "MIGRATION_SESSION_TENANT_MISMATCH";
      throw error;
    }
  }
  for (const sourceLead of leads) {
    if (sourceLead.tenant_id && normalizeTenantId(sourceLead.tenant_id) !== defaultTenant) {
      const error = new Error("单一受控迁移批次中的lead租户必须与--tenant一致");
      error.code = "MIGRATION_LEAD_TENANT_MISMATCH";
      throw error;
    }
  }
}

const counts = {
  sessions:sessions.length,
  leads:leads.length,
  handovers:handovers.length,
  human_work_logs:workLogs.length,
  releases:releases.length
};

const rawHasPlaintextMobile = Object.values(sources).some((source) => /(^|\D)1[3-9]\d{9}(\D|$)/.test(source.raw));
if (rawHasPlaintextMobile) {
  const error = new Error("源JSON中发现疑似明文手机号；请先在隔离环境完成脱敏，不允许直接迁移");
  error.code = "PLAINTEXT_MOBILE_IN_SOURCE";
  throw error;
}

if (!apply) {
  console.log(JSON.stringify({
    status:"dry_run",
    source_root:sourceRoot,
    batch_id:batchId,
    source_checksum:sourceChecksum,
    manifest:sourceManifest,
    counts,
    legacy_consent_flags_detected:legacyConsentClaimsCount,
    legacy_consent_policy:"preserve_as_unverified_encrypted_profile_metadata_and_require_fresh_consent",
    plaintext_mobile_detected:false,
    next:"复核后使用同一环境执行 --apply；脚本按batch_id幂等。"
  }, null, 2));
  process.exit(0);
}

const migrationDatabaseUrl = String(process.env.HUAMEI_MIGRATION_DATABASE_URL || "").trim();
if (!migrationDatabaseUrl) {
  const error = new Error("--apply必须由Secret Manager注入HUAMEI_MIGRATION_DATABASE_URL");
  error.code = "MIGRATION_DATABASE_URL_REQUIRED";
  throw error;
}
const database = createPostgresClient({
  connectionString:migrationDatabaseUrl,
  applicationName:"huamei-local-json-migration"
});
const fieldEncryption = createFieldEncryption({ env:process.env });
const sessionStateContext = (tenantId, channel, sessionId) => ({
  tenantId,
  scope:"conversation.session.state",
  recordId:createFieldRecordId("conversation.session", { channel, session_id:sessionId }),
  legacyRecordId:`${channel}:${sessionId}`
});
const leadProfileContext = (tenantId, identity) => ({
  tenantId,
  scope:"lead.profile",
  recordId:identity
});
const now = new Date().toISOString();
const resultCounts = {
  sessions:0,
  leads:0,
  consents:0,
  legacy_consent_flags_not_promoted:0,
  handovers:0,
  human_work_logs:0,
  releases:0
};

try {
  const result = await database.transaction(async (client) => {
    await client.query("SET LOCAL ROLE huamei_owner");
    const identity = await client.query("SELECT current_user, session_user");
    if (identity.rows[0]?.current_user !== "huamei_owner" || identity.rows[0]?.session_user !== "huamei_migrator") {
      const error = new Error("迁移必须通过huamei_migrator登录并显式切换到huamei_owner");
      error.code = "MIGRATION_ROLE_SEPARATION_REQUIRED";
      throw error;
    }
    await ensureTenant(client, defaultTenant);
    const existingBatch = await client.query(
      `SELECT status, counts, validation FROM data_migration_batches
       WHERE tenant_id=$1 AND batch_id=$2 FOR UPDATE`,
      [defaultTenant, batchId]
    );
    if (existingBatch.rows[0]?.status === "completed") {
      return { replay:true, counts:existingBatch.rows[0].counts, validation:existingBatch.rows[0].validation };
    }
    await client.query(
      `INSERT INTO data_migration_batches
        (tenant_id, batch_id, source_type, source_checksum, status, manifest,
         counts, validation, started_at, created_by)
       VALUES ($1,$2,'local_json',$3,'cutover',$4::jsonb,$5::jsonb,'{}'::jsonb,$6,'migration-runner')
       ON CONFLICT (tenant_id,batch_id)
       DO UPDATE SET status='cutover', started_at=COALESCE(data_migration_batches.started_at,EXCLUDED.started_at)`,
      [defaultTenant, batchId, sourceChecksum, JSON.stringify(sourceManifest), JSON.stringify(counts), now]
    );

    for (const [sourceSessionId, state] of sessions) {
      const parts = sourceSessionId.split(":");
      const tenantId = /^[a-z0-9][a-z0-9_-]{2,63}$/.test(parts[0] || "") ? parts[0] : defaultTenant;
      const channel = parts[1] || "web";
      await ensureTenant(client, tenantId);
      await client.query(
        `INSERT INTO conversation_sessions
          (tenant_id, session_id, channel, state, started_at, last_activity_at, expires_at)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)
         ON CONFLICT (tenant_id,channel,session_id)
         DO UPDATE SET state=EXCLUDED.state,
           last_activity_at=GREATEST(conversation_sessions.last_activity_at,EXCLUDED.last_activity_at),
           expires_at=EXCLUDED.expires_at`,
        [tenantId, sourceSessionId, channel, JSON.stringify(fieldEncryption.encryptJson(
          state || {},
          sessionStateContext(tenantId, channel, sourceSessionId)
        )),
          new Date(Number(state?.createdAt) || Date.now()).toISOString(),
          new Date(Number(state?.updatedAt) || Date.now()).toISOString(),
          new Date((Number(state?.updatedAt) || Date.now()) + 30 * 60_000).toISOString()]
      );
      resultCounts.sessions += 1;
    }

    for (const sourceLead of leads) {
      const tenantId = normalizeTenantId(sourceLead.tenant_id, defaultTenant);
      const customer = sourceLead.customer || {};
      const identity = String(sourceLead.phone_hash || "").toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(identity)) {
        const error = new Error(`线索 ${customer.id || "unknown"} 缺少有效phone_hash`);
        error.code = "LEAD_PHONE_HASH_INVALID";
        throw error;
      }
      await ensureTenant(client, tenantId);
      const {
        serviceConsent:legacyServiceConsent,
        marketingConsent:legacyMarketingConsent,
        ...customerWithoutLegacyConsent
      } = customer;
      const legacyConsentClaims = [
        ["service", legacyServiceConsent],
        ["marketing", legacyMarketingConsent]
      ].filter(([, value]) => typeof value === "boolean").map(([consentType, originalAsserted]) => ({
        consent_type:consentType,
        original_asserted:originalAsserted,
        usable_as_consent:false,
        requires_fresh_consent:true,
        status:"unverified_legacy_claim_not_promoted",
        reason:"missing_policy_version_timestamp_source_and_verifiable_evidence",
        migration_batch_id:batchId
      }));
      const document = {
        ...sourceLead,
        tenant_id:tenantId,
        phone_hash:undefined,
        customer:customerWithoutLegacyConsent,
        migration_annotations:{
          ...(sourceLead.migration_annotations || {}),
          legacy_consent_claims:legacyConsentClaims
        }
      };
      const encryptedProfile = fieldEncryption.encryptJson(
        { _document:document },
        leadProfileContext(tenantId, identity)
      );
      await client.query(
        `INSERT INTO leads
          (tenant_id,lead_id,customer_id,normalized_mobile_hmac,masked_mobile,display_name,
           source_channel,macro_stage,micro_stage,primary_interest,interests,profile,
           first_seen_at,last_seen_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13,$14)
         ON CONFLICT (tenant_id,normalized_mobile_hmac) WHERE normalized_mobile_hmac IS NOT NULL
         DO UPDATE SET profile=EXCLUDED.profile,last_seen_at=EXCLUDED.last_seen_at,
           display_name=EXCLUDED.display_name,interests=EXCLUDED.interests,
           primary_interest=EXCLUDED.primary_interest
         RETURNING id`,
        [tenantId, customer.id, customer.id, identity, customer.mobile || null,
          fieldEncryption.enabled ? null : customer.name || null,
          customer.firstChannel || "web", customer.macroStage || "售前", customer.microStage || "新咨询",
          fieldEncryption.enabled ? null : customer.interests?.[0]?.name || null,
          JSON.stringify(fieldEncryption.enabled ? [] : customer.interests || []),
          JSON.stringify(encryptedProfile), sourceLead.created_at || now, sourceLead.updated_at || now]
      );
      resultCounts.leads += 1;
      resultCounts.legacy_consent_flags_not_promoted += legacyConsentClaims.length;
    }

    if (handovers.length || workLogs.length || releases.length) {
      const error = new Error("源文件包含operations或knowledge release；请使用运行手册的受控专用批次迁移，禁止在缺少关联校验时自动导入");
      error.code = "CONTROLLED_MIGRATION_REQUIRED";
      throw error;
    }

    const validation = {
      source_counts:counts,
      inserted_or_updated:resultCounts,
      plaintext_mobile_detected:false,
      field_encryption:fieldEncryption.enabled ? "aes-256-gcm" : "development-plaintext",
      execution_identity:{
        current_user:identity.rows[0].current_user,
        session_user:identity.rows[0].session_user
      },
      source_checksum:sourceChecksum,
      legacy_consent_handling:{
        promoted_to_current_consent:0,
        flags_preserved_as_unverified_encrypted_profile_metadata:resultCounts.legacy_consent_flags_not_promoted,
        fresh_consent_required:true
      },
      validated_at:new Date().toISOString()
    };
    await client.query(
      `UPDATE data_migration_batches
       SET status='completed', counts=$3::jsonb, validation=$4::jsonb, completed_at=clock_timestamp()
       WHERE tenant_id=$1 AND batch_id=$2`,
      [defaultTenant, batchId, JSON.stringify(resultCounts), JSON.stringify(validation)]
    );
    await client.query(
      `INSERT INTO audit_events
        (tenant_id,event_id,actor_type,actor_id,action,resource_type,resource_id,outcome,details)
       VALUES ($1,$2,'service','migration-runner','data_migration.completed','migration_batch',$3,'success',$4::jsonb)
       ON CONFLICT (tenant_id,event_id) DO NOTHING`,
      [defaultTenant, `migration:${batchId}`, batchId, JSON.stringify(validation)]
    );
    return { replay:false, counts:resultCounts, validation };
  });
  console.log(JSON.stringify({
    status:"ok",
    mode:"apply",
    batch_id:batchId,
    source_checksum:sourceChecksum,
    ...result
  }, null, 2));
} catch (error) {
  console.error(JSON.stringify({ status:"error", code:error.code || "LOCAL_JSON_MIGRATION_FAILED", message:error.message }, null, 2));
  process.exitCode = 1;
} finally {
  await database.close();
}
