import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const PRIVACY_COMPLETION_ATTESTATION_SCHEMA = "huamei.privacy-completion-attestation.v1";
export const PRIVACY_COMPLETION_SECRET_ENV = "HUAMEI_PRIVACY_COMPLETION_SECRET";
export const PRIVACY_COMPLETION_METHODS = Object.freeze({
  access:new Set(["secure_delivery"]),
  correct:new Set(["authoritative_correction"])
});

const verifiedAttestations = new WeakSet();
const sha256Pattern = /^[0-9a-f]{64}$/;
const requestIdPattern = /^dsr_[A-Za-z0-9._:-]{8,124}$/;
const safeReferencePattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{3,159}$/;
const allowedStatuses = new Set(["fulfilled", "partially_fulfilled"]);

const looksPlaceholder = (value) => /(?:replace|placeholder|changeme|example|dummy|fake|test[-_ ]?(?:key|secret))/i
  .test(String(value || ""));

const strongSecret = (value) => {
  const normalized = String(value || "").trim();
  return normalized.length >= 32
    && new Set(normalized).size >= 8
    && !/\s/.test(normalized)
    && !looksPlaceholder(normalized);
};

const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
};

const canonicalClaims = (claims) => ({
  schema:String(claims.schema || "").trim(),
  tenant_id:String(claims.tenant_id || "").trim().toLowerCase(),
  subject_reference_hmac:String(claims.subject_reference_hmac || "").trim().toLowerCase(),
  request_id:String(claims.request_id || "").trim(),
  request_type:String(claims.request_type || "").trim().toLowerCase(),
  target_status:String(claims.target_status || "").trim().toLowerCase(),
  evidence_id:String(claims.evidence_id || "").trim(),
  action_reference:String(claims.action_reference || "").trim(),
  method:String(claims.method || "").trim().toLowerCase(),
  completed_at:Number(claims.completed_at),
  issued_at:Number(claims.issued_at),
  expires_at:Number(claims.expires_at)
});

const sign = (encodedClaims, secret) => createHmac("sha256", secret)
  .update(encodedClaims)
  .digest("base64url");

const validClaims = (claims, nowSeconds, { requireCurrent = true } = {}) => Boolean(
  claims.schema === PRIVACY_COMPLETION_ATTESTATION_SCHEMA
  && claims.tenant_id
  && sha256Pattern.test(claims.subject_reference_hmac)
  && requestIdPattern.test(claims.request_id)
  && PRIVACY_COMPLETION_METHODS[claims.request_type]?.has(claims.method)
  && allowedStatuses.has(claims.target_status)
  && safeReferencePattern.test(claims.evidence_id)
  && safeReferencePattern.test(claims.action_reference)
  && Number.isInteger(claims.completed_at)
  && Number.isInteger(claims.issued_at)
  && Number.isInteger(claims.expires_at)
  && claims.completed_at <= claims.issued_at + 30
  && claims.completed_at >= claims.issued_at - 30 * 24 * 60 * 60
  && claims.expires_at > claims.issued_at
  && claims.expires_at - claims.issued_at <= 900
  && (!requireCurrent || (
    claims.issued_at <= nowSeconds + 30
    && claims.expires_at > nowSeconds
  ))
);

const attestationFrom = (claims) => {
  const attestation = Object.freeze({ verified:true, ...claims });
  verifiedAttestations.add(attestation);
  return attestation;
};

export function issuePrivacyCompletionAttestation({
  tenantId,
  subjectReferenceHmac,
  requestId,
  requestType,
  targetStatus = "fulfilled",
  evidenceId = `pce_${randomUUID()}`,
  actionReference,
  method,
  completedAt = Date.now(),
  ttlSeconds = 300,
  now = Date.now(),
  env = process.env,
  secret = env[PRIVACY_COMPLETION_SECRET_ENV]
} = {}) {
  if (!strongSecret(secret)) {
    const error = new Error(`${PRIVACY_COMPLETION_SECRET_ENV} must be an independent random value of at least 32 characters`);
    error.code = "PRIVACY_COMPLETION_SECRET_INVALID";
    throw error;
  }
  const issuedAt = Math.floor(Number(now) / 1000);
  const claims = canonicalClaims({
    schema:PRIVACY_COMPLETION_ATTESTATION_SCHEMA,
    tenant_id:tenantId,
    subject_reference_hmac:subjectReferenceHmac,
    request_id:requestId,
    request_type:requestType,
    target_status:targetStatus,
    evidence_id:evidenceId,
    action_reference:actionReference,
    method,
    completed_at:Math.floor(Number(completedAt) / 1000),
    issued_at:issuedAt,
    expires_at:issuedAt + Math.min(900, Math.max(30, Number(ttlSeconds) || 300))
  });
  if (!validClaims(claims, issuedAt, { requireCurrent:false })) {
    const error = new Error("Privacy completion attestation claims are invalid or incompatible with the request type");
    error.code = "PRIVACY_COMPLETION_ATTESTATION_CLAIMS_INVALID";
    throw error;
  }
  const encoded = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${encoded}.${sign(encoded, String(secret).trim())}`;
}

export function verifyPrivacyCompletionAttestation({
  tenantId,
  requestId,
  token,
  now = Date.now(),
  env = process.env
} = {}) {
  const secret = String(env[PRIVACY_COMPLETION_SECRET_ENV] || "").trim();
  if (!strongSecret(secret)) return null;
  const parts = String(token || "").trim().split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1] || !safeEqual(sign(parts[0], secret), parts[1])) return null;
  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
  } catch {
    return null;
  }
  const claims = canonicalClaims(parsed);
  const nowSeconds = Math.floor(Number(now) / 1000);
  if (!validClaims(claims, nowSeconds)
      || claims.tenant_id !== String(tenantId || "").trim().toLowerCase()
      || claims.request_id !== String(requestId || "").trim()) return null;
  return attestationFrom(claims);
}

export function assertPrivacyCompletionAttestation(attestation, {
  tenantId,
  subjectReferenceHmac,
  requestId,
  requestType,
  targetStatus,
  now = Date.now()
} = {}) {
  const nowSeconds = Math.floor(Number(now) / 1000);
  const valid = Boolean(attestation
    && verifiedAttestations.has(attestation)
    && attestation.verified === true
    && attestation.tenant_id === String(tenantId || "").trim().toLowerCase()
    && attestation.subject_reference_hmac === String(subjectReferenceHmac || "").trim().toLowerCase()
    && attestation.request_id === String(requestId || "").trim()
    && attestation.request_type === String(requestType || "").trim().toLowerCase()
    && attestation.target_status === String(targetStatus || "").trim().toLowerCase()
    && PRIVACY_COMPLETION_METHODS[attestation.request_type]?.has(attestation.method)
    && attestation.expires_at > nowSeconds);
  if (!valid) {
    const error = new Error("执行/交付证明与当前租户、主体、请求类型或目标状态不匹配");
    error.code = "PRIVACY_COMPLETION_ATTESTATION_MISMATCH";
    error.status = 409;
    throw error;
  }
  return attestation;
}

export function privacyCompletionConfiguration(env = process.env) {
  return { configured:strongSecret(env[PRIVACY_COMPLETION_SECRET_ENV]) };
}
