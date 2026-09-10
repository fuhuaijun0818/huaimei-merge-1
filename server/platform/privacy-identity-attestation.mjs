import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const PRIVACY_IDENTITY_ATTESTATION_SCHEMA = "huamei.privacy-identity-attestation.v1";
export const PRIVACY_VERIFICATION_SECRET_ENV = "HUAMEI_PRIVACY_VERIFICATION_SECRET";
export const PRIVACY_IDENTITY_METHODS = Object.freeze([
  "otp",
  "verified_callback",
  "verified_channel",
  "in_person_document"
]);

const allowedMethods = new Set(PRIVACY_IDENTITY_METHODS);
const verifiedAttestations = new WeakSet();
const sha256Pattern = /^[0-9a-f]{64}$/;
const requestIdPattern = /^dsr_[A-Za-z0-9._:-]{8,124}$/;
const safeReferencePattern = /^[A-Za-z0-9][A-Za-z0-9._:/-]{3,159}$/;

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
  verification_id:String(claims.verification_id || "").trim(),
  method:String(claims.method || "").trim().toLowerCase(),
  issued_at:Number(claims.issued_at),
  expires_at:Number(claims.expires_at)
});

const sign = (encodedClaims, secret) => createHmac("sha256", secret)
  .update(encodedClaims)
  .digest("base64url");

const validClaims = (claims, nowSeconds, { requireCurrent = true } = {}) => Boolean(
  claims.schema === PRIVACY_IDENTITY_ATTESTATION_SCHEMA
  && claims.tenant_id
  && sha256Pattern.test(claims.subject_reference_hmac)
  && requestIdPattern.test(claims.request_id)
  && safeReferencePattern.test(claims.verification_id)
  && allowedMethods.has(claims.method)
  && Number.isInteger(claims.issued_at)
  && Number.isInteger(claims.expires_at)
  && claims.expires_at > claims.issued_at
  && claims.expires_at - claims.issued_at <= 900
  && (!requireCurrent || (
    claims.issued_at <= nowSeconds + 30
    && claims.expires_at > nowSeconds
  ))
);

const attestationFrom = (claims) => {
  const attestation = Object.freeze({
    verified:true,
    tenant_id:claims.tenant_id,
    subject_reference_hmac:claims.subject_reference_hmac,
    request_id:claims.request_id,
    verification_id:claims.verification_id,
    method:claims.method,
    issued_at:claims.issued_at,
    expires_at:claims.expires_at
  });
  verifiedAttestations.add(attestation);
  return attestation;
};

export function issuePrivacyIdentityAttestation({
  tenantId,
  subjectReferenceHmac,
  requestId,
  verificationId = `piv_${randomUUID()}`,
  method,
  ttlSeconds = 300,
  now = Date.now(),
  env = process.env,
  secret = env[PRIVACY_VERIFICATION_SECRET_ENV]
} = {}) {
  if (!strongSecret(secret)) {
    const error = new Error(`${PRIVACY_VERIFICATION_SECRET_ENV} must be an independent random value of at least 32 characters`);
    error.code = "PRIVACY_VERIFICATION_SECRET_INVALID";
    throw error;
  }
  const issuedAt = Math.floor(Number(now) / 1000);
  const claims = canonicalClaims({
    schema:PRIVACY_IDENTITY_ATTESTATION_SCHEMA,
    tenant_id:tenantId,
    subject_reference_hmac:subjectReferenceHmac,
    request_id:requestId,
    verification_id:verificationId,
    method,
    issued_at:issuedAt,
    expires_at:issuedAt + Math.min(900, Math.max(30, Number(ttlSeconds) || 300))
  });
  if (!validClaims(claims, issuedAt, { requireCurrent:false })) {
    const error = new Error("Privacy identity attestation claims are invalid or use an unapproved verification method");
    error.code = "PRIVACY_IDENTITY_ATTESTATION_CLAIMS_INVALID";
    throw error;
  }
  const encoded = Buffer.from(JSON.stringify(claims), "utf8").toString("base64url");
  return `${encoded}.${sign(encoded, String(secret).trim())}`;
}

export function verifyPrivacyIdentityAttestation({
  tenantId,
  requestId,
  token,
  now = Date.now(),
  env = process.env
} = {}) {
  const secret = String(env[PRIVACY_VERIFICATION_SECRET_ENV] || "").trim();
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

export function assertPrivacyIdentityAttestation(attestation, {
  tenantId,
  subjectReferenceHmac,
  requestId,
  now = Date.now()
} = {}) {
  const nowSeconds = Math.floor(Number(now) / 1000);
  const valid = Boolean(attestation
    && verifiedAttestations.has(attestation)
    && attestation.verified === true
    && attestation.tenant_id === String(tenantId || "").trim().toLowerCase()
    && attestation.subject_reference_hmac === String(subjectReferenceHmac || "").trim().toLowerCase()
    && attestation.request_id === String(requestId || "").trim()
    && allowedMethods.has(attestation.method)
    && attestation.expires_at > nowSeconds);
  if (!valid) {
    const error = new Error("身份核验证明与当前租户、主体或权利请求不匹配");
    error.code = "PRIVACY_IDENTITY_ATTESTATION_SUBJECT_MISMATCH";
    error.status = 409;
    throw error;
  }
  return attestation;
}

export function privacyVerificationConfiguration(env = process.env) {
  return { configured:strongSecret(env[PRIVACY_VERIFICATION_SECRET_ENV]) };
}
