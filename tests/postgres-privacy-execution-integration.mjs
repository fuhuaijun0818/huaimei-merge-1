import assert from "node:assert/strict";
import { createHash, randomBytes, randomUUID } from "node:crypto";

const runtimeUrl = String(process.env.HUAMEI_DATABASE_URL || "");
const migrationUrl = String(process.env.HUAMEI_MIGRATION_DATABASE_URL || "");
if (!runtimeUrl || !migrationUrl) {
  throw new Error("隐私执行集成测试需要HUAMEI_DATABASE_URL(runtime)和HUAMEI_MIGRATION_DATABASE_URL(migrator)");
}

const suffix = randomUUID().slice(0, 8);
const tenantA = `privacy-exec-a-${suffix}`;
const tenantB = `privacy-exec-b-${suffix}`;
const mobile = "13987654321";
const secrets = {
  scope:"仅限本人的私密咨询范围",
  identity:`verified-ticket-private-${suffix}`,
  result:"只能通过本人线下领取的结果说明",
  consent:`consent-private-${suffix}`
};
const oldKey = randomBytes(32).toString("base64");
const newKey = randomBytes(32).toString("base64");
const oldKeyring = JSON.stringify({ active_key_id:"privacy-old", keys:{ "privacy-old":oldKey } });
const currentKeyring = JSON.stringify({
  active_key_id:"privacy-new",
  keys:{ "privacy-old":oldKey, "privacy-new":newKey }
});
const gatewaySecret = `privacy_gateway_${randomBytes(32).toString("base64url")}`;
const adminSecret = `privacy_admin_${randomBytes(32).toString("base64url")}`;
const readerSecret = `privacy_reader_${randomBytes(32).toString("base64url")}`;

process.env.HUAMEI_RUNTIME_ENV = "development";
process.env.HUAMEI_PERSISTENCE_BACKEND = "postgres";
process.env.HUAMEI_DATABASE_URL = runtimeUrl;
process.env.HUAMEI_CACHE_BACKEND ||= "memory";
process.env.HUAMEI_DEFAULT_TENANT_ID = tenantA;
process.env.HUAMEI_IDENTITY_PEPPER = "privacy-execution-integration-pepper-more-than-32-chars";
process.env.HUAMEI_PRIVACY_VERIFICATION_SECRET = "privacy-execution-identity-Q7w2E9r4T6y8U1i3O5p0";
process.env.HUAMEI_PRIVACY_COMPLETION_SECRET = "privacy-execution-completion-R4nD0m8V2k6P1s9Q3w7E5";
process.env.HUAMEI_PRIVACY_CANCELLATION_SECRET = "privacy-execution-cancellation-C8v4B0n6M2q9W5e1R7t3";
process.env.HUAMEI_FIELD_ENCRYPTION_KEYRING_JSON = currentKeyring;
process.env.HUAMEI_CONTACT_VAULT_KEYRING_JSON = JSON.stringify({
  active_key_id:"privacy-contact-v1",
  keys:{ "privacy-contact-v1":randomBytes(32).toString("base64") }
});
process.env.HUAMEI_ACQUISITION_CLIENTS_JSON = JSON.stringify({
  privacy_gateway:{
    secret:gatewaySecret,
    tenant_ids:[tenantA],
    permissions:["service:read", "privacy:request"]
  },
  privacy_admin:{
    secret:adminSecret,
    tenant_ids:[tenantA],
    permissions:["service:read", "privacy:read", "privacy:process"]
  },
  privacy_reader:{
    secret:readerSecret,
    tenant_ids:[tenantA],
    permissions:["service:read", "privacy:read"]
  }
});

const { createFieldEncryption, createFieldRecordId } = await import("../server/platform/field-encryption.mjs");
const { createPostgresClient, closePostgresClient } = await import("../server/platform/postgres.mjs");
const { closeRedisClient } = await import("../server/platform/redis.mjs");
const { createPostgresPrivacyRequestStore } = await import("../server/persistence/postgres-privacy-request-store.mjs");
const { createPostgresOperationsStore } = await import("../server/persistence/postgres-operations-store.mjs");
const { issuePrivacyIdentityAttestation } = await import("../server/platform/privacy-identity-attestation.mjs");
const { issuePrivacyCompletionAttestation } = await import("../server/platform/privacy-completion-attestation.mjs");
const { upsertAcquisitionLead } = await import("../server/lead-store.mjs");
const {
  approvePrivacyRightsExecution,
  createPrivacyRightsRequest,
  getPrivacyRightsExecution,
  getPrivacyRightsRequest,
  isPrivacyContactSuppressed,
  preparePrivacyRightsExecution,
  privacySubjectReference,
  transitionPrivacyRightsRequest
} = await import("../server/privacy-rights-service.mjs");

const runtime = createPostgresClient({ connectionString:runtimeUrl, applicationName:"huamei-privacy-exec-runtime" });
const migrator = createPostgresClient({ connectionString:migrationUrl, applicationName:"huamei-privacy-exec-migrator" });
const encryption = createFieldEncryption({ keyringJson:currentKeyring, production:true });
const oldEncryption = createFieldEncryption({ keyringJson:oldKeyring, production:true });
const operations = createPostgresOperationsStore({ postgres:runtime, fieldEncryption:encryption });
const subjectReference = privacySubjectReference(mobile, tenantA);
const processor = { subject:`processor-${suffix}`, roles:["privacy.processor"] };
const approver = { subject:`approver-${suffix}`, roles:["privacy.approver"] };
const sameActorApprover = { subject:processor.subject, roles:["privacy.processor", "privacy.approver"] };

const privacyFieldContext = (requestId, field, tenantId = tenantA) => ({
  tenantId,
  scope:`privacy.request.${field}`,
  recordId:requestId
});
const consentEvidenceContext = (consentType, evidenceHash) => ({
  tenantId:tenantA,
  scope:"lead.consent.evidence",
  recordId:createFieldRecordId("lead.consent", {
    consent_type:consentType,
    evidence_hash:evidenceHash,
    subject_reference_hmac:subjectReference
  }),
  legacyRecordId:`${subjectReference}:${consentType}:${evidenceHash}`
});

