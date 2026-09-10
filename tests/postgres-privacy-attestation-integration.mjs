import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";

const runtimeUrl = String(process.env.HUAMEI_DATABASE_URL || "");
const migrationUrl = String(process.env.HUAMEI_MIGRATION_DATABASE_URL || "");
if (!runtimeUrl || !migrationUrl) {
  throw new Error("attestation集成测试需要HUAMEI_DATABASE_URL(runtime)和HUAMEI_MIGRATION_DATABASE_URL(migrator)");
}

const suffix = randomUUID().slice(0, 8);
const tenantA = `privacy-att-a-${suffix}`;
const tenantB = `privacy-att-b-${suffix}`;
const mobile = "13612345678";
const otherMobile = "13587654321";
const identitySecret = "privacy-pg-identity-A7d9K2m4P8q1R6t3V5x0ZcBn";
const completionSecret = "privacy-pg-completion-Q3w7E9r2T6y4U8i1O5p0AsDf";

process.env.HUAMEI_RUNTIME_ENV = "development";
process.env.HUAMEI_PERSISTENCE_BACKEND = "postgres";
process.env.HUAMEI_DATABASE_URL = runtimeUrl;
process.env.HUAMEI_IDENTITY_PEPPER = "privacy-pg-attestation-pepper-more-than-32-characters";
process.env.HUAMEI_PRIVACY_VERIFICATION_SECRET = identitySecret;
process.env.HUAMEI_PRIVACY_COMPLETION_SECRET = completionSecret;
process.env.HUAMEI_PRIVACY_CANCELLATION_SECRET = "privacy-pg-cancellation-C8v4B0n6M2q9W5e1R7t3";
process.env.HUAMEI_FIELD_ENCRYPTION_KEYRING_JSON = JSON.stringify({
  active_key_id:"privacy-attestation-v1",
  keys:{
    "privacy-attestation-v1":Buffer.from("0123456789abcdef0123456789ABCDEF").toString("base64")
  }
});

const { createPostgresClient, closePostgresClient } = await import("../server/platform/postgres.mjs");
const { issuePrivacyIdentityAttestation } = await import("../server/platform/privacy-identity-attestation.mjs");
const { issuePrivacyCompletionAttestation } = await import("../server/platform/privacy-completion-attestation.mjs");
const {
  createPrivacyRightsRequest,
  getPrivacyRightsRequest,
  privacySubjectReference,
  transitionPrivacyRightsRequest
} = await import("../server/privacy-rights-service.mjs");

const runtime = createPostgresClient({ connectionString:runtimeUrl, applicationName:"huamei-privacy-attestation-runtime" });
const migrator = createPostgresClient({ connectionString:migrationUrl, applicationName:"huamei-privacy-attestation-migrator" });
const processor = { subject:`processor-${suffix}`, roles:["privacy.processor"] };
const approver = { subject:`approver-${suffix}`, roles:["privacy.processor", "privacy.approver"] };
const subjectA = privacySubjectReference(mobile, tenantA);
const subjectB = privacySubjectReference(mobile, tenantB);
const otherSubjectA = privacySubjectReference(otherMobile, tenantA);

const createRequest = async (requestType = "access") => {
  const requestId = `dsr_${randomUUID()}`;
  await createPrivacyRightsRequest({
    tenant_id:tenantA,
    request_id:requestId,
    request_type:requestType,
    mobile,
    scope:{ categories:["conversation"] }
  }, { actor:"attestation-test-gateway", source:"signed_public_session" });
  return requestId;
};

const issueIdentity = (requestId, overrides = {}) => issuePrivacyIdentityAttestation({
  tenantId:tenantA,
  subjectReferenceHmac:subjectA,
  requestId,
  verificationId:`piv_${randomUUID()}`,
  method:"otp",
  ...overrides
});

const signRawIdentityClaims = (claims) => {
  const encoded = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  const signature = createHmac("sha256", identitySecret).update(encoded).digest("base64url");
  return `${encoded}.${signature}`;
};

const transitionToProcessing = (requestId, token) => transitionPrivacyRightsRequest({
  tenant_id:tenantA,
  request_id:requestId,
  status:"in_progress",
  ...(token ? { identity_verification_attestation:token } : {})
}, processor);

