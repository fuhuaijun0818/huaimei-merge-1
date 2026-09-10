import { createHash, randomUUID } from "node:crypto";

import { createFieldEncryption } from "../platform/field-encryption.mjs";
import {
  appendAuditEvent, appendOutboxEvent, ensureTenant, jsonValue, postgres
} from "./postgres-helpers.mjs";
import { assertPrivacyIdentityAttestation } from "../platform/privacy-identity-attestation.mjs";
import { assertPrivacyCompletionAttestation } from "../platform/privacy-completion-attestation.mjs";
import { assertPrivacyCancellationAttestation } from "../platform/privacy-cancellation-attestation.mjs";
import { redactContactPii } from "../platform/contact-pii-redaction.mjs";

const REQUEST_TYPES = new Set(["access", "export", "correct", "delete", "restrict", "withdraw_consent"]);
const REQUEST_STATUSES = new Set([
  "received", "identity_pending", "in_progress", "fulfilled",
  "partially_fulfilled", "rejected", "cancelled"
]);
const TERMINAL_STATUSES = new Set(["fulfilled", "partially_fulfilled", "rejected", "cancelled"]);
const CONTROLLED_EXECUTION_TYPES = new Set(["export", "delete", "restrict", "withdraw_consent"]);
const ATTESTED_COMPLETION_TYPES = new Set(["access", "correct"]);
const TRANSITIONS = new Map([
  ["received", new Set(["identity_pending", "in_progress", "rejected"])],
  ["identity_pending", new Set(["in_progress", "rejected"])],
  ["in_progress", new Set(["fulfilled", "partially_fulfilled", "rejected", "cancelled"])]
]);

const clone = (value) => JSON.parse(JSON.stringify(value));
const safeText = (value, limit = 500) => redactContactPii(String(value || ""), {
  replacement:"[mobile-redacted]"
})
  .replace(/[<>]/g, "")
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, limit);

const sha256 = (value) => createHash("sha256").update(String(value)).digest("hex");

export const normalizePrivacyRequestScope = (scope = {}) => ({
  categories:Array.isArray(scope?.categories)
    ? [...new Set(scope.categories.map((item) => safeText(item, 64)).filter(Boolean))].sort().slice(0, 20)
    : [],
  purposes:Array.isArray(scope?.purposes)
    ? [...new Set(scope.purposes
        .map((item) => safeText(item, 32).toLowerCase())
        .filter(Boolean))].sort().slice(0, 10)
    : [],
  correction_fields:Array.isArray(scope?.correction_fields)
    ? [...new Set(scope.correction_fields.map((item) => safeText(item, 64)).filter(Boolean))].sort().slice(0, 20)
    : [],
  note:safeText(scope?.note, 500)
});

const normalizeSourceContract = (requestSource) => ({
  request_source:safeText(requestSource, 80) || "customer_service"
});

const createInputChecksum = ({ requestType, subjectReferenceHmac, scope, sourceContract }) => sha256(JSON.stringify({
  schema:"huamei.privacy-request-create.v1",
  request_type:requestType,
  subject_reference_hmac:String(subjectReferenceHmac || "").toLowerCase(),
  scope:normalizePrivacyRequestScope(scope),
  source_contract:normalizeSourceContract(sourceContract?.request_source)
}));

const requestReceipt = (row) => ({
  request_id:row.request_id,
  request_type:row.request_type,
  receipt_status:"accepted"
});

const cancellationBasisFromAttestation = (attestation) => ({
  source:attestation.source,
  reason_code:attestation.reason_code,
  cancellation_id:attestation.cancellation_id,
  reference_id:attestation.reference_id,
  identity_verification_id:attestation.identity_verification_id,
  recorded_at:new Date(attestation.recorded_at * 1_000).toISOString()
});

const cancellationBasisChecksum = (basis) => sha256(JSON.stringify({
  schema:"huamei.privacy-request-cancellation.v1",
  ...basis
}));

const privacyFieldContext = (tenantId, requestId, field) => ({
  tenantId,
  scope:`privacy.request.${field}`,
  recordId:requestId
});

