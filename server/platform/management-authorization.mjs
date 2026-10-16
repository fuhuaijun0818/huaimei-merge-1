import { normalizeTenantId } from "./tenant-context.mjs";
import { getOidcVerifier } from "./oidc-auth.mjs";
import {
  MANAGEMENT_TECHNICAL_ROLES,
  effectiveManagementRolesFor,
  hasPhaseOneCapability,
  phaseOneCapabilitiesFor,
  phaseOneRoleResolutionFor
} from "./phase-one-role-policy.mjs";

// Kept as a compatibility export for current routers and service endpoints.
// Product-facing identity is limited to the phase-one business roles in
// phase-one-role-policy.mjs.
export const MANAGEMENT_ROLES = MANAGEMENT_TECHNICAL_ROLES;

const authorizationError = (code, message, status = 403, details = []) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
};

const claimValues = (value) => {
  const source = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[\s,]+/)
      : [];
  return source.map(String).map((item) => item.trim()).filter(Boolean);
};

const normalizedTenant = (value, field = "tenant_id") => {
  try { return normalizeTenantId(value); }
  catch (cause) {
    throw authorizationError(
      cause?.code || "INVALID_TENANT_ID",
      "tenant_id格式不正确",
      400,
      [{ field, message:"必须是有效的租户标识" }]
    );
  }
};

export function authorizeManagementPrincipal(principal, options = {}) {
  if (!principal || !String(principal.subject || "").trim()) {
    throw authorizationError("OIDC_SUBJECT_MISSING", "OIDC subject is missing", 401);
  }
  const roles = new Set(claimValues(principal.roles));
  const effectiveRoles = new Set(effectiveManagementRolesFor(principal));
  const phaseOneRoleResolution = phaseOneRoleResolutionFor(principal);
  const phaseOneRole = phaseOneRoleResolution.role;
  const phaseOneCapabilities = phaseOneCapabilitiesFor(principal);
  const requiredRoles = claimValues(options.requiredRoles);
  if (requiredRoles.length && !requiredRoles.some((role) => effectiveRoles.has(role))) {
    throw authorizationError("OIDC_ROLE_FORBIDDEN", "OIDC identity does not have the required role", 403);
  }
  const requiredAllRoles = claimValues(options.requiredAllRoles);
  const missingRoles = requiredAllRoles.filter((role) => !effectiveRoles.has(role));
  if (missingRoles.length) {
    throw authorizationError(
      "OIDC_ROLE_FORBIDDEN",
      "OIDC identity does not have every required role",
      403,
      missingRoles.map((role) => ({ role }))
    );
  }
  const requiredCapabilities = claimValues(options.requiredCapabilities);
  const missingCapabilities = requiredCapabilities.filter((capability) => !hasPhaseOneCapability(principal, capability));
  if (missingCapabilities.length) {
    throw authorizationError(
      "PHASE_ONE_CAPABILITY_FORBIDDEN",
      "当前一期角色无权执行该操作",
      403,
      missingCapabilities.map((capability) => ({ capability, role:phaseOneRole || "未配置" }))
    );
  }
  const requiredAnyCapabilities = claimValues(options.requiredAnyCapabilities);
  if (requiredAnyCapabilities.length
      && !requiredAnyCapabilities.some((capability) => hasPhaseOneCapability(principal, capability))) {
    throw authorizationError(
      "PHASE_ONE_CAPABILITY_FORBIDDEN",
      "当前一期角色无权执行该操作",
      403,
      requiredAnyCapabilities.map((capability) => ({ capability, role:phaseOneRole || "未配置" }))
    );
  }

  const tenantIds = claimValues(principal.tenantIds)
    .filter((tenantId) => tenantId !== "*")
    .map((tenantId) => normalizedTenant(tenantId, "token.tenant_ids"));
  if (claimValues(principal.tenantIds).includes("*")) {
    throw authorizationError(
      "OIDC_TENANT_WILDCARD_FORBIDDEN",
      "Human management identities must enumerate authorized tenants",
      403
    );
  }
  const uniqueTenantIds = [...new Set(tenantIds)];
  if (!uniqueTenantIds.length) {
    throw authorizationError("OIDC_TENANT_SCOPE_REQUIRED", "OIDC identity has no authorized tenant", 403);
  }

  const suppliedTenant = String(options.tenantId || "").trim();
  let tenantId;
  if (suppliedTenant) tenantId = normalizedTenant(suppliedTenant, options.tenantField || "tenant_id");
  else if (uniqueTenantIds.length === 1) tenantId = uniqueTenantIds[0];
  else if (hasPhaseOneCapability(principal, "superadmin:manage")) tenantId = uniqueTenantIds[0];
  else {
    throw authorizationError(
      "TENANT_CONTEXT_REQUIRED",
      "A tenant_id is required for a multi-tenant management identity",
      400,
      [{ field:options.tenantField || "tenant_id", message:"多租户身份必须明确选择租户" }]
    );
  }
  if (!uniqueTenantIds.includes(tenantId)) {
    throw authorizationError("OIDC_TENANT_FORBIDDEN", "OIDC identity is not authorized for this tenant", 403);
  }

  return Object.freeze({
    subject:String(principal.subject).trim().slice(0, 160),
    displayName:String(principal.displayName || principal.subject).trim().slice(0, 160),
    roles:[...roles],
    effectiveRoles:[...effectiveRoles],
    phaseOneRole,
    phaseOneRoleSource:phaseOneRoleResolution.source,
    phaseOneCapabilities,
    tenantIds:uniqueTenantIds,
    departmentIds:claimValues(principal.departmentIds),
    tenantId,
    issuer:String(principal.issuer || "").slice(0, 512),
    tokenId:principal.tokenId ? String(principal.tokenId).slice(0, 160) : null,
    authenticatedAt:principal.authenticatedAt || null
  });
}

export function createManagementAuthorizer(options = {}) {
  const verifier = options.oidcVerifier || getOidcVerifier({ env:options.env || process.env });
  return Object.freeze({
    async authorize(request, requirements = {}) {
      const principal = await verifier.verifyAuthorizationHeader(request?.headers?.authorization);
      return authorizeManagementPrincipal(principal, requirements);
    }
  });
}
