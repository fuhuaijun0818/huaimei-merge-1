import { createHmac } from "node:crypto";

import { normalizeTenantId } from "./platform/tenant-context.mjs";
import { getPostgresPrivacyRequestStore } from "./persistence/postgres-privacy-request-store.mjs";
import { getPostgresPrivacyExecutionStore } from "./persistence/postgres-privacy-execution-store.mjs";
import { verifyPrivacyIdentityAttestation } from "./platform/privacy-identity-attestation.mjs";
import { verifyPrivacyCompletionAttestation } from "./platform/privacy-completion-attestation.mjs";
import { verifyPrivacyCancellationAttestation } from "./platform/privacy-cancellation-attestation.mjs";

const normalizeMobile = (value = "") => String(value)
  .replace(/^\+?86/, "")
  .replace(/[\s()-]/g, "");

const privacyError = (code, message, status = 400) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  return error;
};

const privacyPepper = (env = process.env) => {
  const value = String(env.HUAMEI_IDENTITY_PEPPER || "");
  const production = ["prod", "production"].includes(String(
    env.HUAMEI_RUNTIME_ENV || env.HUAMEI_DEPLOYMENT_ENV || env.NODE_ENV || "development"
  ).trim().toLowerCase());
  if (production && value.length < 32) {
    throw privacyError("PRIVACY_IDENTITY_PEPPER_REQUIRED", "正式环境缺少个人信息主体索引密钥", 503);
  }
  return value || "times-beauty-local-mvp-v1";
};

export const privacySubjectReference = (mobile, tenantId, env = process.env) => {
  const normalized = normalizeMobile(mobile);
  if (!/^1[3-9]\d{9}$/.test(normalized)) {
    throw privacyError("PRIVACY_MOBILE_INVALID", "请输入用于身份核验的11位中国大陆手机号");
  }
  return createHmac("sha256", privacyPepper(env))
    .update(`${tenantId}:${normalized}`)
    .digest("hex");
};

export async function createPrivacyRightsRequest(payload = {}, context = {}) {
  const tenantId = normalizeTenantId(payload.tenant_id || context.tenantId);
  const subjectReferenceHmac = privacySubjectReference(payload.mobile, tenantId, context.env || process.env);
  return getPostgresPrivacyRequestStore({
    slaHours:context.slaHours || process.env.HUAMEI_PRIVACY_REQUEST_SLA_HOURS
  }).create({
    tenantId,
    requestId:payload.request_id,
    requestType:payload.request_type,
    subjectReferenceHmac,
    scope:payload.scope,
    createdBy:context.actor || "customer_request",
    requestSource:context.source || "customer_service"
  });
}

export async function getPrivacyRightsRequest(tenantId, requestId) {
  return getPostgresPrivacyRequestStore().get({ tenantId:normalizeTenantId(tenantId), requestId });
}

export async function listPrivacyRightsRequests(tenantId, filters = {}) {
  return getPostgresPrivacyRequestStore().list({
    tenantId:normalizeTenantId(tenantId),
    status:filters.status,
    limit:filters.limit
  });
}

