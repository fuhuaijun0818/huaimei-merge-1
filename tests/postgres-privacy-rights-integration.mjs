import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";

const runtimeUrl = String(process.env.HUAMEI_DATABASE_URL || "");
const migrationUrl = String(process.env.HUAMEI_MIGRATION_DATABASE_URL || "");
if (!runtimeUrl || !migrationUrl) {
  throw new Error("个人信息权利集成测试需要HUAMEI_DATABASE_URL(runtime)和HUAMEI_MIGRATION_DATABASE_URL(migrator)");
}

process.env.HUAMEI_PERSISTENCE_BACKEND = "postgres";
process.env.HUAMEI_IDENTITY_PEPPER ||= "privacy-integration-pepper-2026-more-than-32-characters";
process.env.HUAMEI_PRIVACY_VERIFICATION_SECRET ||= "privacy-integration-attestation-Q7w2E9r4T6y8U1i3O5p0";
process.env.HUAMEI_PRIVACY_COMPLETION_SECRET ||= "privacy-completion-integration-R4nD0m8V2k6P1s9Q3w7E5";
process.env.HUAMEI_PRIVACY_CANCELLATION_SECRET ||= "privacy-cancellation-integration-C8v4B0n6M2q9W5e1R7t3";

const suffix = randomUUID().slice(0, 8);
const tenantA = `privacy-a-${suffix}`;
const tenantB = `privacy-b-${suffix}`;
const mobile = "13912345678";
const requestId = `dsr_${randomUUID()}`;

const { createPostgresClient, closePostgresClient } = await import("../server/platform/postgres.mjs");
const { issuePrivacyIdentityAttestation } = await import("../server/platform/privacy-identity-attestation.mjs");
const { issuePrivacyCompletionAttestation } = await import("../server/platform/privacy-completion-attestation.mjs");
const { issuePrivacyCancellationAttestation } = await import("../server/platform/privacy-cancellation-attestation.mjs");
const {
  createPrivacyRightsRequest,
  getPrivacyRightsRequest,
  listPrivacyRightsRequests,
  privacySubjectReference,
  transitionPrivacyRightsRequest
} = await import("../server/privacy-rights-service.mjs");

const runtime = createPostgresClient({ connectionString:runtimeUrl, applicationName:"huamei-privacy-it-runtime" });
const migrator = createPostgresClient({ connectionString:migrationUrl, applicationName:"huamei-privacy-it-migrator" });