try {
  await migrator.transaction(async (client) => {
    await client.query("SET LOCAL ROLE huamei_owner");
    await client.query(
      `INSERT INTO tenants (tenant_id,display_name) VALUES ($1,$1),($2,$2)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantA, tenantB]
    );
  });

  const guardedRequest = await createRequest();
  await assert.rejects(
    () => transitionToProcessing(guardedRequest),
    (error) => error?.code === "PRIVACY_IDENTITY_ATTESTATION_REQUIRED"
  );
  await assert.rejects(
    () => transitionPrivacyRightsRequest({
      tenant_id:tenantA,
      request_id:guardedRequest,
      status:"in_progress",
      identity_evidence:{ status:"verified", method:"processor_checkbox" }
    }, processor),
    (error) => error?.code === "PRIVACY_IDENTITY_SELF_ASSERTION_FORBIDDEN"
  );
  await assert.rejects(
    () => transitionToProcessing(guardedRequest, `${issueIdentity(guardedRequest).slice(0, -1)}x`),
    (error) => error?.code === "PRIVACY_IDENTITY_ATTESTATION_INVALID"
  );
  await assert.rejects(
    () => transitionToProcessing(guardedRequest, issueIdentity(guardedRequest, { tenantId:tenantB, subjectReferenceHmac:subjectB })),
    (error) => error?.code === "PRIVACY_IDENTITY_ATTESTATION_INVALID"
  );
  const otherRequest = await createRequest();
  await assert.rejects(
    () => transitionToProcessing(guardedRequest, issueIdentity(otherRequest)),
    (error) => error?.code === "PRIVACY_IDENTITY_ATTESTATION_INVALID"
  );
  await assert.rejects(
    () => transitionToProcessing(guardedRequest, issueIdentity(guardedRequest, { subjectReferenceHmac:otherSubjectA })),
    (error) => error?.code === "PRIVACY_IDENTITY_ATTESTATION_SUBJECT_MISMATCH"
  );
  await assert.rejects(
    () => transitionToProcessing(guardedRequest, issueIdentity(guardedRequest, {
      verificationId:`piv_expired-${suffix}`,
      now:Date.now() - 120_000,
      ttlSeconds:30
    })),
    (error) => error?.code === "PRIVACY_IDENTITY_ATTESTATION_INVALID"
  );

  const nowSeconds = Math.floor(Date.now() / 1000);
  const unknownMethodToken = signRawIdentityClaims({
    schema:"huamei.privacy-identity-attestation.v1",
    tenant_id:tenantA,
    subject_reference_hmac:subjectA,
    request_id:guardedRequest,
    verification_id:`piv_unknown-${suffix}`,
    method:"processor_checkbox",
    issued_at:nowSeconds,
    expires_at:nowSeconds + 300
  });
  await assert.rejects(
    () => transitionToProcessing(guardedRequest, unknownMethodToken),
    (error) => error?.code === "PRIVACY_IDENTITY_ATTESTATION_INVALID"
  );

  const replayVerificationId = `piv_replay-${suffix}`;
  const processing = await transitionToProcessing(guardedRequest, issueIdentity(guardedRequest, {
    verificationId:replayVerificationId,
    method:"verified_channel"
  }));
  assert.equal(processing.status, "in_progress");
  assert.deepEqual(processing.identity_verification_metadata, {
    method:"verified_channel",
    verification_id:replayVerificationId,
    verified_at:processing.identity_verification_metadata.verified_at,
    verifier:"trusted_identity_adapter"
  });

  await assert.rejects(
    () => transitionToProcessing(otherRequest, issueIdentity(otherRequest, { verificationId:replayVerificationId })),
    (error) => error?.code === "PRIVACY_IDENTITY_ATTESTATION_REPLAYED"
  );

  const accessRequest = await createRequest("access");
  await transitionToProcessing(accessRequest, issueIdentity(accessRequest));
  await assert.rejects(
    () => transitionPrivacyRightsRequest({
      tenant_id:tenantA,
      request_id:accessRequest,
      status:"fulfilled",
      result:{ action_reference:`self-reported-${suffix}` }
    }, approver),
    (error) => error?.code === "PRIVACY_COMPLETION_ATTESTATION_REQUIRED"
  );
  const issueCompletion = (overrides = {}) => issuePrivacyCompletionAttestation({
    tenantId:tenantA,
    subjectReferenceHmac:subjectA,
    requestId:accessRequest,
    requestType:"access",
    evidenceId:`pce_${randomUUID()}`,
    actionReference:`delivery-${suffix}`,
    method:"secure_delivery",
    ...overrides
  });
  const tamperedCompletion = issueCompletion();
  await assert.rejects(
    () => transitionPrivacyRightsRequest({
      tenant_id:tenantA,
      request_id:accessRequest,
      status:"fulfilled",
      completion_attestation:`${tamperedCompletion.slice(0, -1)}x`
    }, approver),
    (error) => error?.code === "PRIVACY_COMPLETION_ATTESTATION_INVALID"
  );
  await assert.rejects(
    () => transitionPrivacyRightsRequest({
      tenant_id:tenantA,
      request_id:accessRequest,
      status:"fulfilled",
      completion_attestation:issueCompletion({ subjectReferenceHmac:otherSubjectA })
    }, approver),
    (error) => error?.code === "PRIVACY_COMPLETION_ATTESTATION_MISMATCH"
  );
  await assert.rejects(
    () => transitionPrivacyRightsRequest({
      tenant_id:tenantA,
      request_id:accessRequest,
      status:"fulfilled",
      completion_attestation:issueCompletion({ now:Date.now() - 120_000, completedAt:Date.now() - 120_000, ttlSeconds:30 })
    }, approver),
    (error) => error?.code === "PRIVACY_COMPLETION_ATTESTATION_INVALID"
  );
  const completionEvidenceId = `pce_access-${suffix}`;
  const completion = issueCompletion({
    evidenceId:completionEvidenceId,
    actionReference:`delivery-${suffix}`
  });
  await assert.rejects(
    () => transitionPrivacyRightsRequest({
      tenant_id:tenantA,
      request_id:accessRequest,
      status:"fulfilled",
      completion_attestation:completion,
      result:{ action_reference:`different-${suffix}` }
    }, approver),
    (error) => error?.code === "PRIVACY_COMPLETION_ACTION_REFERENCE_MISMATCH"
  );
  const fulfilled = await transitionPrivacyRightsRequest({
    tenant_id:tenantA,
    request_id:accessRequest,
    status:"fulfilled",
    completion_attestation:completion,
    result:{ action_reference:`delivery-${suffix}`, summary:"已通过受控渠道完成交付" }
  }, approver);
  assert.equal(fulfilled.status, "fulfilled");
  assert.equal(fulfilled.completion_verification_metadata.evidence_id, completionEvidenceId);
  assert.equal(fulfilled.result.action_reference, `delivery-${suffix}`);

  const replayCompletionRequest = await createRequest("access");
  await transitionToProcessing(replayCompletionRequest, issueIdentity(replayCompletionRequest));
  const replayCompletion = issuePrivacyCompletionAttestation({
    tenantId:tenantA,
    subjectReferenceHmac:subjectA,
    requestId:replayCompletionRequest,
    requestType:"access",
    evidenceId:completionEvidenceId,
    actionReference:`delivery-replay-${suffix}`,
    method:"secure_delivery"
  });
  await assert.rejects(
    () => transitionPrivacyRightsRequest({
      tenant_id:tenantA,
      request_id:replayCompletionRequest,
      status:"fulfilled",
      completion_attestation:replayCompletion,
      result:{ action_reference:`delivery-replay-${suffix}` }
    }, approver),
    (error) => error?.code === "PRIVACY_COMPLETION_ATTESTATION_REPLAYED"
  );

  const ledgerA = await runtime.tenantQuery(
    tenantA,
    `SELECT verification_id FROM privacy_identity_verifications
     WHERE tenant_id=$1 AND request_id=$2`,
    [tenantA, guardedRequest]
  );
  assert.deepEqual(ledgerA.rows.map((row) => row.verification_id), [replayVerificationId]);
  const ledgerB = await runtime.tenantQuery(
    tenantB,
    "SELECT verification_id FROM privacy_identity_verifications WHERE tenant_id=$1",
    [tenantB]
  );
  assert.equal(ledgerB.rowCount, 0, "其他租户不得看到attestation防重放账本");

  const stored = await runtime.tenantQuery(
    tenantA,
    `SELECT row_to_json(r)::text AS document,
       coalesce((SELECT string_agg(a.details::text,' ') FROM audit_events a WHERE a.tenant_id=$1), '') AS audit_text,
       coalesce((SELECT string_agg(o.payload::text,' ') FROM outbox_events o WHERE o.tenant_id=$1), '') AS outbox_text
     FROM data_subject_requests r WHERE r.tenant_id=$1 AND r.request_id=$2`,
    [tenantA, guardedRequest]
  );
  for (const forbidden of [mobile, identitySecret, completionSecret, replayVerificationId]) {
    assert.equal(`${stored.rows[0].document} ${stored.rows[0].audit_text} ${stored.rows[0].outbox_text}`.includes(forbidden), false);
  }
  assert.equal(`${stored.rows[0].audit_text} ${stored.rows[0].outbox_text}`.includes(subjectA), false);
  assert.equal((await getPrivacyRightsRequest(tenantA, guardedRequest)).identity_verification, "verified");

  console.log("✓ PostgreSQL DSR可信身份与执行/交付attestation绑定、防重放、租户隔离及任意完成声明拒绝通过");
} finally {
  await Promise.allSettled([runtime.close(), migrator.close(), closePostgresClient()]);
}