export async function transitionPrivacyRightsRequest(payload = {}, identity = {}) {
  const tenantId = normalizeTenantId(payload.tenant_id);
  if (!identity.subject || !identity.roles?.includes("privacy.processor")) {
    throw privacyError("PRIVACY_PROCESSOR_FORBIDDEN", "当前实名账号无权处理个人信息权利请求", 403);
  }
  const terminal = ["fulfilled", "partially_fulfilled", "rejected", "cancelled"]
    .includes(String(payload.status || "").toLowerCase());
  if (terminal && !identity.roles.includes("privacy.approver")) {
    throw privacyError("PRIVACY_APPROVER_REQUIRED", "完成、拒绝或取消个人信息权利请求需要复核角色", 403);
  }
  if (payload.legal_hold !== undefined && !identity.roles.includes("privacy.approver")) {
    throw privacyError("PRIVACY_LEGAL_HOLD_FORBIDDEN", "设置或解除保全状态需要复核角色", 403);
  }
  if (payload.identity_evidence !== undefined) {
    throw privacyError(
      "PRIVACY_IDENTITY_SELF_ASSERTION_FORBIDDEN",
      "处理人不能自行声明身份已核验；请提交可信核验适配器签发的证明",
      409
    );
  }
  if (payload.cancellation_basis !== undefined) {
    throw privacyError(
      "PRIVACY_CANCELLATION_SELF_ASSERTION_FORBIDDEN",
      "处理人不能自行填写主体撤回依据；请提交可信适配器签发的取消证明",
      409
    );
  }
  const attestationToken = String(payload.identity_verification_attestation || "").trim();
  const identityAttestation = attestationToken
    ? verifyPrivacyIdentityAttestation({
        tenantId,
        requestId:payload.request_id,
        token:attestationToken,
        env:identity.env || process.env
      })
    : null;
  if (attestationToken && !identityAttestation) {
    throw privacyError(
      "PRIVACY_IDENTITY_ATTESTATION_INVALID",
      "身份核验证明无效、已过期或与当前租户及请求不匹配",
      409
    );
  }
  const completionToken = String(payload.completion_attestation || "").trim();
  const completionAttestation = completionToken
    ? verifyPrivacyCompletionAttestation({
        tenantId,
        requestId:payload.request_id,
        token:completionToken,
        env:identity.env || process.env
      })
    : null;
  if (completionToken && !completionAttestation) {
    throw privacyError(
      "PRIVACY_COMPLETION_ATTESTATION_INVALID",
      "执行/交付证明无效、已过期或与当前租户及请求不匹配",
      409
    );
  }
  const cancellationToken = String(payload.cancellation_attestation || "").trim();
  if (cancellationToken && String(payload.status || "").trim().toLowerCase() !== "cancelled") {
    throw privacyError(
      "PRIVACY_CANCELLATION_ATTESTATION_UNEXPECTED",
      "主体撤回证明仅可用于取消个人信息权利请求",
      409
    );
  }
  const cancellationAttestation = cancellationToken
    ? verifyPrivacyCancellationAttestation({
        tenantId,
        requestId:payload.request_id,
        token:cancellationToken,
        env:identity.env || process.env
      })
    : null;
  if (cancellationToken && !cancellationAttestation) {
    throw privacyError(
      "PRIVACY_CANCELLATION_ATTESTATION_INVALID",
      "主体撤回证明无效、已过期或与当前租户及请求不匹配",
      409
    );
  }
  return getPostgresPrivacyRequestStore().transition({
    tenantId,
    requestId:payload.request_id,
    targetStatus:payload.status,
    actor:identity.subject,
    identityAttestation,
    completionAttestation,
    cancellationAttestation,
    result:payload.result,
    legalHold:payload.legal_hold
  });
}

export async function preparePrivacyRightsExecution(payload = {}, identity = {}) {
  const tenantId = normalizeTenantId(payload.tenant_id);
  if (!identity.subject || !identity.roles?.includes("privacy.processor")) {
    throw privacyError("PRIVACY_PROCESSOR_FORBIDDEN", "当前实名账号无权准备个人信息权利执行", 403);
  }
  return getPostgresPrivacyExecutionStore().prepare({
    tenantId,
    requestId:payload.request_id,
    processorId:identity.subject
  });
}

export async function approvePrivacyRightsExecution(payload = {}, identity = {}) {
  const tenantId = normalizeTenantId(payload.tenant_id);
  if (!identity.subject || !identity.roles?.includes("privacy.approver")) {
    throw privacyError("PRIVACY_APPROVER_REQUIRED", "批准个人信息权利执行需要独立复核角色", 403);
  }
  return getPostgresPrivacyExecutionStore().approve({
    tenantId,
    requestId:payload.request_id,
    approverId:identity.subject
  });
}

export async function getPrivacyRightsExecution(tenantId, requestId) {
  return getPostgresPrivacyExecutionStore().getByRequest({
    tenantId:normalizeTenantId(tenantId),
    requestId
  });
}

export async function isPrivacyContactSuppressed({ tenant_id:tenantId, subject_reference_hmac:subjectReferenceHmac, purpose }) {
  return getPostgresPrivacyExecutionStore().isSuppressed({
    tenantId:normalizeTenantId(tenantId),
    subjectReferenceHmac,
    purpose
  });
}
