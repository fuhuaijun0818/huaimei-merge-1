import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import {
  PHASE_ONE_BUSINESS_ROLES,
  normalizePhaseOneBusinessRole,
  phaseOneCapabilitiesFor,
  phaseOneTechnicalRolesFor
} from "./phase-one-role-policy.mjs";

export const LOCAL_IDENTITY_HEADERS = Object.freeze({
  subject:"x-huamei-local-admin-subject",
  issuedAt:"x-huamei-local-admin-issued-at",
  signature:"x-huamei-local-admin-signature"
});

const productionEnvironment = (env) => ["prod", "production"].includes(String(
  env.HUAMEI_RUNTIME_ENV || env.HUAMEI_DEPLOYMENT_ENV || env.NODE_ENV || "development"
).trim().toLowerCase());
const loopback = (value) => ["127.0.0.1", "localhost", "::1", "::ffff:127.0.0.1"].includes(String(value || ""));
const safeSubject = (value) => {
  const subject = String(value || "local-admin").trim();
  if (!/^[a-z0-9][a-z0-9_.:@/-]{2,127}$/i.test(subject)) {
    const error = new Error("HUAMEI_LOCAL_ADMIN_SUBJECT is invalid");
    error.code = "LOCAL_ADMIN_SUBJECT_INVALID";
    throw error;
  }
  return subject;
};
const signingInput = ({ subject, tenantId, method, pathname, issuedAt }) => [
  "huamei.local-management-identity.v1",
  safeSubject(subject),
  String(tenantId || "").trim().toLowerCase(),
  String(method || "GET").trim().toUpperCase(),
  String(pathname || "/").trim(),
  String(issuedAt || "").trim()
].join("\n");
const secretFor = (env) => String(env.HUAMEI_LOCAL_ADMIN_BRIDGE_SECRET || "").trim();
const signatureFor = (input, secret) => createHmac("sha256", secret).update(input).digest("base64url");
const safeEqual = (left, right) => {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && timingSafeEqual(a, b);
};
const identityError = (code, message, status = 401) => Object.assign(new Error(message), { code, status });
const localBusinessRole = (env) => {
  const configured = String(
    env.HUAMEI_LOCAL_MANAGEMENT_ROLE || PHASE_ONE_BUSINESS_ROLES.administrator
  ).trim();
  const role = normalizePhaseOneBusinessRole(configured);
  if (!role) {
    throw identityError(
      "LOCAL_MANAGEMENT_ROLE_INVALID",
      "HUAMEI_LOCAL_MANAGEMENT_ROLE must be 管理员 or 售前人员",
      503
    );
  }
  return role;
};

export function issueLocalManagementIdentity(options = {}) {
  const env = options.env || process.env;
  if (productionEnvironment(env) || !loopback(options.gatewayHost) || !loopback(options.serviceUrl?.hostname)) {
    throw identityError("LOCAL_MANAGEMENT_IDENTITY_FORBIDDEN", "Local management identity is limited to non-production loopback", 403);
  }
  const secret = secretFor(env);
  if (secret.length < 32) throw identityError("LOCAL_MANAGEMENT_BRIDGE_NOT_CONFIGURED", "Local management bridge secret is not configured", 503);
  localBusinessRole(env);
  const subject = safeSubject(options.subject || env.HUAMEI_LOCAL_ADMIN_SUBJECT);
  const issuedAt = String(options.issuedAt || Date.now());
  const input = signingInput({ ...options, subject, issuedAt });
  return {
    subject,
    headers:{
      [LOCAL_IDENTITY_HEADERS.subject]:subject,
      [LOCAL_IDENTITY_HEADERS.issuedAt]:issuedAt,
      [LOCAL_IDENTITY_HEADERS.signature]:signatureFor(input, secret)
    }
  };
}

export function verifyLocalManagementIdentity(options = {}) {
  const env = options.env || process.env;
  if (productionEnvironment(env) || !loopback(options.serviceHost) || !loopback(options.remoteAddress)) {
    throw identityError("LOCAL_MANAGEMENT_IDENTITY_FORBIDDEN", "Local management identity is disabled outside non-production loopback", 403);
  }
  const secret = secretFor(env);
  if (secret.length < 32) throw identityError("LOCAL_MANAGEMENT_BRIDGE_NOT_CONFIGURED", "Local management bridge secret is not configured", 503);
  const phaseOneRole = localBusinessRole(env);
  const headers = options.headers || {};
  const subject = safeSubject(headers[LOCAL_IDENTITY_HEADERS.subject]);
  const issuedAt = String(headers[LOCAL_IDENTITY_HEADERS.issuedAt] || "");
  const issuedAtMs = Number(issuedAt);
  const now = Number(options.nowMs || Date.now());
  if (!Number.isFinite(issuedAtMs) || Math.abs(now - issuedAtMs) > 30_000) {
    throw identityError("LOCAL_MANAGEMENT_IDENTITY_EXPIRED", "Local management identity proof expired");
  }
  const input = signingInput({ ...options, subject, issuedAt });
  if (!safeEqual(headers[LOCAL_IDENTITY_HEADERS.signature], signatureFor(input, secret))) {
    throw identityError("LOCAL_MANAGEMENT_IDENTITY_INVALID", "Local management identity proof is invalid");
  }
  return Object.freeze({
    subject,
    // Local development remains usable out of the box, but its product role is
    // now explicit and constrained to the two phase-one business roles.
    roles:[phaseOneRole, ...phaseOneTechnicalRolesFor(phaseOneRole)],
    phaseOneRole,
    phaseOneRoleSource:"explicit",
    capabilities:phaseOneCapabilitiesFor(phaseOneRole),
    tenantIds:[String(options.tenantId || "").trim().toLowerCase()],
    issuer:"urn:huamei:local-development-bridge",
    developmentCompatibility:true
  });
}