const publicRequest = (row, fieldEncryption) => {
  const identityEvidence = fieldEncryption.decryptJson(
    jsonValue(row.identity_evidence, {}),
    privacyFieldContext(row.tenant_id, row.request_id, "identity_evidence")
  ) || {};
  const result = row.result ? clone(fieldEncryption.decryptJson(
    jsonValue(row.result, {}),
    privacyFieldContext(row.tenant_id, row.request_id, "result")
  )) : null;
  if (result) delete result.cancellation_basis_checksum;
  return ({
  id:String(row.id),
  tenant_id:row.tenant_id,
  request_id:row.request_id,
  request_type:row.request_type,
  status:row.status,
  legal_hold:Boolean(row.legal_hold),
  identity_verification:identityEvidence.status || "not_verified",
  identity_verification_metadata:identityEvidence.status === "verified" ? {
    method:identityEvidence.method,
    verification_id:identityEvidence.verification_id,
    verified_at:identityEvidence.verified_at,
    verifier:"trusted_identity_adapter"
  } : null,
  scope:clone(fieldEncryption.decryptJson(
    jsonValue(row.scope, {}),
    privacyFieldContext(row.tenant_id, row.request_id, "scope")
  )),
  result,
  completion_verification_metadata:result?.completion_evidence_id ? {
    evidence_id:result.completion_evidence_id,
    method:result.completion_method,
    completed_at:result.completed_at,
    verifier:"trusted_completion_adapter"
  } : null,
  due_at:new Date(row.due_at).toISOString(),
  completed_at:row.completed_at ? new Date(row.completed_at).toISOString() : null,
  created_by:row.created_by,
  created_at:new Date(row.created_at).toISOString(),
  updated_at:new Date(row.updated_at).toISOString()
  });
};

const privacyError = (code, message, status = 400, details = []) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
};

