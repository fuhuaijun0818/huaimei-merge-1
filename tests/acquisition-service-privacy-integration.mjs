import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const runtimeUrl = String(process.env.HUAMEI_DATABASE_URL || "");
const migrationUrl = String(process.env.HUAMEI_MIGRATION_DATABASE_URL || "");
if (!runtimeUrl || !migrationUrl) {
  throw new Error("隐私HTTP集成测试需要HUAMEI_DATABASE_URL(runtime)和HUAMEI_MIGRATION_DATABASE_URL(migrator)");
}

const suffix = randomUUID().slice(0, 8);
const tenantId = `privacy-http-${suffix}`;
const otherTenantId = `privacy-other-${suffix}`;
const callerSecret = "privacy_gateway_A7d9K2m4P8q1R6t3V5x0ZcBnHyLuEeW";
const processorSecret = "privacy_admin_Q3w7E9r2T6y4U8i1O5p0AsDfGhJkLzX";
const mobile = "13712345678";

process.env.HUAMEI_RUNTIME_ENV = "development";
process.env.HUAMEI_PERSISTENCE_BACKEND = "postgres";
process.env.HUAMEI_DATABASE_URL = runtimeUrl;
process.env.HUAMEI_CACHE_BACKEND = "memory";
process.env.HUAMEI_DEFAULT_TENANT_ID = tenantId;
process.env.HUAMEI_IDENTITY_PEPPER = "privacy-http-integration-pepper-2026-more-than-32-characters";
process.env.HUAMEI_PRIVACY_VERIFICATION_SECRET = "privacy-http-identity-Q7w2E9r4T6y8U1i3O5p0AsDf";
process.env.HUAMEI_PRIVACY_COMPLETION_SECRET = "privacy-http-completion-R4nD0m8V2k6P1s9Q3w7E5t";
process.env.HUAMEI_PRIVACY_CANCELLATION_SECRET = "privacy-http-cancellation-C8v4B0n6M2q9W5e1R7t3Y";
process.env.HUAMEI_ACQUISITION_CLIENTS_JSON = JSON.stringify({
  privacy_gateway:{
    secret:callerSecret,
    tenant_ids:[tenantId],
    permissions:["service:read", "privacy:request"]
  },
  privacy_admin:{
    secret:processorSecret,
    tenant_ids:[tenantId],
    permissions:["service:read", "privacy:read", "privacy:process"]
  }
});

const { createPostgresClient, closePostgresClient } = await import("../server/platform/postgres.mjs");
const { issuePrivacyIdentityAttestation } = await import("../server/platform/privacy-identity-attestation.mjs");
const { issuePrivacyCompletionAttestation } = await import("../server/platform/privacy-completion-attestation.mjs");
const { privacySubjectReference } = await import("../server/privacy-rights-service.mjs");
const migrator = createPostgresClient({ connectionString:migrationUrl, applicationName:"huamei-privacy-http-migrator" });
const runtime = createPostgresClient({ connectionString:runtimeUrl, applicationName:"huamei-privacy-http-runtime" });

await migrator.transaction(async (client) => {
  await client.query("SET LOCAL ROLE huamei_owner");
  await client.query(
    `INSERT INTO tenants (tenant_id,display_name) VALUES ($1,$1),($2,$2)
     ON CONFLICT (tenant_id) DO NOTHING`,
    [tenantId, otherTenantId]
  );
});

const oidcVerifier = {
  async verifyAuthorizationHeader(header, requirements = {}) {
    const token = String(header || "").replace(/^Bearer\s+/i, "");
    if (!token) {
      const error = new Error("token missing");
      error.code = "OIDC_TOKEN_MISSING";
      error.status = 401;
      throw error;
    }
    const roles = token === "approver"
      ? ["privacy.processor", "privacy.approver"]
      : token === "processor"
        ? ["privacy.processor"]
        : [];
    if (!roles.length) {
      const error = new Error("role forbidden");
      error.code = "OIDC_ROLE_FORBIDDEN";
      error.status = 403;
      throw error;
    }
    if (requirements.tenantId !== tenantId) {
      const error = new Error("tenant forbidden");
      error.code = "OIDC_TENANT_FORBIDDEN";
      error.status = 403;
      throw error;
    }
    return {
      subject:`privacy-${token}`,
      roles,
      tenantIds:[tenantId],
      issuer:"https://identity.integration.test",
      tokenId:`token-${token}`
    };
  }
};