try {
  await migrator.transaction(async (client) => {
    await client.query("SET LOCAL ROLE huamei_owner");
    await client.query(
      `INSERT INTO tenants (tenant_id,display_name) VALUES ($1,$1),($2,$2)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantA, tenantB]
    );
  });

  assert.notEqual(
    privacySubjectReference(mobile, tenantA),
    privacySubjectReference(mobile, tenantB),
    "同一手机号必须按租户生成不同不可逆引用"
  );

  const created = await createPrivacyRightsRequest({
    tenant_id:tenantA,
    request_id:requestId,
    request_type:"correct",
    mobile,
    scope:{ categories:["会话", "线索档案"], note:"申请删除本人在线咨询资料" }
  }, { actor:"web_gateway", source:"signed_public_session", slaHours:72 });
  assert.deepEqual(created, {
    request_id:requestId,
    request_type:"correct",
    receipt_status:"accepted"
  });
  const createdDetail = await getPrivacyRightsRequest(tenantA, requestId);
  assert.equal(createdDetail.status, "identity_pending");
  assert.equal(createdDetail.request_type, "correct");
  assert.equal(createdDetail.identity_verification, "pending");
  assert.ok(new Date(createdDetail.due_at) > new Date(createdDetail.created_at));

  const replay = await createPrivacyRightsRequest({
    tenant_id:tenantA,
    request_id:requestId,
    request_type:"correct",
    mobile,
    scope:{ categories:["线索档案", "会话"], note:"申请删除本人在线咨询资料" }
  }, { actor:"web_gateway", source:"signed_public_session", slaHours:72 });
  assert.deepEqual(replay, created, "范围集合顺序不影响规范化幂等回执");
  assert.equal((await listPrivacyRightsRequests(tenantA)).length, 1, "同一request_id重放不得重复建单");

  await assert.rejects(
    () => createPrivacyRightsRequest({
      tenant_id:tenantA,
      request_id:requestId,
      request_type:"correct",
      mobile,
      scope:{ categories:["会话", "线索档案"], note:"改变后的范围" }
    }, { actor:"web_gateway", source:"signed_public_session" }),
    (error) => error?.code === "PRIVACY_REQUEST_IDEMPOTENCY_CONFLICT" && error?.status === 409
  );
  await assert.rejects(
    () => createPrivacyRightsRequest({
      tenant_id:tenantA,
      request_id:requestId,
      request_type:"correct",
      mobile,
      scope:{ categories:["会话", "线索档案"], note:"申请删除本人在线咨询资料" }
    }, { actor:"web_gateway", source:"different_source_contract" }),
    (error) => error?.code === "PRIVACY_REQUEST_IDEMPOTENCY_CONFLICT" && error?.status === 409
  );

  await assert.rejects(
    () => createPrivacyRightsRequest({
      tenant_id:tenantA,
      request_id:requestId,
      request_type:"correct",
      mobile:"13800001234"
    }, { actor:"web_gateway" }),
    (error) => error?.code === "PRIVACY_REQUEST_IDEMPOTENCY_CONFLICT" && error?.status === 409
  );

  assert.equal(await getPrivacyRightsRequest(tenantB, requestId), null, "其他租户不可读取请求");
  await assert.rejects(
    () => transitionPrivacyRightsRequest({
      tenant_id:tenantA,
      request_id:requestId,
      status:"in_progress"
    }, { subject:"privacy-operator", roles:["privacy.processor"] }),
    (error) => error?.code === "PRIVACY_IDENTITY_ATTESTATION_REQUIRED"
  );

  await assert.rejects(
    () => transitionPrivacyRightsRequest({
      tenant_id:tenantA,
      request_id:requestId,
      status:"in_progress",
      identity_evidence:{ status:"verified", method:"verified_callback" }
    }, { subject:"privacy-operator", roles:["privacy.processor"] }),
    (error) => error?.code === "PRIVACY_IDENTITY_SELF_ASSERTION_FORBIDDEN"
  );

  const identityAttestation = issuePrivacyIdentityAttestation({
    tenantId:tenantA,
    subjectReferenceHmac:privacySubjectReference(mobile, tenantA),
    requestId,
    verificationId:`privacy-rights-${suffix}`,
    method:"verified_callback"
  });

  const processing = await transitionPrivacyRightsRequest({
    tenant_id:tenantA,
    request_id:requestId,
    status:"in_progress",
    identity_verification_attestation:identityAttestation
  }, { subject:"privacy-operator", roles:["privacy.processor"] });
  assert.equal(processing.status, "in_progress");
  assert.equal(processing.identity_verification, "verified");
  assert.deepEqual(processing.identity_verification_metadata, {
    method:"verified_callback",
    verification_id:`privacy-rights-${suffix}`,
    verified_at:processing.identity_verification_metadata.verified_at,
    verifier:"trusted_identity_adapter"
  });
  assert.ok(new Date(processing.identity_verification_metadata.verified_at).getTime() > 0);

  await assert.rejects(
    () => transitionPrivacyRightsRequest({
      tenant_id:tenantA,
      request_id:requestId,
      status:"fulfilled",
      result:{ action_reference:`erase-job-${suffix}`, summary:"已执行经批准的匿名化处理" }
    }, { subject:"privacy-operator", roles:["privacy.processor"] }),
    (error) => error?.code === "PRIVACY_APPROVER_REQUIRED" && error?.status === 403
  );

  await assert.rejects(
    () => transitionPrivacyRightsRequest({
      tenant_id:tenantA,
      request_id:requestId,
      status:"fulfilled",
      result:{ action_reference:`erase-job-${suffix}`, summary:"处理人自报已完成" }
    }, { subject:"privacy-approver", roles:["privacy.processor", "privacy.approver"] }),
    (error) => error?.code === "PRIVACY_COMPLETION_ATTESTATION_REQUIRED"
  );

  const completionAttestation = issuePrivacyCompletionAttestation({
    tenantId:tenantA,
    subjectReferenceHmac:privacySubjectReference(mobile, tenantA),
    requestId,
    requestType:"correct",
    evidenceId:`pce-correct-${suffix}`,
    actionReference:`erase-job-${suffix}`,
    method:"authoritative_correction"
  });

  const fulfilled = await transitionPrivacyRightsRequest({
    tenant_id:tenantA,
    request_id:requestId,
    status:"fulfilled",
    completion_attestation:completionAttestation,
    result:{ action_reference:`erase-job-${suffix}`, summary:"已执行经批准的匿名化处理" }
  }, { subject:"privacy-approver", roles:["privacy.processor", "privacy.approver"] });
  assert.equal(fulfilled.status, "fulfilled");
  assert.ok(fulfilled.completed_at);
  assert.equal(fulfilled.completion_verification_metadata.evidence_id, `pce-correct-${suffix}`);
  assert.equal(fulfilled.completion_verification_metadata.method, "authoritative_correction");

  const cancellationRequestId = `dsr_${randomUUID()}`;
  const cancellationVerificationId = `privacy-cancel-${suffix}`;
  await createPrivacyRightsRequest({
    tenant_id:tenantA,
    request_id:cancellationRequestId,
    request_type:"access",
    mobile,
    scope:{ categories:["会话"] }
  }, { actor:"web_gateway", source:"signed_public_session" });
  await transitionPrivacyRightsRequest({
    tenant_id:tenantA,
    request_id:cancellationRequestId,
    status:"in_progress",
    identity_verification_attestation:issuePrivacyIdentityAttestation({
      tenantId:tenantA,
      subjectReferenceHmac:privacySubjectReference(mobile, tenantA),
      requestId:cancellationRequestId,
      verificationId:cancellationVerificationId,
      method:"verified_channel"
    })
  }, { subject:"privacy-cancel-verifier", roles:["privacy.processor"] });
  const cancellationId = `pca-${suffix}`;
  const cancellationReferenceId = `withdrawal:${suffix}`;
  const cancellationRecordedAt = Math.floor(Date.now() / 1_000) * 1_000;
  const cancellationAttestation = issuePrivacyCancellationAttestation({
    tenantId:tenantA,
    subjectReferenceHmac:privacySubjectReference(mobile, tenantA),
    requestId:cancellationRequestId,
    identityVerificationId:cancellationVerificationId,
    cancellationId,
    referenceId:cancellationReferenceId,
    recordedAt:cancellationRecordedAt
  });
  const expectedCancellationBasis = {
    source:"verified_subject_withdrawal",
    reason_code:"subject_withdrew_request",
    cancellation_id:cancellationId,
    reference_id:cancellationReferenceId,
    identity_verification_id:cancellationVerificationId,
    recorded_at:new Date(cancellationRecordedAt).toISOString()
  };
  await assert.rejects(
    () => transitionPrivacyRightsRequest({
      tenant_id:tenantA,
      request_id:cancellationRequestId,
      status:"cancelled",
      cancellation_attestation:cancellationAttestation
    }, { subject:"processor-only", roles:["privacy.processor"] }),
    (error) => error?.code === "PRIVACY_APPROVER_REQUIRED" && error?.status === 403
  );
  await assert.rejects(
    () => transitionPrivacyRightsRequest({
      tenant_id:tenantA,
      request_id:cancellationRequestId,
      status:"cancelled",
      cancellation_attestation:cancellationAttestation
    }, { subject:"privacy-cancel-verifier", roles:["privacy.processor", "privacy.approver"] }),
    (error) => error?.code === "PRIVACY_SEPARATION_OF_DUTIES_REQUIRED" && error?.status === 403
  );
  await assert.rejects(
    () => transitionPrivacyRightsRequest({
      tenant_id:tenantA,
      request_id:cancellationRequestId,
      status:"cancelled",
      cancellation_basis:expectedCancellationBasis
    }, { subject:"privacy-cancel-approver", roles:["privacy.processor", "privacy.approver"] }),
    (error) => error?.code === "PRIVACY_CANCELLATION_SELF_ASSERTION_FORBIDDEN" && error?.status === 409
  );
  await assert.rejects(
    () => transitionPrivacyRightsRequest({
      tenant_id:tenantA,
      request_id:cancellationRequestId,
      status:"cancelled"
    }, { subject:"privacy-cancel-approver", roles:["privacy.processor", "privacy.approver"] }),
    (error) => error?.code === "PRIVACY_CANCELLATION_ATTESTATION_REQUIRED" && error?.status === 409
  );
  await assert.rejects(
    () => transitionPrivacyRightsRequest({
      tenant_id:tenantA,
      request_id:cancellationRequestId,
      status:"cancelled",
      cancellation_attestation:`${cancellationAttestation.slice(0, -1)}x`
    }, { subject:"privacy-cancel-approver", roles:["privacy.processor", "privacy.approver"] }),
    (error) => error?.code === "PRIVACY_CANCELLATION_ATTESTATION_INVALID" && error?.status === 409
  );
  await assert.rejects(
    () => transitionPrivacyRightsRequest({
      tenant_id:tenantA,
      request_id:cancellationRequestId,
      status:"cancelled",
      cancellation_attestation:issuePrivacyCancellationAttestation({
        tenantId:tenantA,
        subjectReferenceHmac:privacySubjectReference("13800001234", tenantA),
        requestId:cancellationRequestId,
        identityVerificationId:cancellationVerificationId,
        cancellationId:`pca-wrong-subject-${suffix}`,
        referenceId:`withdrawal-wrong-subject:${suffix}`
      })
    }, { subject:"privacy-cancel-approver", roles:["privacy.processor", "privacy.approver"] }),
    (error) => error?.code === "PRIVACY_CANCELLATION_ATTESTATION_MISMATCH" && error?.status === 409
  );
  await assert.rejects(
    () => transitionPrivacyRightsRequest({
      tenant_id:tenantA,
      request_id:cancellationRequestId,
      status:"cancelled",
      cancellation_attestation:issuePrivacyCancellationAttestation({
        tenantId:tenantA,
        subjectReferenceHmac:privacySubjectReference(mobile, tenantA),
        requestId:cancellationRequestId,
        identityVerificationId:`privacy-other-${suffix}`,
        cancellationId:`pca-wrong-verification-${suffix}`,
        referenceId:`withdrawal-wrong-verification:${suffix}`
      })
    }, { subject:"privacy-cancel-approver", roles:["privacy.processor", "privacy.approver"] }),
    (error) => error?.code === "PRIVACY_CANCELLATION_ATTESTATION_MISMATCH" && error?.status === 409
  );
  const cancelled = await transitionPrivacyRightsRequest({
    tenant_id:tenantA,
    request_id:cancellationRequestId,
    status:"cancelled",
    cancellation_attestation:cancellationAttestation
  }, { subject:"privacy-cancel-approver", roles:["privacy.processor", "privacy.approver"] });
  assert.equal(cancelled.status, "cancelled");
  assert.deepEqual(cancelled.result.cancellation_basis, expectedCancellationBasis);
  const cancellationAuditBeforeReplay = await runtime.tenantQuery(
    tenantA,
    "SELECT count(*)::int AS count FROM audit_events WHERE tenant_id=$1 AND resource_id=$2 AND action='privacy.request.cancelled'",
    [tenantA, cancellationRequestId]
  );
  const cancelledReplay = await transitionPrivacyRightsRequest({
    tenant_id:tenantA,
    request_id:cancellationRequestId,
    status:"cancelled",
    cancellation_attestation:cancellationAttestation
  }, { subject:"privacy-cancel-approver", roles:["privacy.processor", "privacy.approver"] });
  assert.equal(cancelledReplay.completed_at, cancelled.completed_at);
  const cancellationAuditAfterReplay = await runtime.tenantQuery(
    tenantA,
    "SELECT count(*)::int AS count FROM audit_events WHERE tenant_id=$1 AND resource_id=$2 AND action='privacy.request.cancelled'",
    [tenantA, cancellationRequestId]
  );
  assert.equal(cancellationAuditBeforeReplay.rows[0].count, 1);
  assert.equal(cancellationAuditAfterReplay.rows[0].count, 1, "合法取消重放不得重复写审计");
  await assert.rejects(
    () => transitionPrivacyRightsRequest({
      tenant_id:tenantA,
      request_id:cancellationRequestId,
      status:"cancelled",
      cancellation_attestation:issuePrivacyCancellationAttestation({
        tenantId:tenantA,
        subjectReferenceHmac:privacySubjectReference(mobile, tenantA),
        requestId:cancellationRequestId,
        identityVerificationId:cancellationVerificationId,
        cancellationId:`pca-changed-${suffix}`,
        referenceId:`withdrawal-changed:${suffix}`,
        recordedAt:cancellationRecordedAt
      })
    }, { subject:"privacy-cancel-approver", roles:["privacy.processor", "privacy.approver"] }),
    (error) => error?.code === "PRIVACY_CANCELLATION_IDEMPOTENCY_CONFLICT" && error?.status === 409
  );

  const evidence = await runtime.tenantQuery(
    tenantA,
    `SELECT
       row_to_json(r)::text AS request_json,
       (SELECT count(*)::int FROM audit_events WHERE tenant_id=$1 AND resource_id=$2) AS audit_count,
       (SELECT count(*)::int FROM outbox_events WHERE tenant_id=$1 AND aggregate_id=$2) AS outbox_count
     FROM data_subject_requests r
     WHERE r.tenant_id=$1 AND r.request_id=$2`,
    [tenantA, requestId]
  );
  assert.equal(evidence.rowCount, 1);
  assert.equal(evidence.rows[0].request_json.includes(mobile), false, "数据权利工单不得保存明文手机号");
  assert.equal(evidence.rows[0].audit_count, 3, "接收、处理、完成必须形成不可变审计");
  assert.equal(evidence.rows[0].outbox_count, 3, "接收、处理、完成必须形成可靠事件");

  console.log(`✓ PostgreSQL个人信息权利建单、租户隔离、身份核验、双角色复核、幂等与审计通过（${requestId}）`);
} finally {
  await migrator.transaction(async (client) => {
    await client.query("SET LOCAL ROLE huamei_owner");
    await client.query("DELETE FROM tenants WHERE tenant_id = ANY($1::text[])", [[tenantA, tenantB]]);
  }).catch(() => {});
  await Promise.allSettled([runtime.close(), migrator.close(), closePostgresClient()]);
}