export function createPostgresPrivacyRequestStore(options = {}) {
  const database = options.postgres || postgres();
  const fieldEncryption = options.fieldEncryption || createFieldEncryption({ env:options.env || process.env });
  const slaHours = Number.isInteger(Number(options.slaHours))
    ? Math.min(Math.max(Number(options.slaHours), 1), 24 * 90)
    : 24 * 15;

  const create = async ({
    tenantId,
    requestId = `dsr_${randomUUID()}`,
    requestType,
    subjectReferenceHmac,
    scope = {},
    createdBy = "customer_request",
    requestSource = "customer_service"
  }) => database.tenantTransaction(tenantId, async (client) => {
    await ensureTenant(client, tenantId);
    const normalizedType = String(requestType || "").trim().toLowerCase();
    if (!REQUEST_TYPES.has(normalizedType)) {
      throw privacyError("PRIVACY_REQUEST_TYPE_INVALID", "不支持的个人信息权利请求类型");
    }
    if (!/^[0-9a-f]{64}$/.test(String(subjectReferenceHmac || ""))) {
      throw privacyError("PRIVACY_SUBJECT_REFERENCE_INVALID", "个人信息主体引用无效");
    }
    const normalizedRequestId = String(requestId || "").trim().slice(0, 128);
    if (!/^dsr_[A-Za-z0-9._:-]{8,124}$/.test(normalizedRequestId)) {
      throw privacyError("PRIVACY_REQUEST_ID_INVALID", "个人信息权利请求编号无效");
    }
    const normalizedScope = normalizePrivacyRequestScope(scope);
    const sourceContract = normalizeSourceContract(requestSource);
    const incomingChecksum = createInputChecksum({
      requestType:normalizedType,
      subjectReferenceHmac,
      scope:normalizedScope,
      sourceContract
    });
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
      [`privacy:${tenantId}:${normalizedRequestId}`]
    );
    const existing = await client.query(
      "SELECT * FROM data_subject_requests WHERE tenant_id=$1 AND request_id=$2",
      [tenantId, normalizedRequestId]
    );
    if (existing.rowCount) {
      const row = existing.rows[0];
      const storedIdentityEvidence = fieldEncryption.decryptJson(
        jsonValue(row.identity_evidence, {}),
        privacyFieldContext(tenantId, normalizedRequestId, "identity_evidence")
      ) || {};
      const storedScope = fieldEncryption.decryptJson(
        jsonValue(row.scope, {}),
        privacyFieldContext(tenantId, normalizedRequestId, "scope")
      ) || {};
      const storedChecksum = String(storedIdentityEvidence.create_input_checksum || createInputChecksum({
        requestType:row.request_type,
        subjectReferenceHmac:row.subject_reference_hmac,
        scope:storedScope,
        sourceContract:normalizeSourceContract(storedIdentityEvidence.request_source)
      }));
      if (row.request_type !== normalizedType
          || row.subject_reference_hmac !== String(subjectReferenceHmac).toLowerCase()
          || storedChecksum !== incomingChecksum) {
        throw privacyError(
          "PRIVACY_REQUEST_IDEMPOTENCY_CONFLICT",
          "该请求编号已绑定其他主体、范围或来源合约",
          409
        );
      }
      return requestReceipt(row);
    }
    const dueAt = new Date(Date.now() + slaHours * 60 * 60 * 1_000).toISOString();
    const identityEvidence = {
      status:"pending",
      method:null,
      request_source:sourceContract.request_source,
      create_input_schema:"huamei.privacy-request-create.v1",
      create_input_checksum:incomingChecksum,
      raw_identifier_stored:false
    };
    const inserted = await client.query(
      `INSERT INTO data_subject_requests
        (tenant_id, request_id, request_type, subject_reference_hmac, status,
         identity_evidence, scope, due_at, created_by)
       VALUES ($1,$2,$3,$4,'identity_pending',$5::jsonb,$6::jsonb,$7,$8)
       RETURNING *`,
      [tenantId, normalizedRequestId, normalizedType, subjectReferenceHmac,
        JSON.stringify(fieldEncryption.encryptJson(
          identityEvidence,
          privacyFieldContext(tenantId, normalizedRequestId, "identity_evidence")
        )),
        JSON.stringify(fieldEncryption.encryptJson(
          normalizedScope,
          privacyFieldContext(tenantId, normalizedRequestId, "scope")
        )),
        dueAt, safeText(createdBy, 128) || "customer_request"]
    );
    await appendAuditEvent(client, {
      tenantId,
      eventId:`audit_privacy_received_${normalizedRequestId}`,
      action:"privacy.request.received",
      resourceType:"data_subject_request",
      resourceId:normalizedRequestId,
      actorType:"service",
      actorId:safeText(createdBy, 128) || "customer_request",
      details:{ request_type:normalizedType, status:"identity_pending", raw_identifier_stored:false }
    });
    await appendOutboxEvent(client, {
      tenantId,
      eventId:`outbox_privacy_received_${normalizedRequestId}`,
      aggregateType:"data_subject_request",
      aggregateId:normalizedRequestId,
      eventType:"privacy.request.received",
      payload:{ request_id:normalizedRequestId, request_type:normalizedType, status:"identity_pending", due_at:dueAt }
    });
    return requestReceipt(inserted.rows[0]);
  });

  const get = async ({ tenantId, requestId }) => {
    const result = await database.tenantQuery(
      tenantId,
      "SELECT * FROM data_subject_requests WHERE tenant_id=$1 AND request_id=$2",
      [tenantId, requestId]
    );
    return result.rows[0] ? publicRequest(result.rows[0], fieldEncryption) : null;
  };

  const list = async ({ tenantId, status = "", limit = 100 }) => {
    const normalizedStatus = String(status || "").trim().toLowerCase();
    if (normalizedStatus && !REQUEST_STATUSES.has(normalizedStatus)) {
      throw privacyError("PRIVACY_REQUEST_STATUS_INVALID", "个人信息权利请求状态无效");
    }
    const boundedLimit = Math.min(Math.max(Number(limit) || 100, 1), 500);
    const result = await database.tenantQuery(
      tenantId,
      `SELECT * FROM data_subject_requests
       WHERE tenant_id=$1 AND ($2='' OR status=$2)
       ORDER BY due_at ASC, created_at ASC
       LIMIT $3`,
      [tenantId, normalizedStatus, boundedLimit]
    );
    return result.rows.map((row) => publicRequest(row, fieldEncryption));
  };

  const transition = async ({
    tenantId,
    requestId,
    targetStatus,
    actor,
    identityAttestation = null,
    completionAttestation = null,
    cancellationAttestation = null,
    result = {},
    legalHold
  }) => database.tenantTransaction(tenantId, async (client) => {
    const normalizedTarget = String(targetStatus || "").trim().toLowerCase();
    if (!REQUEST_STATUSES.has(normalizedTarget)) {
      throw privacyError("PRIVACY_REQUEST_STATUS_INVALID", "个人信息权利请求状态无效");
    }
    const selected = await client.query(
      `SELECT * FROM data_subject_requests
       WHERE tenant_id=$1 AND request_id=$2
       FOR UPDATE`,
      [tenantId, requestId]
    );
    if (!selected.rowCount) throw privacyError("PRIVACY_REQUEST_NOT_FOUND", "未找到个人信息权利请求", 404);
    const current = selected.rows[0];
    const currentIdentityEvidence = fieldEncryption.decryptJson(
      jsonValue(current.identity_evidence, {}),
      privacyFieldContext(tenantId, requestId, "identity_evidence")
    ) || {};
    let normalizedCancellation = null;
    let normalizedCancellationChecksum = "";
    if (normalizedTarget === "cancelled") {
      if (currentIdentityEvidence.status !== "verified") {
        throw privacyError(
          "PRIVACY_CANCELLATION_IDENTITY_VERIFICATION_REQUIRED",
          "取消个人信息权利请求前必须先由可信适配器核验主体身份",
          409
        );
      }
      if (currentIdentityEvidence.verified_by === safeText(actor, 128)) {
        throw privacyError(
          "PRIVACY_SEPARATION_OF_DUTIES_REQUIRED",
          "身份核验人与取消复核人必须为不同实名账号",
          403
        );
      }
      if (!cancellationAttestation) {
        throw privacyError(
          "PRIVACY_CANCELLATION_ATTESTATION_REQUIRED",
          "取消个人信息权利请求必须提交可信主体撤回适配器签发的证明",
          409
        );
      }
      const acceptedCancellation = assertPrivacyCancellationAttestation(cancellationAttestation, {
        tenantId,
        subjectReferenceHmac:current.subject_reference_hmac,
        requestId,
        identityVerificationId:currentIdentityEvidence.verification_id
      });
      if (acceptedCancellation.recorded_at * 1_000 < new Date(current.created_at).getTime() - 5 * 60 * 1_000) {
        throw privacyError(
          "PRIVACY_CANCELLATION_ATTESTATION_MISMATCH",
          "主体撤回证明早于当前权利请求，无法作为取消依据",
          409
        );
      }
      normalizedCancellation = cancellationBasisFromAttestation(acceptedCancellation);
      normalizedCancellationChecksum = cancellationBasisChecksum(normalizedCancellation);
      if (current.status === "cancelled") {
        const storedResult = current.result ? fieldEncryption.decryptJson(
          jsonValue(current.result, {}),
          privacyFieldContext(tenantId, requestId, "result")
        ) || {} : {};
        if (storedResult.cancellation_basis_checksum !== normalizedCancellationChecksum) {
          throw privacyError(
            "PRIVACY_CANCELLATION_IDEMPOTENCY_CONFLICT",
            "该请求已使用另一取消依据完成复核",
            409
          );
        }
        return publicRequest(current, fieldEncryption);
      }
    } else if (current.status === normalizedTarget) {
      return publicRequest(current, fieldEncryption);
    }
    if (TERMINAL_STATUSES.has(current.status) || !TRANSITIONS.get(current.status)?.has(normalizedTarget)) {
      throw privacyError(
        "PRIVACY_REQUEST_TRANSITION_INVALID",
        `不能将个人信息权利请求从 ${current.status} 变更为 ${normalizedTarget}`,
        409
      );
    }
    if (["fulfilled", "partially_fulfilled"].includes(normalizedTarget)
        && CONTROLLED_EXECUTION_TYPES.has(current.request_type)) {
      throw privacyError(
        "PRIVACY_CONTROLLED_EXECUTION_REQUIRED",
        "该请求类型必须通过独立准备与复核执行流程处理",
        409
      );
    }
    if (TERMINAL_STATUSES.has(normalizedTarget)
        && currentIdentityEvidence.verified_by
        && currentIdentityEvidence.verified_by === safeText(actor, 128)) {
      throw privacyError(
        "PRIVACY_SEPARATION_OF_DUTIES_REQUIRED",
        "身份核验/处理人与终态复核人必须为不同实名账号",
        403
      );
    }
    const verificationRequired = ["in_progress", "fulfilled", "partially_fulfilled"].includes(normalizedTarget)
      && currentIdentityEvidence.status !== "verified";
    let acceptedAttestation = null;
    if (verificationRequired) {
      if (!identityAttestation) {
        throw privacyError(
          "PRIVACY_IDENTITY_ATTESTATION_REQUIRED",
          "处理本人信息前必须提交可信核验适配器签发的身份核验证明",
          409
        );
      }
      acceptedAttestation = assertPrivacyIdentityAttestation(identityAttestation, {
        tenantId,
        requestId,
        subjectReferenceHmac:current.subject_reference_hmac
      });
      try {
        await client.query(
          `INSERT INTO privacy_identity_verifications
            (tenant_id,verification_id,request_id,subject_reference_hmac,method,
             issued_at,expires_at,recorded_by)
           VALUES ($1,$2,$3,$4,$5,to_timestamp($6),to_timestamp($7),$8)`,
          [tenantId, acceptedAttestation.verification_id, requestId,
            current.subject_reference_hmac, acceptedAttestation.method,
            acceptedAttestation.issued_at, acceptedAttestation.expires_at,
            safeText(actor, 128)]
        );
      } catch (error) {
        if (error?.code !== "23505") throw error;
        throw privacyError(
          "PRIVACY_IDENTITY_ATTESTATION_REPLAYED",
          "该身份核验证明已被使用，不能用于另一请求或再次核验",
          409
        );
      }
    }
    const completionRequired = ["fulfilled", "partially_fulfilled"].includes(normalizedTarget)
      && ATTESTED_COMPLETION_TYPES.has(current.request_type);
    let acceptedCompletion = null;
    if (completionRequired) {
      if (!completionAttestation) {
        throw privacyError(
          "PRIVACY_COMPLETION_ATTESTATION_REQUIRED",
          "完成访问交付或更正前必须提交独立可核验的执行证明",
          409
        );
      }
      acceptedCompletion = assertPrivacyCompletionAttestation(completionAttestation, {
        tenantId,
        requestId,
        subjectReferenceHmac:current.subject_reference_hmac,
        requestType:current.request_type,
        targetStatus:normalizedTarget
      });
      const requestedActionReference = safeText(result?.action_reference, 160);
      if (requestedActionReference && requestedActionReference !== acceptedCompletion.action_reference) {
        throw privacyError(
          "PRIVACY_COMPLETION_ACTION_REFERENCE_MISMATCH",
          "请求结果中的执行引用与可核验完成证明不匹配",
          409
        );
      }
      try {
        await client.query(
          `INSERT INTO privacy_completion_verifications
            (tenant_id,evidence_id,request_id,subject_reference_hmac,request_type,
             target_status,method,action_reference,completed_at,issued_at,expires_at,recorded_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9),to_timestamp($10),to_timestamp($11),$12)`,
          [tenantId, acceptedCompletion.evidence_id, requestId, current.subject_reference_hmac,
            current.request_type, normalizedTarget, acceptedCompletion.method,
            acceptedCompletion.action_reference, acceptedCompletion.completed_at,
            acceptedCompletion.issued_at, acceptedCompletion.expires_at, safeText(actor, 128)]
        );
      } catch (error) {
        if (error?.code !== "23505") throw error;
        throw privacyError(
          "PRIVACY_COMPLETION_ATTESTATION_REPLAYED",
          "该执行/交付证明已被使用，不能用于另一请求",
          409
        );
      }
    } else if (completionAttestation) {
      throw privacyError(
        "PRIVACY_COMPLETION_ATTESTATION_UNEXPECTED",
        "当前请求类型或目标状态不接受执行/交付证明",
        409
      );
    }
    const mergedEvidence = acceptedAttestation ? {
      ...currentIdentityEvidence,
      status:"verified",
      method:acceptedAttestation.method,
      verification_id:acceptedAttestation.verification_id,
      verified_at:new Date().toISOString(),
      verified_by:safeText(actor, 128),
      verification_source:"trusted_identity_adapter",
      raw_identifier_stored:false
    } : currentIdentityEvidence;
    const normalizedResult = {
      action_reference:acceptedCompletion?.action_reference || safeText(result.action_reference, 160),
      summary:safeText(result.summary, 1_000),
      retained_categories:Array.isArray(result.retained_categories)
        ? [...new Set(result.retained_categories.map((item) => safeText(item, 80)).filter(Boolean))].slice(0, 20)
        : [],
      retention_basis_reference:safeText(result.retention_basis_reference, 160),
      ...(acceptedCompletion ? {
        completion_evidence_id:acceptedCompletion.evidence_id,
        completion_method:acceptedCompletion.method,
        completed_at:new Date(acceptedCompletion.completed_at * 1_000).toISOString(),
        completion_source:"trusted_completion_adapter"
      } : {}),
      ...(normalizedCancellation ? {
        cancellation_basis:normalizedCancellation,
        cancellation_basis_checksum:normalizedCancellationChecksum
      } : {})
    };
    const resultSupplied = Boolean(normalizedCancellation || acceptedCompletion
      || (result && typeof result === "object" && Object.keys(result).length));
    const encryptedEvidence = fieldEncryption.encryptJson(
      mergedEvidence,
      privacyFieldContext(tenantId, requestId, "identity_evidence")
    );
    const encryptedResult = resultSupplied
      ? fieldEncryption.encryptJson(
          normalizedResult,
          privacyFieldContext(tenantId, requestId, "result")
        )
      : null;
    const terminal = TERMINAL_STATUSES.has(normalizedTarget);
    const updated = await client.query(
      `UPDATE data_subject_requests
       SET status=$3,
           identity_evidence=$4::jsonb,
           result=CASE WHEN $5::jsonb IS NULL THEN result ELSE $5::jsonb END,
           legal_hold=COALESCE($6,legal_hold),
           completed_at=CASE WHEN $7 THEN clock_timestamp() ELSE NULL END
       WHERE tenant_id=$1 AND request_id=$2
       RETURNING *`,
      [tenantId, requestId, normalizedTarget, JSON.stringify(encryptedEvidence),
        encryptedResult ? JSON.stringify(encryptedResult) : null,
        legalHold === undefined ? null : Boolean(legalHold), terminal]
    );
    const eventSuffix = `${requestId}_${normalizedTarget}`;
    await appendAuditEvent(client, {
      tenantId,
      eventId:`audit_privacy_${eventSuffix}`,
      action:`privacy.request.${normalizedTarget}`,
      resourceType:"data_subject_request",
      resourceId:requestId,
      actorType:"human",
      actorId:safeText(actor, 128),
      details:{
        request_type:current.request_type,
        previous_status:current.status,
        status:normalizedTarget,
        identity_verified:mergedEvidence.status === "verified",
        verification_method:acceptedAttestation?.method || undefined,
        completion_verified:Boolean(acceptedCompletion),
        completion_method:acceptedCompletion?.method || undefined,
        cancellation_verified:Boolean(normalizedCancellation),
        cancellation_source:normalizedCancellation?.source,
        cancellation_reason_code:normalizedCancellation?.reason_code,
        cancellation_reference_sha256:normalizedCancellation
          ? sha256(normalizedCancellation.reference_id)
          : undefined,
        legal_hold:legalHold === undefined ? Boolean(current.legal_hold) : Boolean(legalHold)
      }
    });
    await appendOutboxEvent(client, {
      tenantId,
      eventId:`outbox_privacy_${eventSuffix}`,
      aggregateType:"data_subject_request",
      aggregateId:requestId,
      eventType:`privacy.request.${normalizedTarget}`,
      payload:{ request_id:requestId, request_type:current.request_type, status:normalizedTarget }
    });
    return publicRequest(updated.rows[0], fieldEncryption);
  });

  return { create, get, list, transition };
}

let defaultStore;
export const getPostgresPrivacyRequestStore = (options = {}) => {
  if (!defaultStore) defaultStore = createPostgresPrivacyRequestStore(options);
  return defaultStore;
};

export const resetPostgresPrivacyRequestStoreForTest = () => { defaultStore = undefined; };
