import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const runtimeUrl = String(process.env.HUAMEI_DATABASE_URL || "");
const migrationUrl = String(process.env.HUAMEI_MIGRATION_DATABASE_URL || "");
if (!runtimeUrl || !migrationUrl || process.env.HUAMEI_PERSISTENCE_BACKEND !== "postgres") {
  throw new Error("知识审核 HTTP 集成测试需要隔离 PostgreSQL runtime/migrator 配置");
}

const suffix = randomUUID().slice(0, 8);
const tenantId = `knowledge-http-${suffix}`;
const rejectedReleaseId = `krel_rejected_${suffix}`;
const revisedReleaseId = `krel_revised_${suffix}`;
const checksum = (character) => character.repeat(64);

// The service under test is the real HTTP application.  The verifier only
// supplies signed-enterprise identity claims; it never bypasses the service's
// role, tenant, immutable-review, or database checks.
process.env.HUAMEI_ACQUISITION_CLIENTS_JSON = "";
process.env.HUAMEI_DEFAULT_TENANT_ID = tenantId;
process.env.HUAMEI_PUBLIC_TENANT_ID = tenantId;
process.env.HUAMEI_LLM_ENABLED = "false";
process.env.HUAMEI_GRAPHRAG_ENABLED = "false";

const { createPostgresClient } = await import("../server/platform/postgres.mjs");
const { createAcquisitionServiceServer } = await import("../server/acquisition-service-server.mjs");
const runtime = createPostgresClient({ connectionString:runtimeUrl, applicationName:"huamei-knowledge-review-http-runtime" });
const migrator = createPostgresClient({ connectionString:migrationUrl, applicationName:"huamei-knowledge-review-http-migrator" });

const claims = {
  "release-manager":["knowledge.release_manager"],
  "business-reviewer":["knowledge.business_reviewer"],
  "medical-reviewer":["knowledge.medical_reviewer"],
  "compliance-reviewer":["knowledge.compliance_reviewer"],
  "receipt-reader":["knowledge.index_manager"],
  "content-user":["内容专员"],
  "super-reviewer":["超级管理员"]
};
const oidcVerifier = {
  async verifyAuthorizationHeader(header, requirements = {}) {
    const token = String(header || "").replace(/^Bearer\s+/i, "");
    if (!claims[token]) {
      const error = new Error("test token missing");
      error.code = "OIDC_TOKEN_INVALID";
      error.status = 401;
      throw error;
    }
    return {
      subject:token,
      roles:claims[token],
      tenantIds:[requirements.tenantId || tenantId],
      issuer:"https://identity.integration.test",
      tokenId:`token-${token}`,
      authenticatedAt:new Date().toISOString()
    };
  }
};
const server = createAcquisitionServiceServer({ host:"127.0.0.1", oidcVerifier });
server.keepAliveTimeout = 1;

const draftPayload = ({ releaseId, packageChecksum, recordListChecksum, version }) => ({
  tenant_id:tenantId,
  release_id:releaseId,
  package_version:version,
  package_checksum:packageChecksum,
  record_list_checksum:recordListChecksum,
  index_version:`index-${suffix}`,
  approved_record_ids:["KB-REVIEW-001", "KB-REVIEW-002"]
});