const createAndVerify = async (requestType, purposes = [], note = "", requestMobile = mobile) => {
  const requestId = `dsr_${randomUUID()}`;
  await createPrivacyRightsRequest({
    tenant_id:tenantA,
    request_id:requestId,
    request_type:requestType,
    mobile:requestMobile,
    scope:{ purposes, note }
  }, { actor:"privacy-test-gateway", source:"signed_test_session" });
  await transitionPrivacyRightsRequest({
    tenant_id:tenantA,
    request_id:requestId,
    status:"in_progress",
    identity_verification_attestation:issuePrivacyIdentityAttestation({
      tenantId:tenantA,
      subjectReferenceHmac:privacySubjectReference(requestMobile, tenantA),
      requestId,
      verificationId:`privacy-execution-${randomUUID()}`,
      method:"verified_callback"
    })
  }, processor);
  return requestId;
};

const captureLead = (leadMobile, leadSessionId, marketingConsent = false) => upsertAcquisitionLead({
  tenant_id:tenantA,
  session_id:leadSessionId,
  channel:"web",
  mobile:leadMobile,
  name:`隐私门禁测试${leadMobile.slice(-4)}`,
  service_consent:true,
  marketing_consent:marketingConsent,
  interests:["隐私门禁测试"],
  messages:[{ role:"user", content:"客户主动入站咨询", at:new Date().toISOString() }]
});

const bindLeadSession = async (leadMobile, conversationId) => {
  const reference = privacySubjectReference(leadMobile, tenantA);
  const internalSessionId = `${tenantA}:web:${conversationId}`;
  await runtime.tenantTransaction(tenantA, async (client) => {
    const lead = await client.query(
      "SELECT id FROM leads WHERE tenant_id=$1 AND normalized_mobile_hmac=$2",
      [tenantA, reference]
    );
    assert.equal(lead.rowCount, 1, "测试会话绑定前必须已有客户主体");
    await client.query(
      `INSERT INTO conversation_sessions
        (tenant_id,session_id,channel,external_conversation_id,lead_id,state)
       VALUES ($1,$2,'web',$3,$4,$5::jsonb)
       ON CONFLICT (tenant_id,channel,session_id)
       DO UPDATE SET lead_id=EXCLUDED.lead_id
       RETURNING id`,
      [tenantA, internalSessionId, conversationId, lead.rows[0].id,
        JSON.stringify(encryption.encryptJson(
          {},
          { tenantId:tenantA, scope:"conversation.session.state", recordId:`web:${internalSessionId}` }
        ))]
    );
  });
  return { reference, internalSessionId };
};

const handoverInput = (conversationId, options = {}) => ({
  envelope:{
    tenant_id:tenantA,
    channel:"web",
    conversation_id:conversationId,
    actor:{ external_user_id:`privacy-user-${suffix}` },
    message:{ id:`privacy-message-${randomUUID()}`, text:options.message || "请帮我转人工" }
  },
  result:{
    status:"handover_required",
    handover:{
      required:true,
      reason:options.reason || "human_requested",
      to_team:"人工咨询"
    }
  },
  sessionSnapshot:{ conversation_summary:options.message || "客户请求人工", known_slots:{}, projects:[] },
  contactInitiation:options.initiation || "proactive",
  safeText:(value, limit = 500) => String(value || "").slice(0, limit)
});