export const localManagementIdentityEnabled = (env = process.env) => !productionEnvironment(env)
  && secretFor(env).length >= 32;

export const EXTERNAL_TEST_IDENTITY_HEADERS = Object.freeze({
  subject:"x-huamei-external-admin-subject",
  issuedAt:"x-huamei-external-admin-issued-at",
  signature:"x-huamei-external-admin-signature"
});
const internalAddress = (value) => {
  const address = String(value || "").replace(/^::ffff:/, "");
  if (loopback(address)) return true;
  if (isIP(address) !== 4) return false;
  const [first, second] = address.split(".").map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
};
const externalTestBridgeConfig = (env, tenantId, callerId) => {
  const runtime = String(env.HUAMEI_RUNTIME_ENV || env.HUAMEI_DEPLOYMENT_ENV || env.NODE_ENV || "").trim().toLowerCase();
  const tenant = String(env.HUAMEI_PUBLIC_TENANT_ID || env.HUAMEI_DEFAULT_TENANT_ID || "huamei-shanghai").trim().toLowerCase();
  if (runtime !== "staging" || String(env.HUAMEI_EXTERNAL_TEST_MODE).toLowerCase() !== "true"
      || callerId !== "huamei_web_gateway" || tenantId !== tenant) {
    throw identityError("EXTERNAL_TEST_MANAGEMENT_IDENTITY_FORBIDDEN", "External-test management bridge scope is not permitted", 403);
  }
  const secret = String(env.HUAMEI_EXTERNAL_TEST_ADMIN_BRIDGE_SECRET || "").trim();
  if (secret.length < 32) throw identityError("EXTERNAL_TEST_MANAGEMENT_BRIDGE_NOT_CONFIGURED", "External-test management bridge secret is not configured", 503);
  return { secret, tenant, role:localBusinessRole(env) };
};
const externalSigningInput = (options, role) => [
  "huamei.external-test-management-identity.v1",
  options.callerId,
  role,
  signingInput(options)
].join("\n");

export function issueExternalTestManagementIdentity(options = {}) {
  const env = options.env || process.env;
  const config = externalTestBridgeConfig(env, options.tenantId, options.callerId);
  const target = options.serviceUrl;
  if (!target || !["http:", "https:"].includes(target.protocol) || target.username || target.password
      || !(target.hostname === "acquisition" || internalAddress(target.hostname))) {
    throw identityError("EXTERNAL_TEST_MANAGEMENT_IDENTITY_FORBIDDEN", "Management proof may only be sent to the internal acquisition service", 403);
  }
  const subject = safeSubject(options.subject || env.HUAMEI_LOCAL_ADMIN_SUBJECT);
  const issuedAt = String(options.issuedAt || Date.now());
  return { subject, headers:{
    [EXTERNAL_TEST_IDENTITY_HEADERS.subject]:subject,
    [EXTERNAL_TEST_IDENTITY_HEADERS.issuedAt]:issuedAt,
    [EXTERNAL_TEST_IDENTITY_HEADERS.signature]:signatureFor(externalSigningInput({ ...options, subject, issuedAt }, config.role), config.secret)
  } };
}

export function verifyExternalTestManagementIdentity(options = {}) {
  const env = options.env || process.env;
  const config = externalTestBridgeConfig(env, options.tenantId, options.authenticatedCaller?.caller_id);
  // The caller must come from authenticatedCaller(), after an actual service
  // key comparison. A browser-supplied caller header is not an identity.
  if (options.authenticatedCaller?.service_key_verified !== true || !internalAddress(options.remoteAddress)) {
    throw identityError("EXTERNAL_TEST_MANAGEMENT_IDENTITY_FORBIDDEN", "Authenticated internal gateway service is required", 403);
  }
  const headers = options.headers || {};
  const subject = safeSubject(headers[EXTERNAL_TEST_IDENTITY_HEADERS.subject]);
  const issuedAt = String(headers[EXTERNAL_TEST_IDENTITY_HEADERS.issuedAt] || "");
  if (!Number.isFinite(Number(issuedAt)) || Math.abs(Number(options.nowMs || Date.now()) - Number(issuedAt)) > 30_000) {
    throw identityError("EXTERNAL_TEST_MANAGEMENT_IDENTITY_EXPIRED", "External-test management proof expired");
  }
  const input = externalSigningInput({ ...options, callerId:options.authenticatedCaller.caller_id, subject, issuedAt }, config.role);
  if (!safeEqual(headers[EXTERNAL_TEST_IDENTITY_HEADERS.signature], signatureFor(input, config.secret))) {
    throw identityError("EXTERNAL_TEST_MANAGEMENT_IDENTITY_INVALID", "External-test management proof is invalid");
  }
  return Object.freeze({
    subject, roles:[config.role, ...phaseOneTechnicalRolesFor(config.role)],
    phaseOneRole:config.role, capabilities:phaseOneCapabilitiesFor(config.role),
    tenantIds:[config.tenant], issuer:"urn:huamei:external-test-management-bridge",
    developmentCompatibility:true
  });
}
