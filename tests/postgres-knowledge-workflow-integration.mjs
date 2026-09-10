import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const runtimeUrl = String(process.env.HUAMEI_DATABASE_URL || "");
const migrationUrl = String(process.env.HUAMEI_MIGRATION_DATABASE_URL || "");
if (!runtimeUrl || !migrationUrl) {
  throw new Error("知识三审集成测试需要runtime和migrator PostgreSQL URL");
}

const { createPostgresClient } = await import("../server/platform/postgres.mjs");
const { createPostgresKnowledgeReleaseStore } = await import("../server/persistence/postgres-knowledge-release-store.mjs");
const { configuredKnowledgeReleaseTenants } = await import("../server/knowledge-release-policy.mjs");
const runtime = createPostgresClient({ connectionString:runtimeUrl, applicationName:"huamei-knowledge-runtime-test" });
const migrator = createPostgresClient({ connectionString:migrationUrl, applicationName:"huamei-knowledge-migrator-test" });
const suffix = randomUUID().slice(0, 8);
const tenantId = `knowledge-${suffix}`;
const otherTenant = `knowledge-other-${suffix}`;
const lazyTenant = `knowledge-lazy-${suffix}`;
const releaseId = `krel_${randomUUID()}`;
const packageChecksum = "a".repeat(64);
const recordListChecksum = "b".repeat(64);
const indexChecksum = "c".repeat(64);
const indexVersion = `official-${suffix}`;
const store = createPostgresKnowledgeReleaseStore({ postgres:runtime });

const identity = (subject, role) => ({
  subject,
  roles:[role],
  tenantIds:[tenantId],
  issuer:"https://identity.huamei.test",
  tokenId:`token-${subject}`,
  authenticatedAt:new Date().toISOString()
});