let server;
try {
  await migrator.transaction(async (client) => {
    await client.query("SET LOCAL ROLE huamei_owner");
    await client.query(
      `INSERT INTO tenants (tenant_id,display_name) VALUES ($1,$1),($2,$2)
       ON CONFLICT (tenant_id) DO NOTHING`,
      [tenantA, tenantB]
    );
  });

  const leadId = `lead-privacy-${suffix}`;
  const sessionId = `privacy-session-${suffix}`;
  const activeSessionId = `privacy-active-session-${suffix}`;
  const pendingHandoverId = `ho_${randomUUID()}`;
  const claimedHandoverId = `ho_${randomUUID()}`;
  const pendingTaskId = `privacy-pending-${suffix}`;
  const activeTaskId = `privacy-active-${suffix}`;
  const marketingTaskId = `privacy-marketing-${suffix}`;
  const evidence = { source:"test", private_marker:secrets.consent };
  const evidenceHash = createHash("sha256").update(JSON.stringify(evidence)).digest("hex");
  await runtime.tenantTransaction(tenantA, async (client) => {
    const lead = await client.query(
      `INSERT INTO leads
        (tenant_id,lead_id,normalized_mobile_hmac,source_channel,profile)
       VALUES ($1,$2,$3,'web',$4::jsonb)
       RETURNING id`,
      [tenantA, leadId, subjectReference, JSON.stringify(encryption.encryptJson(
        { private_marker:"encrypted-lead-profile" },
        { tenantId:tenantA, scope:"lead.profile", recordId:subjectReference }
      ))]
    );
    const session = await client.query(
      `INSERT INTO conversation_sessions
        (tenant_id,session_id,channel,external_conversation_id,lead_id,state)
       VALUES ($1,$2,'web',$2,$3,$4::jsonb)
       RETURNING id`,
      [tenantA, sessionId, lead.rows[0].id, JSON.stringify(encryption.encryptJson(
        {},
        { tenantId:tenantA, scope:"conversation.session.state", recordId:`web:${sessionId}` }
      ))]
    );
    const activeSession = await client.query(
      `INSERT INTO conversation_sessions
        (tenant_id,session_id,channel,external_conversation_id,lead_id,state)
       VALUES ($1,$2,'web',$2,$3,$4::jsonb)
       RETURNING id`,
      [tenantA, activeSessionId, lead.rows[0].id, JSON.stringify(encryption.encryptJson(
        {},
        { tenantId:tenantA, scope:"conversation.session.state", recordId:`web:${activeSessionId}` }
      ))]
    );
    for (const consentType of ["service", "marketing"]) {
      await client.query(
        `INSERT INTO consents
          (tenant_id,lead_record_id,consent_type,granted,policy_version,source,
           evidence_hash,evidence,is_current)
         VALUES ($1,$2,$3,true,'privacy-exec-test','web',$4,$5::jsonb,true)`,
        [tenantA, lead.rows[0].id, consentType, evidenceHash,
          JSON.stringify(encryption.encryptJson(evidence, consentEvidenceContext(consentType, evidenceHash)))]
      );
    }
    const pending = await client.query(
      `INSERT INTO handovers
        (tenant_id,handover_id,session_record_id,status,reason,team,snapshot)
       VALUES ($1,$2,$3,'pending','human_requested','privacy-test',$4::jsonb)
       RETURNING id`,
      [tenantA, pendingHandoverId, session.rows[0].id, JSON.stringify(encryption.encryptJson(
        {},
        { tenantId:tenantA, scope:"handover.snapshot", recordId:pendingHandoverId }
      ))]
    );
    const claimed = await client.query(
      `INSERT INTO handovers
        (tenant_id,handover_id,session_record_id,status,reason,team,assignee,claimed_at,created_at,snapshot)
       VALUES ($1,$2,$3,'claimed','human_requested','privacy-test','staff-active',transaction_timestamp(),transaction_timestamp(),$4::jsonb)
       RETURNING id`,
      [tenantA, claimedHandoverId, activeSession.rows[0].id, JSON.stringify(encryption.encryptJson(
        {},
        { tenantId:tenantA, scope:"handover.snapshot", recordId:claimedHandoverId }
      ))]
    );
    await client.query(
      `INSERT INTO tasks
        (tenant_id,task_id,handover_record_id,session_record_id,task_type,status,payload)
       VALUES
        ($1,$2,$3,$4,'human_handover','pending','{}'::jsonb),
        ($1,$5,$6,$7,'human_handover','in_progress','{}'::jsonb),
        ($1,$8,NULL,$4,'outbound_contact','ready','{}'::jsonb)`,
      [tenantA, pendingTaskId, pending.rows[0].id, session.rows[0].id,
        activeTaskId, claimed.rows[0].id, activeSession.rows[0].id, marketingTaskId]
    );
    await client.query(
      `INSERT INTO human_work
        (tenant_id,session_record_id,handover_record_id,staff_id,work_type,minutes)
       VALUES ($1,$2,$3,'staff-active','presales_service',5)`,
      [tenantA, activeSession.rows[0].id, claimed.rows[0].id]
    );
  });

  const unverifiedId = `dsr_${randomUUID()}`;
  await createPrivacyRightsRequest({
    tenant_id:tenantA,
    request_id:unverifiedId,
    request_type:"restrict",
    mobile,
    scope:{ purposes:["marketing"] }
  }, { actor:"privacy-test-gateway" });
  await assert.rejects(
    () => preparePrivacyRightsExecution({ tenant_id:tenantA, request_id:unverifiedId }, processor),
    (error) => error?.code === "PRIVACY_IDENTITY_VERIFICATION_REQUIRED" && error?.status === 409
  );

  const missingPurposeId = await createAndVerify("withdraw_consent", [], "no purpose must fail");
  await assert.rejects(
    () => preparePrivacyRightsExecution({ tenant_id:tenantA, request_id:missingPurposeId }, processor),
    (error) => error?.code === "PRIVACY_PURPOSE_SCOPE_REQUIRED" && error?.status === 409
  );

  const withdrawalId = await createAndVerify("withdraw_consent", ["marketing"], secrets.scope);
  const preparedWithdrawal = await preparePrivacyRightsExecution({
    tenant_id:tenantA,
    request_id:withdrawalId
  }, processor);
  assert.equal(preparedWithdrawal.status, "planned");
  assert.equal(preparedWithdrawal.execution_mode, "automatic");
  assert.deepEqual(preparedWithdrawal.purposes, ["marketing"]);
  assert.equal((await preparePrivacyRightsExecution({ tenant_id:tenantA, request_id:withdrawalId }, processor)).action_id, preparedWithdrawal.action_id);
  await assert.rejects(
    () => approvePrivacyRightsExecution({ tenant_id:tenantA, request_id:withdrawalId }, sameActorApprover),
    (error) => error?.code === "PRIVACY_SEPARATION_OF_DUTIES_REQUIRED" && error?.status === 403
  );
  const independentProcessor = {
    subject:`independent-processor-${suffix}`,
    roles:["privacy.processor"]
  };
  const identityVerifierCannotApproveId = await createAndVerify(
    "restrict",
    ["marketing"],
    "身份核验人不得利用另一prepare人绕过职责分离"
  );
  await preparePrivacyRightsExecution({
    tenant_id:tenantA,
    request_id:identityVerifierCannotApproveId
  }, independentProcessor);
  await assert.rejects(
    () => approvePrivacyRightsExecution({
      tenant_id:tenantA,
      request_id:identityVerifierCannotApproveId
    }, sameActorApprover),
    (error) => error?.code === "PRIVACY_SEPARATION_OF_DUTIES_REQUIRED" && error?.status === 403,
    "即使prepare由第二人完成，身份核验人也不得兼任终态复核人"
  );
  const executedWithdrawal = await approvePrivacyRightsExecution({
    tenant_id:tenantA,
    request_id:withdrawalId
  }, approver);
  assert.equal(executedWithdrawal.status, "executed");
  assert.equal(executedWithdrawal.processor_id, processor.subject);
  assert.equal(executedWithdrawal.approver_id, approver.subject);
  assert.equal(executedWithdrawal.outcome.active_human_work_terminated, false);
  assert.equal((await approvePrivacyRightsExecution({ tenant_id:tenantA, request_id:withdrawalId }, approver)).action_id, executedWithdrawal.action_id);
  assert.equal((await getPrivacyRightsRequest(tenantA, withdrawalId)).status, "fulfilled");
  assert.equal(await getPrivacyRightsExecution(tenantB, withdrawalId), null, "其他租户不可读取执行动作");
  assert.equal(await isPrivacyContactSuppressed({
    tenant_id:tenantA,
    subject_reference_hmac:subjectReference,
    purpose:"marketing"
  }), true);
  assert.equal(await isPrivacyContactSuppressed({
    tenant_id:tenantA,
    subject_reference_hmac:subjectReference,
    purpose:"service"
  }), false);
  await assert.rejects(
    () => captureLead(mobile, sessionId, true),
    (error) => error?.code === "PRIVACY_CONTACT_SUPPRESSED"
      && error?.status === 409
      && error?.details?.[0]?.purpose === "marketing",
    "营销撤回后不得通过再次留资重建营销授权"
  );
  const marketingOnlyMobile = "13511112222";
  const marketingOnlyRequest = await createAndVerify(
    "withdraw_consent",
    ["marketing"],
    "marketing only must not block service",
    marketingOnlyMobile
  );
  await preparePrivacyRightsExecution({ tenant_id:tenantA, request_id:marketingOnlyRequest }, processor);
  await approvePrivacyRightsExecution({ tenant_id:tenantA, request_id:marketingOnlyRequest }, approver);
  const serviceOnlyCapture = await captureLead(marketingOnlyMobile, `marketing-only-${suffix}`, false);
  assert.equal(serviceOnlyCapture.is_existing, false, "仅撤回营销时仍可处理客户主动发起的服务留资");

  const operationalState = await runtime.tenantQuery(
    tenantA,
    `SELECT
       (SELECT granted FROM consents c JOIN leads l ON l.tenant_id=c.tenant_id AND l.id=c.lead_record_id
        WHERE c.tenant_id=$1 AND l.normalized_mobile_hmac=$2 AND c.consent_type='marketing' AND c.is_current) AS marketing_granted,
       (SELECT granted FROM consents c JOIN leads l ON l.tenant_id=c.tenant_id AND l.id=c.lead_record_id
        WHERE c.tenant_id=$1 AND l.normalized_mobile_hmac=$2 AND c.consent_type='service' AND c.is_current) AS service_granted,
       (SELECT status FROM tasks WHERE tenant_id=$1 AND task_id=$3) AS pending_task_status,
       (SELECT status FROM tasks WHERE tenant_id=$1 AND task_id=$4) AS active_task_status,
       (SELECT status FROM tasks WHERE tenant_id=$1 AND task_id=$5) AS marketing_task_status,
       (SELECT status FROM handovers WHERE tenant_id=$1 AND handover_id=$6) AS pending_handover_status,
       (SELECT status FROM handovers WHERE tenant_id=$1 AND handover_id=$7) AS active_handover_status,
       (SELECT count(*)::int FROM human_work WHERE tenant_id=$1) AS human_work_count`,
    [tenantA, subjectReference, pendingTaskId, activeTaskId, marketingTaskId, pendingHandoverId, claimedHandoverId]
  );
  assert.deepEqual(operationalState.rows[0], {
    marketing_granted:false,
    service_granted:true,
    pending_task_status:"pending",
    active_task_status:"in_progress",
    marketing_task_status:"cancelled",
    pending_handover_status:"pending",
    active_handover_status:"claimed",
    human_work_count:1
  });

  const restrictPendingTaskId = `privacy-restrict-pending-${suffix}`;
  await runtime.tenantTransaction(tenantA, (client) => client.query(
    `INSERT INTO tasks
      (tenant_id,task_id,session_record_id,task_type,status,payload)
     SELECT $1::varchar,$2::varchar,id,'appointment_callback','ready','{}'::jsonb
     FROM conversation_sessions WHERE tenant_id=$1 AND session_id=$3`,
    [tenantA, restrictPendingTaskId, sessionId]
  ));
  const restrictId = await createAndVerify("restrict", ["service"]);
  await preparePrivacyRightsExecution({ tenant_id:tenantA, request_id:restrictId }, processor);
  const restricted = await approvePrivacyRightsExecution({ tenant_id:tenantA, request_id:restrictId }, approver);
  assert.equal(restricted.status, "executed");
  assert.equal(await isPrivacyContactSuppressed({
    tenant_id:tenantA,
    subject_reference_hmac:subjectReference,
    purpose:"service"
  }), true);
  const restrictTask = await runtime.tenantQuery(
    tenantA,
    "SELECT status FROM tasks WHERE tenant_id=$1 AND task_id=$2",
    [tenantA, restrictPendingTaskId]
  );
  assert.equal(restrictTask.rows[0].status, "cancelled");
  const serviceCancellation = await runtime.tenantQuery(
    tenantA,
    `SELECT
       (SELECT status FROM tasks WHERE tenant_id=$1 AND task_id=$2) AS pending_task_status,
       (SELECT status FROM handovers WHERE tenant_id=$1 AND handover_id=$3) AS pending_handover_status,
       (SELECT status FROM tasks WHERE tenant_id=$1 AND task_id=$4) AS active_task_status,
       (SELECT status FROM handovers WHERE tenant_id=$1 AND handover_id=$5) AS active_handover_status,
       (SELECT count(*)::int FROM human_work WHERE tenant_id=$1 AND handover_record_id=(
         SELECT id FROM handovers WHERE tenant_id=$1 AND handover_id=$5
       )) AS active_human_work_count`,
    [tenantA, pendingTaskId, pendingHandoverId, activeTaskId, claimedHandoverId]
  );
  assert.deepEqual(serviceCancellation.rows[0], {
    pending_task_status:"cancelled",
    pending_handover_status:"cancelled",
    active_task_status:"in_progress",
    active_handover_status:"claimed",
    active_human_work_count:1
  });
  assert.equal(await isPrivacyContactSuppressed({
    tenant_id:tenantA,
    subject_reference_hmac:subjectReference,
    purpose:"privacy_rights_status"
  }), false, "法定隐私请求状态通知不得被联系抑制阻断");
  assert.equal(await isPrivacyContactSuppressed({
    tenant_id:tenantA,
    subject_reference_hmac:subjectReference,
    purpose:"legal_obligation"
  }), false, "法律义务必要通知不得被联系抑制阻断");
  await assert.rejects(
    () => captureLead(mobile, sessionId, false),
    (error) => error?.code === "PRIVACY_CONTACT_SUPPRESSED"
      && error?.details?.[0]?.purpose === "service",
    "服务联系受限后不得通过重复留资重建服务授权"
  );

  const postSuppressionConversation = `post-suppression-${suffix}`;
  await bindLeadSession(mobile, postSuppressionConversation);
  await assert.rejects(
    () => operations.ensureHandoverTask(handoverInput(postSuppressionConversation, {
      initiation:"proactive",
      reason:"service_follow_up",
      message:"后台主动创建回访"
    })),
    (error) => error?.code === "PRIVACY_CONTACT_SUPPRESSED"
      && error?.details?.[0]?.purpose === "service",
    "被抑制用途不得在后续重建主动联系任务"
  );
  const customerInitiatedHandover = await operations.ensureHandoverTask(
    handoverInput(postSuppressionConversation, {
      initiation:"customer_inbound",
      reason:"human_requested",
      message:"我现在明确要求转人工"
    })
  );
  assert.equal(customerInitiatedHandover.status, "pending", "客户本轮主动请求人工不得被主动联系抑制误伤");
  assert.equal((await operations.recordInbound(
    customerInitiatedHandover,
    {
      ...handoverInput(postSuppressionConversation).envelope,
      message:{ id:`privacy-inbound-${suffix}`, text:"这是客户本轮主动补充的问题" }
    },
    (value, limit = 500) => String(value || "").slice(0, limit)
  )).duplicate, false);
  const inboundTaskGate = await runtime.tenantQuery(
    tenantA,
    "SELECT payload FROM tasks WHERE tenant_id=$1 AND task_id=$2",
    [tenantA, customerInitiatedHandover.task_id]
  );
  assert.deepEqual({
    purpose:inboundTaskGate.rows[0].payload.contact_purpose,
    initiation:inboundTaskGate.rows[0].payload.contact_initiation,
    exemption:inboundTaskGate.rows[0].payload.privacy_gate_exemption
  }, {
    purpose:"service",
    initiation:"customer_inbound",
    exemption:"customer_inbound"
  });

  const unboundInboundHandover = await operations.ensureHandoverTask(handoverInput(`unbound-inbound-${suffix}`, {
    initiation:"customer_inbound",
    reason:"human_requested",
    message:"未留手机客户本轮明确请求人工"
  }));
  assert.equal(unboundInboundHandover.status, "pending", "纯入站明确请求不能因无法解析手机被阻断");

  const emergencyConversation = `privacy-emergency-${suffix}`;
  const emergencyHandover = await operations.ensureHandoverTask(handoverInput(emergencyConversation, {
    reason:"medical_emergency",
    initiation:"proactive",
    message:"客户本轮描述紧急医疗风险"
  }));
  assert.equal(emergencyHandover.status, "pending", "紧急安全接管不应因无手机映射被阻断");
  const continuityHandover = await operations.ensureHandoverTask(handoverInput(`privacy-continuity-${suffix}`, {
    reason:"critical_risk_continuity",
    initiation:"proactive",
    message:"客户本轮存在关键风险连续性问题"
  }));
  assert.equal(continuityHandover.status, "pending");
  await assert.rejects(
    () => operations.ensureHandoverTask(handoverInput(`unknown-proactive-${suffix}`, {
      initiation:"proactive",
      reason:"service_follow_up",
      message:"未关联主体的主动联系"
    })),
    (error) => error?.code === "PRIVACY_CONTACT_SUBJECT_REQUIRED",
    "未关联已核验主体的主动任务必须fail-closed"
  );

  const unmappedTaskId = `privacy-unmapped-${suffix}`;
  await runtime.tenantTransaction(tenantA, (client) => client.query(
    `INSERT INTO tasks
      (tenant_id,task_id,session_record_id,task_type,status,payload)
     SELECT $1::varchar,$2::varchar,id,'appointment_callback','pending','{}'::jsonb
     FROM conversation_sessions WHERE tenant_id=$1 AND session_id=$3`,
    [tenantA, unmappedTaskId, sessionId]
  ));
  const photoWithdrawalId = await createAndVerify("withdraw_consent", ["photo"]);
  await preparePrivacyRightsExecution({ tenant_id:tenantA, request_id:photoWithdrawalId }, processor);
  await approvePrivacyRightsExecution({ tenant_id:tenantA, request_id:photoWithdrawalId }, approver);
  const unmappedTask = await runtime.tenantQuery(
    tenantA,
    "SELECT status FROM tasks WHERE tenant_id=$1 AND task_id=$2",
    [tenantA, unmappedTaskId]
  );
  assert.equal(unmappedTask.rows[0].status, "pending", "photo用途没有批准映射时不得猜测取消service任务");

  const consentRaceMobile = "13811112222";
  const consentRaceReference = privacySubjectReference(consentRaceMobile, tenantA);
  await captureLead(consentRaceMobile, `consent-race-lead-${suffix}`, true);
  const consentRaceRequest = await createAndVerify(
    "withdraw_consent",
    ["marketing"],
    "concurrent consent gate",
    consentRaceMobile
  );
  await preparePrivacyRightsExecution({ tenant_id:tenantA, request_id:consentRaceRequest }, processor);
  const [consentRaceApproval, consentRaceUpsert] = await Promise.allSettled([
    approvePrivacyRightsExecution({ tenant_id:tenantA, request_id:consentRaceRequest }, approver),
    captureLead(consentRaceMobile, `consent-race-replay-${suffix}`, true)
  ]);
  assert.equal(consentRaceApproval.status, "fulfilled");
  if (consentRaceUpsert.status === "rejected") {
    assert.equal(consentRaceUpsert.reason?.code, "PRIVACY_CONTACT_SUPPRESSED");
  }
  const consentRaceFinal = await runtime.tenantQuery(
    tenantA,
    `SELECT
       EXISTS (
         SELECT 1 FROM contact_suppressions
         WHERE tenant_id=$1 AND subject_reference_hmac=$2 AND status='active'
           AND purpose IN ('marketing','all')
       ) AS suppressed,
       (SELECT granted FROM consents c
        JOIN leads l ON l.tenant_id=c.tenant_id AND l.id=c.lead_record_id
        WHERE c.tenant_id=$1 AND l.normalized_mobile_hmac=$2
          AND c.consent_type='marketing' AND c.is_current) AS current_marketing_granted`,
    [tenantA, consentRaceReference]
  );
  assert.deepEqual(consentRaceFinal.rows[0], {
    suppressed:true,
    current_marketing_granted:false
  }, "撤回审批与重新授权并发后不得留下active suppression + true current consent");

  const taskRaceMobile = "13711112222";
  const taskRaceReference = privacySubjectReference(taskRaceMobile, tenantA);
  const taskRaceConversation = `task-race-${suffix}`;
  await captureLead(taskRaceMobile, `task-race-lead-${suffix}`, false);
  const taskRaceSession = await bindLeadSession(taskRaceMobile, taskRaceConversation);
  assert.equal(taskRaceSession.reference, taskRaceReference);
  const taskRaceRequest = await createAndVerify(
    "restrict",
    ["service"],
    "concurrent proactive task gate",
    taskRaceMobile
  );
  await preparePrivacyRightsExecution({ tenant_id:tenantA, request_id:taskRaceRequest }, processor);
  const [taskRaceApproval, taskRaceCreation] = await Promise.allSettled([
    approvePrivacyRightsExecution({ tenant_id:tenantA, request_id:taskRaceRequest }, approver),
    operations.ensureHandoverTask(handoverInput(taskRaceConversation, {
      initiation:"proactive",
      reason:"service_follow_up",
      message:"隐私审批并发创建主动回访"
    }))
  ]);
  assert.equal(taskRaceApproval.status, "fulfilled");
  if (taskRaceCreation.status === "rejected") {
    assert.equal(taskRaceCreation.reason?.code, "PRIVACY_CONTACT_SUPPRESSED");
  }
  const taskRaceFinal = await runtime.tenantQuery(
    tenantA,
    `SELECT
       count(*) FILTER (WHERE t.status IN ('pending','ready'))::int AS open_tasks,
       count(*) FILTER (WHERE h.status='pending')::int AS open_handovers
     FROM conversation_sessions s
     LEFT JOIN tasks t ON t.tenant_id=s.tenant_id AND t.session_record_id=s.id
     LEFT JOIN handovers h ON h.tenant_id=s.tenant_id AND h.session_record_id=s.id
     WHERE s.tenant_id=$1 AND s.session_id=$2`,
    [tenantA, taskRaceSession.internalSessionId]
  );
  assert.deepEqual(taskRaceFinal.rows[0], {
    open_tasks:0,
    open_handovers:0
  }, "限制审批与主动任务并发后不得留下未开始触达");

  const allPurposeMobile = "13611112222";
  const allPurposeReference = privacySubjectReference(allPurposeMobile, tenantA);
  await captureLead(allPurposeMobile, `all-purpose-${suffix}`, true);
  const allPurposeRequest = await createAndVerify(
    "restrict",
    ["all"],
    "all purposes",
    allPurposeMobile
  );
  const allRestrictionPlan = await preparePrivacyRightsExecution({
    tenant_id:tenantA,
    request_id:allPurposeRequest
  }, processor);
  assert.equal(allRestrictionPlan.execution_mode, "manual",
    "restrict all包含未自动化的数据处理用途，必须转人工计划");
  const allRestrictionPending = await approvePrivacyRightsExecution({
    tenant_id:tenantA,
    request_id:allPurposeRequest
  }, approver);
  assert.equal(allRestrictionPending.status, "manual_pending");
  assert.equal((await getPrivacyRightsRequest(tenantA, allPurposeRequest)).status, "in_progress");
  for (const purpose of ["service", "marketing", "privacy", "photo", "medical_data"]) {
    assert.equal(await isPrivacyContactSuppressed({
      tenant_id:tenantA,
      subject_reference_hmac:allPurposeReference,
      purpose
    }), false, `未完成真实处理限制前，restrict all不得冒充已抑制${purpose}`);
  }
  const allWithdrawalRequest = await createAndVerify(
    "withdraw_consent",
    ["all"],
    "撤回全部授权仍可按明确用途自动执行",
    allPurposeMobile
  );
  const allWithdrawalPrepared = await preparePrivacyRightsExecution({
    tenant_id:tenantA,
    request_id:allWithdrawalRequest
  }, processor);
  assert.equal(allWithdrawalPrepared.execution_mode, "automatic");
  await approvePrivacyRightsExecution({ tenant_id:tenantA, request_id:allWithdrawalRequest }, approver);
  for (const purpose of ["service", "marketing", "privacy", "photo", "medical_data"]) {
    assert.equal(await isPrivacyContactSuppressed({
      tenant_id:tenantA,
      subject_reference_hmac:allPurposeReference,
      purpose
    }), true, `withdraw all抑制必须覆盖${purpose}`);
  }
  assert.equal(await isPrivacyContactSuppressed({
    tenant_id:tenantA,
    subject_reference_hmac:allPurposeReference,
    purpose:"privacy_rights_status"
  }), false, "all不得阻断权利请求必要状态通知");
  await assert.rejects(
    () => captureLead(allPurposeMobile, `all-purpose-replay-${suffix}`, false),
    (error) => error?.code === "PRIVACY_CONTACT_SUPPRESSED"
      && error?.details?.[0]?.purpose === "service"
  );

  const medicalProcessingRestrictionId = await createAndVerify(
    "restrict",
    ["medical_data"],
    "限制医疗数据处理必须等待真实处理路径门禁与下游回执"
  );
  const medicalRestrictionPlan = await preparePrivacyRightsExecution({
    tenant_id:tenantA,
    request_id:medicalProcessingRestrictionId
  }, processor);
  assert.equal(medicalRestrictionPlan.execution_mode, "manual",
    "photo/medical_data/privacy处理限制不得冒充自动执行");
  assert.ok(medicalRestrictionPlan.requirements.required_controls.includes(
    "downstream_processor_restriction_receipts"
  ));
  const medicalRestrictionPending = await approvePrivacyRightsExecution({
    tenant_id:tenantA,
    request_id:medicalProcessingRestrictionId
  }, approver);
  assert.equal(medicalRestrictionPending.status, "manual_pending");
  assert.equal(medicalRestrictionPending.outcome.processing_restriction_applied, false);
  assert.equal((await getPrivacyRightsRequest(tenantA, medicalProcessingRestrictionId)).status, "in_progress",
    "未完成处理路径限制前不得把DSR标记fulfilled");
  assert.equal(await isPrivacyContactSuppressed({
    tenant_id:tenantA,
    subject_reference_hmac:subjectReference,
    purpose:"medical_data"
  }), false, "仅写联系抑制不能冒充医疗数据处理限制");

  const leadCountBeforePlans = await runtime.tenantQuery(
    tenantA,
    "SELECT count(*)::int AS total FROM leads WHERE tenant_id=$1",
    [tenantA]
  );
  for (const requestType of ["delete", "export"]) {
    const requestId = await createAndVerify(requestType, [], `${requestType}-manual-plan`);
    await assert.rejects(
      () => transitionPrivacyRightsRequest({
        tenant_id:tenantA,
        request_id:requestId,
        status:"fulfilled",
        result:{ action_reference:`unsafe-bypass-${suffix}` }
      }, { subject:`bypass-approver-${suffix}`, roles:["privacy.processor", "privacy.approver"] }),
      (error) => error?.code === "PRIVACY_CONTROLLED_EXECUTION_REQUIRED" && error?.status === 409
    );
    const prepared = await preparePrivacyRightsExecution({ tenant_id:tenantA, request_id:requestId }, processor);
    assert.equal(prepared.execution_mode, "manual");
    const approved = await approvePrivacyRightsExecution({ tenant_id:tenantA, request_id:requestId }, approver);
    assert.equal(approved.status, "manual_pending");
    assert.equal(approved.outcome.physical_deletion_performed, false);
    assert.equal(approved.outcome.export_artifact_created, false);
    assert.equal((await getPrivacyRightsRequest(tenantA, requestId)).status, "in_progress");
  }
  const leadCountAfterPlans = await runtime.tenantQuery(
    tenantA,
    "SELECT count(*)::int AS total FROM leads WHERE tenant_id=$1",
    [tenantA]
  );
  assert.equal(leadCountAfterPlans.rows[0].total, leadCountBeforePlans.rows[0].total, "删除计划不得物理删除线索");

  const encryptedResultId = await createAndVerify("access", [], secrets.scope);
  const encryptedResultCompletion = issuePrivacyCompletionAttestation({
    tenantId:tenantA,
    subjectReferenceHmac:subjectReference,
    requestId:encryptedResultId,
    requestType:"access",
    evidenceId:`privacy-access-${suffix}`,
    actionReference:`controlled-${suffix}`,
    method:"secure_delivery"
  });
  await transitionPrivacyRightsRequest({
    tenant_id:tenantA,
    request_id:encryptedResultId,
    status:"fulfilled",
    completion_attestation:encryptedResultCompletion,
    result:{ action_reference:`controlled-${suffix}`, summary:secrets.result }
  }, { subject:`privacy-finalizer-${suffix}`, roles:["privacy.processor", "privacy.approver"] });
  const publicEncryptedRequest = await getPrivacyRightsRequest(tenantA, encryptedResultId);
  assert.equal(publicEncryptedRequest.scope.note, secrets.scope);
  assert.equal(publicEncryptedRequest.result.summary, secrets.result);

  const rawPrivacy = await runtime.tenantQuery(
    tenantA,
    `SELECT request_id, identity_evidence, scope, result, row_to_json(r)::text AS document
     FROM data_subject_requests r
     WHERE tenant_id=$1 AND request_id = ANY($2::text[])
     ORDER BY request_id`,
    [tenantA, [withdrawalId, encryptedResultId]]
  );
  const rawDocuments = rawPrivacy.rows.map((row) => row.document).join("\n");
  for (const secret of [mobile, secrets.scope, secrets.identity, secrets.result, secrets.consent]) {
    assert.equal(rawDocuments.includes(secret), false, `数据主体请求不得保存明文：${secret}`);
  }
  const encryptedRaw = rawPrivacy.rows.find((row) => row.request_id === encryptedResultId);
  assert.equal(encryptedRaw.scope.key_id, "privacy-new");
  assert.throws(
    () => encryption.decryptJson(encryptedRaw.scope, privacyFieldContext(encryptedResultId, "scope", tenantB)),
    (error) => error?.code === "FIELD_DECRYPTION_FAILED"
  );
  const tamperedPrefix = encryptedRaw.scope.ciphertext.startsWith("A") ? "B" : "A";
  const tamperedScope = {
    ...encryptedRaw.scope,
    ciphertext:`${tamperedPrefix}${encryptedRaw.scope.ciphertext.slice(1)}`
  };
  assert.throws(
    () => encryption.decryptJson(tamperedScope, privacyFieldContext(encryptedResultId, "scope")),
    (error) => error?.code === "FIELD_DECRYPTION_FAILED"
  );

  const rotationRequestId = `dsr_${randomUUID()}`;
  const oldStore = createPostgresPrivacyRequestStore({ postgres:runtime, fieldEncryption:oldEncryption });
  await oldStore.create({
    tenantId:tenantA,
    requestId:rotationRequestId,
    requestType:"export",
    subjectReferenceHmac:subjectReference,
    scope:{ note:`rotation-${suffix}` }
  });
  const rotationRaw = await runtime.tenantQuery(
    tenantA,
    "SELECT scope FROM data_subject_requests WHERE tenant_id=$1 AND request_id=$2",
    [tenantA, rotationRequestId]
  );
  assert.equal(encryption.needsRotation(rotationRaw.rows[0].scope), true);
  const currentStore = createPostgresPrivacyRequestStore({ postgres:runtime, fieldEncryption:encryption });
  assert.equal((await currentStore.get({ tenantId:tenantA, requestId:rotationRequestId })).scope.note, `rotation-${suffix}`);

  const minimized = await runtime.tenantQuery(
    tenantA,
    `SELECT
       coalesce(string_agg(a.details::text,' '),'') AS audit_text,
       coalesce((SELECT string_agg(o.payload::text,' ') FROM outbox_events o WHERE o.tenant_id=$1), '') AS outbox_text
     FROM audit_events a WHERE a.tenant_id=$1`,
    [tenantA]
  );
  for (const secret of [mobile, subjectReference, secrets.scope, secrets.identity, secrets.result, secrets.consent]) {
    assert.equal(`${minimized.rows[0].audit_text} ${minimized.rows[0].outbox_text}`.includes(secret), false, "审计和Outbox不得复制个人内容或主体HMAC");
  }

  const oidcVerifier = {
    async verifyAuthorizationHeader(header, requirements = {}) {
      const token = String(header || "").replace(/^Bearer\s+/i, "");
      const identities = {
        processor:{ subject:`http-processor-${suffix}`, roles:["privacy.processor"] },
        same:{ subject:`http-processor-${suffix}`, roles:["privacy.processor", "privacy.approver"] },
        approver:{ subject:`http-approver-${suffix}`, roles:["privacy.approver"] }
      };
      const identity = identities[token];
      if (!identity) {
        const error = new Error("token missing");
        error.code = "OIDC_TOKEN_MISSING";
        error.status = 401;
        throw error;
      }
      if (requirements.requiredRoles && !requirements.requiredRoles.some((role) => identity.roles.includes(role))) {
        const error = new Error("role forbidden");
        error.code = "OIDC_ROLE_FORBIDDEN";
        error.status = 403;
        throw error;
      }
      return { ...identity, tenantIds:[tenantA] };
    }
  };
  const { createAcquisitionServiceServer } = await import("../server/acquisition-service-server.mjs");
  server = createAcquisitionServiceServer({ host:"127.0.0.1", oidcVerifier });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const headers = (caller, secret, token = "") => ({
    "Content-Type":"application/json",
    "X-Caller-Id":caller,
    "X-Service-Key":secret,
    "X-Tenant-Id":tenantA,
    ...(token ? { Authorization:`Bearer ${token}` } : {})
  });
  const requestJson = async (path, options = {}) => {
    const response = await fetch(`${baseUrl}${path}`, options);
    return { response, body:await response.json() };
  };
  const httpRequestId = `dsr_${randomUUID()}`;
  const httpCreated = await requestJson("/v1/privacy/requests", {
    method:"POST",
    headers:headers("privacy_gateway", gatewaySecret),
    body:JSON.stringify({
      tenant_id:tenantA,
      request_id:httpRequestId,
      request_type:"restrict",
      mobile,
      scope:{ purposes:["marketing"] }
    })
  });
  assert.equal(httpCreated.response.status, 202);
  const httpVerified = await requestJson(`/v1/privacy/requests/${httpRequestId}/transition`, {
    method:"POST",
    headers:headers("privacy_admin", adminSecret, "processor"),
    body:JSON.stringify({
      tenant_id:tenantA,
      status:"in_progress",
      identity_verification_attestation:issuePrivacyIdentityAttestation({
        tenantId:tenantA,
        subjectReferenceHmac:subjectReference,
        requestId:httpRequestId,
        verificationId:`privacy-http-execution-${suffix}`,
        method:"verified_callback"
      })
    })
  });
  assert.equal(httpVerified.response.status, 200);
  const permissionDenied = await requestJson(`/v1/privacy/requests/${httpRequestId}/execution/prepare`, {
    method:"POST",
    headers:headers("privacy_reader", readerSecret, "processor"),
    body:JSON.stringify({ tenant_id:tenantA })
  });
  assert.equal(permissionDenied.response.status, 403);
  assert.equal(permissionDenied.body.error.code, "INSUFFICIENT_PERMISSION");
  const httpPrepared = await requestJson(`/v1/privacy/requests/${httpRequestId}/execution/prepare`, {
    method:"POST",
    headers:headers("privacy_admin", adminSecret, "processor"),
    body:JSON.stringify({ tenant_id:tenantA })
  });
  assert.equal(httpPrepared.response.status, 201);
  assert.equal(httpPrepared.body.data.status, "planned");
  const sameActorDenied = await requestJson(`/v1/privacy/requests/${httpRequestId}/execution/approve`, {
    method:"POST",
    headers:headers("privacy_admin", adminSecret, "same"),
    body:JSON.stringify({ tenant_id:tenantA })
  });
  assert.equal(sameActorDenied.response.status, 403);
  assert.equal(sameActorDenied.body.error.code, "PRIVACY_SEPARATION_OF_DUTIES_REQUIRED");
  const httpApproved = await requestJson(`/v1/privacy/requests/${httpRequestId}/execution/approve`, {
    method:"POST",
    headers:headers("privacy_admin", adminSecret, "approver"),
    body:JSON.stringify({ tenant_id:tenantA })
  });
  assert.equal(httpApproved.response.status, 200);
  assert.equal(httpApproved.body.data.status, "executed");
  const httpGet = await requestJson(`/v1/privacy/requests/${httpRequestId}/execution?tenant_id=${tenantA}`, {
    headers:headers("privacy_admin", adminSecret, "processor")
  });
  assert.equal(httpGet.response.status, 200);
  assert.equal(httpGet.body.data.action_id, httpPrepared.body.data.action_id);

  const forced = await migrator.transaction(async (client) => {
    await client.query("SET LOCAL ROLE huamei_owner");
    return client.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity
       FROM pg_class
       WHERE relname = ANY($1::text[])
       ORDER BY relname`,
      [["contact_suppressions", "privacy_execution_actions"]]
    );
  });
  assert.deepEqual(forced.rows, [
    { relname:"contact_suppressions", relrowsecurity:true, relforcerowsecurity:true },
    { relname:"privacy_execution_actions", relrowsecurity:true, relforcerowsecurity:true }
  ]);
  const crossTenantVisible = await runtime.tenantQuery(
    tenantB,
    "SELECT count(*)::int AS total FROM privacy_execution_actions WHERE tenant_id=$1",
    [tenantA]
  );
  assert.equal(crossTenantVisible.rows[0].total, 0);
  await assert.rejects(
    () => runtime.tenantQuery(
      tenantA,
      "DELETE FROM privacy_execution_actions WHERE tenant_id=$1 AND request_id=$2",
      [tenantA, withdrawalId]
    ),
    (error) => error?.code === "42501",
    "runtime角色不得删除隐私执行台账"
  );

  console.log("✓ 隐私请求已核验前置、两人分权、撤回/限制生效、未开始任务安全取消通过");
  console.log("✓ 后续授权/主动任务重建门禁、all/特定用途、入站/紧急豁免与并发终态通过");
  console.log("✓ 导出/删除仅生成人工计划，幂等、租户RLS、审计最小化和HTTP权限通过");
  console.log("✓ DSR identity_evidence/scope/result无明文，AAD篡改拒绝与新旧密钥读取通过");
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await Promise.allSettled([runtime.close(), migrator.close(), closePostgresClient(), closeRedisClient()]);
}