try {
  await migrator.query("SET ROLE huamei_owner");
  await migrator.query("INSERT INTO tenants (tenant_id,display_name) VALUES ($1,$1) ON CONFLICT (tenant_id) DO NOTHING", [tenantId]);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const request = async (token, path, { method = "GET", body } = {}) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers:{
        Authorization:`Bearer ${token}`,
        "X-Caller-Id":"knowledge-http-integration",
        ...(body ? { "Content-Type":"application/json" } : {})
      },
      ...(body ? { body:JSON.stringify(body) } : {})
    });
    return { response, payload:await response.json() };
  };

  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200, "actual acquisition HTTP service must start");
  const openApi = await (await fetch(`${baseUrl}/openapi.json`)).json();
  const reviewSchema = openApi.paths["/v1/knowledge/releases/{releaseId}/reviews/{reviewType}"].post
    .requestBody.content["application/json"].schema;
  assert.deepEqual(reviewSchema.required, ["decision", "scope_checksum", "comments"]);
  assert.equal(reviewSchema.properties.comments.minLength, 1);

  let result = await request("release-manager", "/v1/knowledge/releases/drafts", {
    method:"POST",
    body:draftPayload({ releaseId:rejectedReleaseId, packageChecksum:checksum("a"), recordListChecksum:checksum("b"), version:"revision-1" })
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.payload.data.status, "reviewing");

  result = await request("super-reviewer", `/v1/knowledge/releases/${rejectedReleaseId}/review-scope`);
  assert.equal(result.response.status, 200);
  const rejectedScope = result.payload.data.scope_checksum;

  result = await request("business-reviewer", `/v1/knowledge/releases/${rejectedReleaseId}/reviews/business`, {
    method:"POST",
    body:{ tenant_id:tenantId, decision:"rejected", comments:"发现未经确认的效果承诺，退回修订。", scope_checksum:rejectedScope }
  });
  assert.equal(result.response.status, 201);
  assert.equal(result.payload.data.release.status, "rejected");

  // A rejected immutable release cannot be signed again.  A changed document
  // must be represented by a new package/version and receive fresh reviews.
  result = await request("business-reviewer", `/v1/knowledge/releases/${rejectedReleaseId}/reviews/business`, {
    method:"POST",
    body:{ tenant_id:tenantId, decision:"approved", comments:"不能覆盖原驳回记录。", scope_checksum:rejectedScope }
  });
  assert.equal(result.response.status, 409);

  result = await request("release-manager", "/v1/knowledge/releases/drafts", {
    method:"POST",
    body:draftPayload({ releaseId:revisedReleaseId, packageChecksum:checksum("c"), recordListChecksum:checksum("d"), version:"revision-2" })
  });
  assert.equal(result.response.status, 201);

  result = await request("super-reviewer", `/v1/knowledge/releases/${revisedReleaseId}/review-scope`);
  assert.equal(result.response.status, 200);
  const revisedScope = result.payload.data.scope_checksum;
  assert.notEqual(revisedScope, rejectedScope, "修订内容必须产生新的审核范围指纹");

  result = await request("business-reviewer", `/v1/knowledge/releases/${revisedReleaseId}/reviews/business`, {
    method:"POST",
    body:{ tenant_id:tenantId, decision:"approved", comments:"旧范围不得迁移到修订版。", scope_checksum:rejectedScope }
  });
  assert.equal(result.response.status, 400);
  assert.equal(result.payload.error.code, "23514");

  result = await request("content-user", `/v1/knowledge/releases/${revisedReleaseId}/reviews/business`, {
    method:"POST",
    body:{ tenant_id:tenantId, decision:"approved", comments:"内容专员不得代签。", scope_checksum:revisedScope }
  });
  assert.equal(result.response.status, 403);
  assert.equal(result.payload.error.code, "OIDC_ROLE_FORBIDDEN");

  // A superadministrator can exercise its explicit in-tenant review scope,
  // but its decision is still a normal immutable, attributable audit event.
  result = await request("super-reviewer", `/v1/knowledge/releases/${revisedReleaseId}/reviews/business`, {
    method:"POST",
    body:{ tenant_id:tenantId, decision:"approved", comments:"修订范围与业务公开边界已核对。", scope_checksum:revisedScope }
  });
  assert.equal(result.response.status, 201);
  for (const [token, reviewType] of [["medical-reviewer", "medical"], ["compliance-reviewer", "compliance"]]) {
    result = await request(token, `/v1/knowledge/releases/${revisedReleaseId}/reviews/${reviewType}`, {
      method:"POST",
      body:{ tenant_id:tenantId, decision:"approved", comments:`${reviewType}修订版审核通过。`, scope_checksum:revisedScope }
    });
    assert.equal(result.response.status, 201);
  }

  result = await request("receipt-reader", `/v1/knowledge/releases/${revisedReleaseId}/receipt?tenant_id=${tenantId}`);
  assert.equal(result.response.status, 200);
  assert.deepEqual(Object.keys(result.payload.data.approvals).sort(), ["business", "compliance", "medical"]);
  assert.deepEqual(result.payload.data.approvals.business, {
    status:"approved",
    review_id:result.payload.data.approvals.business.review_id,
    reviewer_id:"super-reviewer",
    reason:"修订范围与业务公开边界已核对。",
    reviewed_at:result.payload.data.approvals.business.reviewed_at
  });
  assert.ok(Date.parse(result.payload.data.approvals.business.reviewed_at));

  const audit = await runtime.tenantQuery(tenantId,
    "SELECT actor_id, action, details FROM audit_events WHERE tenant_id=$1 AND resource_id=$2 AND action='knowledge.review.recorded' ORDER BY created_at",
    [tenantId, revisedReleaseId]
  );
  assert.equal(audit.rows.length, 3);
  assert.equal(audit.rows[0].actor_id, "super-reviewer");
  assert.equal(audit.rows[0].action, "knowledge.review.recorded");
  console.log("✓ 真实知识服务HTTP三审：版本指纹、理由留痕、驳回修订重审、越权拒绝及超级管理员审计通过");
} finally {
  const serverClosed = new Promise((resolve) => server.close(resolve));
  server.closeIdleConnections?.();
  server.closeAllConnections?.();
  await serverClosed;
  await runtime.close();
  await migrator.close();
}