try {
  await migrator.query("SET ROLE huamei_owner");
  await migrator.query(
    `INSERT INTO tenants (tenant_id,display_name) VALUES ($1,$1),($2,$2),($3,$3)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId, otherTenant, lazyTenant]
  );

  const draft = await store.createDraft({
    release:{
      id:releaseId,
      tenant_id:tenantId,
      package_version:`package-${suffix}`,
      package_checksum:packageChecksum,
      record_list_checksum:recordListChecksum,
      index_version:indexVersion,
      approved_record_ids:["KB-001", "KB-002"],
      effective_at:new Date().toISOString(),
      expires_at:null,
      manifest:{ schema_version:"huamei.knowledge.release-draft.v1" }
    },
    actor:"release-manager"
  });
  assert.equal(draft.status, "reviewing");
  const scope = await store.getReviewScope({ tenantId, releaseId });
  assert.match(scope.scope_checksum, /^[0-9a-f]{64}$/);

  await assert.rejects(
    () => store.submitReview({
      tenantId, releaseId, reviewType:"business", decision:"approved",
      identity:identity("reviewer-business", "knowledge.business_reviewer"),
      scopeChecksum:"f".repeat(64)
    }),
    (error) => error?.code === "23514"
  );

  const businessIdentity = identity("reviewer-business", "knowledge.business_reviewer");
  const business = await store.submitReview({
    tenantId, releaseId, reviewType:"business", decision:"approved",
    identity:businessIdentity, scopeChecksum:scope.scope_checksum
  });
  const businessReplay = await store.submitReview({
    tenantId, releaseId, reviewType:"business", decision:"approved",
    identity:businessIdentity, scopeChecksum:scope.scope_checksum
  });
  assert.equal(businessReplay.review_id, business.review_id, "同一实名审核重试必须幂等");

  await assert.rejects(
    () => store.submitReview({
      tenantId, releaseId, reviewType:"medical", decision:"approved",
      identity:identity("reviewer-business", "knowledge.medical_reviewer"),
      scopeChecksum:scope.scope_checksum
    }),
    (error) => error?.code === "23514"
  );

  for (const reviewType of ["medical", "compliance"]) {
    await store.submitReview({
      tenantId, releaseId, reviewType, decision:"approved",
      identity:identity(`reviewer-${reviewType}`, `knowledge.${reviewType}_reviewer`),
      scopeChecksum:scope.scope_checksum
    });
  }
  const receipt = await store.releaseReceipt({ tenantId, releaseId });
  assert.deepEqual(Object.keys(receipt.approvals).sort(), ["business", "compliance", "medical"]);
  assert.equal(new Set(Object.values(receipt.approvals).map((item) => item.review_id)).size, 3);

  const manifest = {
    schema_version:"huamei.graphrag.index-manifest.v1",
    index_version:indexVersion,
    manifest_sha256:indexChecksum,
    release_binding:{ ...receipt, approval_receipt_sha256:"d".repeat(64) }
  };
  await assert.rejects(
    () => store.attachIndex({
      tenantId, releaseId, indexChecksum,
      manifest:{ ...manifest, index_version:"wrong-version" }, actor:"index-manager"
    }),
    (error) => error?.code === "23514"
  );
  await store.attachIndex({ tenantId, releaseId, indexChecksum, manifest, actor:"index-manager" });

  await assert.rejects(
    () => runtime.tenantQuery(tenantId,
      "UPDATE knowledge_releases SET status='active',is_active=true WHERE tenant_id=$1 AND release_id=$2",
      [tenantId, releaseId]
    ),
    (error) => error?.code === "42501",
    "runtime role不得绕过受控激活函数直接更新知识release"
  );

  const active = await store.activate({
    tenantId, releaseId, identity:identity("publisher", "knowledge.publisher")
  });
  assert.equal(active.status, "active");
  assert.equal(active.manifest.index_version, indexVersion);
  assert.equal(active.reviews.business.id, receipt.approvals.business.review_id);

  const refreshCounts = new Map();
  const restartedStore = createPostgresKnowledgeReleaseStore({
    postgres:{
      tenantQuery:async (refreshTenantId, ...args) => {
        refreshCounts.set(refreshTenantId, (refreshCounts.get(refreshTenantId) || 0) + 1);
        return runtime.tenantQuery(refreshTenantId, ...args);
      }
    }
  });
  const startupTenants = configuredKnowledgeReleaseTenants({
    HUAMEI_RELEASE_TENANT_IDS:tenantId,
    HUAMEI_CONVERSATION_RECOVERY_TENANT_IDS:otherTenant
  }, [{ caller_id:"enterprise-wechat", tenant_ids:[otherTenant] }]);
  assert.deepEqual(startupTenants, [tenantId, otherTenant]);
  assert.equal(restartedStore.status(tenantId).initialized, false, "重启后的进程不得假装已有租户缓存");
  await Promise.all(startupTenants.map((startupTenantId) => restartedStore.ensureFresh(startupTenantId, { ttlMs:60_000 })));
  assert.equal(restartedStore.status(tenantId).initialized, true);
  assert.equal(restartedStore.status(otherTenant).initialized, true);
  assert.equal(restartedStore.list(tenantId)[0]?.id, releaseId, "启动刷新必须恢复租户自己的active release");
  assert.deepEqual(restartedStore.list(otherTenant), [], "无release租户不得复用其他租户缓存");

  await Promise.all([
    restartedStore.ensureFresh(lazyTenant, { ttlMs:60_000 }),
    restartedStore.ensureFresh(lazyTenant, { ttlMs:60_000 }),
    restartedStore.ensureFresh(lazyTenant, { ttlMs:60_000 })
  ]);
  assert.equal(refreshCounts.get(lazyTenant), 1, "同一新租户的并发首次请求必须合并为一次刷新");
  assert.deepEqual(restartedStore.list(lazyTenant), [], "lazy refresh不得泄露其他租户release");
  await restartedStore.ensureFresh(lazyTenant, { ttlMs:60_000 });
  assert.equal(refreshCounts.get(lazyTenant), 1, "TTL内不得重复刷新");
  await restartedStore.ensureFresh(lazyTenant, { ttlMs:60_000, now:Date.now() + 60_001 });
  assert.equal(refreshCounts.get(lazyTenant), 2, "TTL到期后必须重新刷新当前租户");

  const invisible = await store.releaseReceipt({ tenantId:otherTenant, releaseId }).then(() => false, (error) => error.code === "KNOWLEDGE_RELEASE_NOT_FOUND");
  assert.equal(invisible, true, "其他租户不得读取审批回执");

  const evidence = await runtime.tenantQuery(tenantId,
    `SELECT
       (SELECT count(*)::int FROM knowledge_reviews WHERE tenant_id=$1) AS reviews,
       (SELECT count(*)::int FROM audit_events WHERE tenant_id=$1 AND action='knowledge.review.recorded') AS review_audits,
       (SELECT count(*)::int FROM outbox_events WHERE tenant_id=$1 AND event_type='knowledge.review.recorded') AS review_events`,
    [tenantId]
  );
  assert.deepEqual(evidence.rows[0], { reviews:3, review_audits:3, review_events:3 });
  console.log("✓ PostgreSQL实名三审、不同人约束、范围绑定、索引绑定、受控激活与跨租户隔离通过");
} finally {
  try {
    await migrator.query("SET ROLE huamei_owner");
    await migrator.query("DELETE FROM tenants WHERE tenant_id = ANY($1::text[])", [[tenantId, otherTenant, lazyTenant]]);
  } catch {}
  await Promise.allSettled([runtime.close(), migrator.close()]);
}