const { createAcquisitionServiceServer } = await import("../server/acquisition-service-server.mjs");
const server = createAcquisitionServiceServer({ host:"127.0.0.1", oidcVerifier });
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const callerHeaders = (callerId, secret, extra = {}) => ({
  "Content-Type":"application/json",
  "X-Caller-Id":callerId,
  "X-Service-Key":secret,
  "X-Tenant-Id":tenantId,
  ...extra
});
const requestJson = async (path, options = {}) => {
  const response = await fetch(`${baseUrl}${path}`, options);
  return { response, body:await response.json() };
};

try {
  const requestId = `dsr_${randomUUID()}`;
  const created = await requestJson("/v1/privacy/requests", {
    method:"POST",
    headers:callerHeaders("privacy_gateway", callerSecret),
    body:JSON.stringify({
      tenant_id:tenantId,
      request_id:requestId,
      request_type:"access",
      mobile,
      scope:{ categories:["会话", "授权", "线索"] }
    })
  });
  assert.equal(created.response.status, 202);
  assert.deepEqual(created.body.data, {
    request_id:requestId,
    request_type:"access",
    receipt_status:"accepted"
  });

  const crossTenant = await requestJson("/v1/privacy/requests", {
    method:"POST",
    headers:callerHeaders("privacy_gateway", callerSecret),
    body:JSON.stringify({ tenant_id:otherTenantId, request_type:"delete", mobile })
  });
  assert.equal(crossTenant.response.status, 403);
  assert.equal(crossTenant.body.error.code, "TENANT_CONTEXT_MISMATCH");

  const unauthenticatedList = await requestJson(`/v1/privacy/requests?tenant_id=${tenantId}`, {
    headers:callerHeaders("privacy_admin", processorSecret)
  });
  assert.equal(unauthenticatedList.response.status, 401);

  const listed = await requestJson(`/v1/privacy/requests?tenant_id=${tenantId}`, {
    headers:callerHeaders("privacy_admin", processorSecret, { Authorization:"Bearer processor" })
  });
  assert.equal(listed.response.status, 200);
  assert.equal(listed.body.data.length, 1);

  const processing = await requestJson(`/v1/privacy/requests/${requestId}/transition`, {
    method:"POST",
    headers:callerHeaders("privacy_admin", processorSecret, { Authorization:"Bearer processor" }),
    body:JSON.stringify({
      tenant_id:tenantId,
      status:"in_progress",
      identity_verification_attestation:issuePrivacyIdentityAttestation({
        tenantId,
        subjectReferenceHmac:privacySubjectReference(mobile, tenantId),
        requestId,
        verificationId:`privacy-http-${suffix}`,
        method:"verified_callback"
      })
    })
  });
  assert.equal(processing.response.status, 200);
  assert.equal(processing.body.data.status, "in_progress");

  const processorCannotFinish = await requestJson(`/v1/privacy/requests/${requestId}/transition`, {
    method:"POST",
    headers:callerHeaders("privacy_admin", processorSecret, { Authorization:"Bearer processor" }),
    body:JSON.stringify({ tenant_id:tenantId, status:"fulfilled", result:{ action_reference:`export-${suffix}` } })
  });
  assert.equal(processorCannotFinish.response.status, 403);
  assert.equal(processorCannotFinish.body.error.code, "PRIVACY_APPROVER_REQUIRED");

  const arbitraryCompletion = await requestJson(`/v1/privacy/requests/${requestId}/transition`, {
    method:"POST",
    headers:callerHeaders("privacy_admin", processorSecret, { Authorization:"Bearer approver" }),
    body:JSON.stringify({
      tenant_id:tenantId,
      status:"fulfilled",
      result:{ action_reference:`export-${suffix}`, summary:"未经可信交付适配器核验" }
    })
  });
  assert.equal(arbitraryCompletion.response.status, 409);
  assert.equal(arbitraryCompletion.body.error.code, "PRIVACY_COMPLETION_ATTESTATION_REQUIRED");

  const completionAttestation = issuePrivacyCompletionAttestation({
    tenantId,
    subjectReferenceHmac:privacySubjectReference(mobile, tenantId),
    requestId,
    requestType:"access",
    evidenceId:`privacy-http-delivery-${suffix}`,
    actionReference:`export-${suffix}`,
    method:"secure_delivery"
  });

  const finished = await requestJson(`/v1/privacy/requests/${requestId}/transition`, {
    method:"POST",
    headers:callerHeaders("privacy_admin", processorSecret, { Authorization:"Bearer approver" }),
    body:JSON.stringify({
      tenant_id:tenantId,
      status:"fulfilled",
      completion_attestation:completionAttestation,
      result:{ action_reference:`export-${suffix}`, summary:"已通过受控渠道交付导出结果" }
    })
  });
  assert.equal(finished.response.status, 200);
  assert.equal(finished.body.data.status, "fulfilled");
  assert.equal(finished.body.data.completion_verification_metadata.evidence_id, `privacy-http-delivery-${suffix}`);

  const writeOnlyReplay = await requestJson("/v1/privacy/requests", {
    method:"POST",
    headers:callerHeaders("privacy_gateway", callerSecret),
    body:JSON.stringify({
      tenant_id:tenantId,
      request_id:requestId,
      request_type:"access",
      mobile,
      scope:{ categories:["授权", "会话", "线索"] }
    })
  });
  assert.equal(writeOnlyReplay.response.status, 202);
  assert.deepEqual(writeOnlyReplay.body.data, created.body.data, "完成后重放仍只能得到固定最小回执");
  for (const forbidden of [
    "scope", "result", "status", "identity_verification", "identity_verification_metadata",
    "completion_verification_metadata", "completed_at", "created_by", "id"
  ]) {
    assert.equal(Object.hasOwn(writeOnlyReplay.body.data, forbidden), false, `最小回执不得包含 ${forbidden}`);
  }

  const changedScopeReplay = await requestJson("/v1/privacy/requests", {
    method:"POST",
    headers:callerHeaders("privacy_gateway", callerSecret),
    body:JSON.stringify({
      tenant_id:tenantId,
      request_id:requestId,
      request_type:"access",
      mobile,
      scope:{ categories:["会话", "授权", "线索", "新范围"] }
    })
  });
  assert.equal(changedScopeReplay.response.status, 409);
  assert.equal(changedScopeReplay.body.error.code, "PRIVACY_REQUEST_IDEMPOTENCY_CONFLICT");

  const wrongSubjectReplay = await requestJson("/v1/privacy/requests", {
    method:"POST",
    headers:callerHeaders("privacy_gateway", callerSecret),
    body:JSON.stringify({
      tenant_id:tenantId,
      request_id:requestId,
      request_type:"access",
      mobile:"13800001234",
      scope:{ categories:["会话", "授权", "线索"] }
    })
  });
  assert.equal(wrongSubjectReplay.response.status, 409);
  assert.equal(wrongSubjectReplay.body.error.code, "PRIVACY_REQUEST_IDEMPOTENCY_CONFLICT");

  const wrongTypeReplay = await requestJson("/v1/privacy/requests", {
    method:"POST",
    headers:callerHeaders("privacy_gateway", callerSecret),
    body:JSON.stringify({
      tenant_id:tenantId,
      request_id:requestId,
      request_type:"correct",
      mobile,
      scope:{ categories:["会话", "授权", "线索"] }
    })
  });
  assert.equal(wrongTypeReplay.response.status, 409);
  assert.equal(wrongTypeReplay.body.error.code, "PRIVACY_REQUEST_IDEMPOTENCY_CONFLICT");

  const writeOnlyDetail = await requestJson(`/v1/privacy/requests/${requestId}?tenant_id=${tenantId}`, {
    headers:callerHeaders("privacy_gateway", callerSecret)
  });
  assert.equal(writeOnlyDetail.response.status, 403, "仅privacy:request的网关不得读取工单详情");

  const authorizedDetail = await requestJson(`/v1/privacy/requests/${requestId}?tenant_id=${tenantId}`, {
    headers:callerHeaders("privacy_admin", processorSecret, { Authorization:"Bearer processor" })
  });
  assert.equal(authorizedDetail.response.status, 200);
  assert.equal(authorizedDetail.body.data.status, "fulfilled");
  assert.deepEqual(authorizedDetail.body.data.scope.categories, ["会话", "授权", "线索"]);
  assert.equal(authorizedDetail.body.data.result.action_reference, `export-${suffix}`);

  const stored = await runtime.tenantQuery(
    tenantId,
    "SELECT row_to_json(r)::text AS document FROM data_subject_requests r WHERE tenant_id=$1 AND request_id=$2",
    [tenantId, requestId]
  );
  assert.equal(stored.rows[0].document.includes(mobile), false);
  console.log(`✓ 个人信息权利HTTP建单、OIDC实名处理、双角色复核、跨租户拒绝与明文不落库通过（${requestId}）`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await migrator.transaction(async (client) => {
    await client.query("SET LOCAL ROLE huamei_owner");
    await client.query("DELETE FROM tenants WHERE tenant_id = ANY($1::text[])", [[tenantId, otherTenantId]]);
  }).catch(() => {});
  await Promise.allSettled([runtime.close(), migrator.close(), closePostgresClient()]);
}
