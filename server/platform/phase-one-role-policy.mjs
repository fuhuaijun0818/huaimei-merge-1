import { ROLE_CATALOG, roleCatalogEntry } from "../../src/role-catalog.js";

export const PHASE_ONE_BUSINESS_ROLES = Object.freeze(Object.fromEntries(ROLE_CATALOG.map(r=>[r.key,r.name])));
export const PHASE_ONE_BUSINESS_ROLE_IDS = Object.freeze(Object.fromEntries(ROLE_CATALOG.map(r=>[r.key,r.claim])));

export const MANAGEMENT_TECHNICAL_ROLES = Object.freeze({
  customerRead:"customer:read",
  serviceRead:"service:read",
  runsRead:"runs:read",
  knowledgeRead:"knowledge:read",
  knowledgeIntakeRead:"knowledge:intake:read",
  knowledgeIntakeWrite:"knowledge:intake:write",
  knowledgeIntakeSubmit:"knowledge:intake:submit",
  knowledgeIntakeDepartmentReview:"knowledge:intake:department_review",
  knowledgeBusinessReview:"knowledge.business_reviewer",
  knowledgeMedicalReview:"knowledge.medical_reviewer",
  knowledgeComplianceReview:"knowledge.compliance_reviewer",
  avatarRead:"physician-avatar:read",
  avatarWrite:"physician-avatar:write",
  appointmentRead:"appointment:read",
  appointmentWrite:"appointment:write",
  scheduleRead:"schedule:read",
  scheduleWrite:"schedule:write",
  operationsAgent:"operations.agent",
  contactReveal:"contact:reveal"
});

export const PHASE_ONE_CAPABILITIES = Object.freeze({
  platformManage:"platform:manage",
  usersManage:"users:manage",
  agentsManage:"agents:manage",
  hospitalDataManage:"hospital-data:manage",
  knowledgeManage:"knowledge:manage",
  knowledgeRead:"knowledge:read",
  knowledgePublish:"knowledge:publish",
  knowledgeRollback:"knowledge:rollback",
  knowledgeWithdraw:"knowledge:withdraw",
  evaluationsRead:"evaluations:read",
  evaluationsRun:"evaluations:run",
  feedbackManage:"feedback:manage",
  conversationsReadRedacted:"conversations:read_redacted",
  servicesTransfer:"services:transfer",
  templatesManage:"templates:manage",
  templatesRead:"templates:read",
  customersReadAll:"customers:read_all",
  customersReadAssigned:"customers:read_assigned",
  conversationsReadAll:"conversations:read_all",
  conversationsReadAssigned:"conversations:read_assigned",
  conversationsTakeover:"conversations:takeover",
  conversationsReply:"conversations:reply",
  conversationsComplete:"conversations:complete",
  contactsRevealAssigned:"contacts:reveal_assigned",
  contactsRevealAll:"contacts:reveal_all",
  superadminManage:"superadmin:manage",
  appointmentsManage:"appointments:manage",
  appointmentsReadAssigned:"appointments:read_assigned",
  appointmentsManageAssigned:"appointments:manage_assigned",
  analyticsRead:"analytics:read",
  auditRead:"audit:read",
  integrationsManage:"integrations:manage",
  systemManage:"system:manage"
});

const ALL_CAPABILITIES = Object.freeze(Object.values(PHASE_ONE_CAPABILITIES));
export const PHASE_ONE_ROLE_CAPABILITIES = Object.freeze(Object.fromEntries(ROLE_CATALOG.map(r=>[r.name,r.capabilities])));
export const PHASE_ONE_ROLE_TECHNICAL_COMPATIBILITY = Object.freeze(Object.fromEntries(ROLE_CATALOG.map(r=>[r.name,r.technical])));
const BUSINESS_ROLE_ALIASES = { get:value=>roleCatalogEntry(value)?.name || null };

// These aliases preserve a safe migration path for already-issued development
// and human-handoff tokens.  They are considered only when a token has no
// explicit business role; an explicit 管理员 plus operations.agent is still an
// administrator, not a role conflict.
const LEGACY_ROLE_ALIASES = Object.freeze(new Map([
  ["development:admin", PHASE_ONE_BUSINESS_ROLES.administrator],
  [MANAGEMENT_TECHNICAL_ROLES.operationsAgent, PHASE_ONE_BUSINESS_ROLES.presales]
]));

const policyError = (code, message, status = 403, details = []) => {
  const error = new Error(message);
  error.code = code;
  error.status = status;
  error.details = details;
  return error;
};

const canonical = (value) => String(value || "").trim().toLowerCase();

const roleValues = (input) => {
  const source = Array.isArray(input)
    ? input
    : typeof input === "string"
      ? [input]
      : Array.isArray(input?.roles)
        ? input.roles
        : typeof input?.roles === "string"
          ? input.roles.split(/[\s,]+/)
        : [];
  return [...new Set(source.map(canonical).filter(Boolean))];
};

const businessRoleValue = (value) => {
  const normalized = canonical(value);
  return BUSINESS_ROLE_ALIASES.get(normalized) || null;
};

// An explicitly issued phase-one role may safely expand into its compatibility
// permissions.  A legacy technical claim must never gain sibling permissions
// during migration (for example, operations.agent alone must not suddenly gain
// contact:reveal).  The source marker is therefore part of the policy result.
const roleResolution = (input) => {
  const declaredRole = input && typeof input === "object" && !Array.isArray(input)
    && input.phaseOneRoleSource !== "legacy_technical"
    ? businessRoleValue(input.phaseOneRole)
    : null;
  const values = roleValues(input);
  const explicitRoles = new Set(values.map((value) => BUSINESS_ROLE_ALIASES.get(value)).filter(Boolean));
  if (explicitRoles.size > 1) {
    throw policyError(
      "PHASE_ONE_BUSINESS_ROLE_CONFLICT",
      "当前身份不能同时声明不同的岗位；请切换明确授权的岗位",
      403,
      [...explicitRoles].map((role) => ({ role }))
    );
  }
  if (declaredRole && explicitRoles.size === 1 && !explicitRoles.has(declaredRole)) {
    throw policyError(
      "PHASE_ONE_BUSINESS_ROLE_CONFLICT",
      "一期角色声明与角色权限不一致",
      403,
      [{ declared_role:declaredRole }, { claimed_role:[...explicitRoles][0] }]
    );
  }
  if (declaredRole) return Object.freeze({ role:declaredRole, source:"explicit" });
  if (explicitRoles.size === 1) {
    return Object.freeze({ role:[...explicitRoles][0], source:"explicit" });
  }

  const legacyRoles = new Set(values.map((value) => LEGACY_ROLE_ALIASES.get(value)).filter(Boolean));
  if (legacyRoles.size > 1) {
    throw policyError(
      "PHASE_ONE_BUSINESS_ROLE_CONFLICT",
      "一期身份包含相互冲突的历史业务权限",
      403,
      [...legacyRoles].map((role) => ({ role }))
    );
  }
  if (legacyRoles.size === 1) {
    return Object.freeze({ role:[...legacyRoles][0], source:"legacy_technical" });
  }
  return Object.freeze({ role:null, source:null });
};

const legacyTechnicalCapabilitiesFor = (input) => {
  const roles = new Set(roleValues(input));
  const capabilities = new Set();
  const has = (role) => roles.has(canonical(role));
  if (has(MANAGEMENT_TECHNICAL_ROLES.customerRead)) {
    capabilities.add(PHASE_ONE_CAPABILITIES.customersReadAssigned);
  }
  if (has(MANAGEMENT_TECHNICAL_ROLES.operationsAgent)) {
    capabilities.add(PHASE_ONE_CAPABILITIES.conversationsReadAssigned);
    capabilities.add(PHASE_ONE_CAPABILITIES.conversationsTakeover);
    capabilities.add(PHASE_ONE_CAPABILITIES.conversationsReply);
    capabilities.add(PHASE_ONE_CAPABILITIES.conversationsComplete);
  }
  if (has(MANAGEMENT_TECHNICAL_ROLES.operationsAgent)
      && has(MANAGEMENT_TECHNICAL_ROLES.contactReveal)) {
    capabilities.add(PHASE_ONE_CAPABILITIES.contactsRevealAssigned);
  }
  if (has(MANAGEMENT_TECHNICAL_ROLES.appointmentRead)
      || has(MANAGEMENT_TECHNICAL_ROLES.scheduleRead)) {
    capabilities.add(PHASE_ONE_CAPABILITIES.appointmentsReadAssigned);
  }
  if (has(MANAGEMENT_TECHNICAL_ROLES.appointmentWrite)
      || has(MANAGEMENT_TECHNICAL_ROLES.scheduleWrite)) {
    capabilities.add(PHASE_ONE_CAPABILITIES.appointmentsManageAssigned);
  }
  return Object.freeze([...capabilities]);
};

export const listPhaseOneBusinessRoles = () => Object.freeze(ROLE_CATALOG.map(r=>r.name));

export const normalizePhaseOneBusinessRole = (value) => businessRoleValue(value);

export const isPhaseOneBusinessRole = (value) => Boolean(businessRoleValue(value));

export const phaseOneRoleResolutionFor = (input) => roleResolution(input);

export function resolvePhaseOneBusinessRole(input, { required = false } = {}) {
  const resolution = roleResolution(input);
  if (resolution.role) return resolution.role;
  if (required) {
    throw policyError(
      "PHASE_ONE_BUSINESS_ROLE_REQUIRED",
      "当前身份未配置有效岗位",
      403,
      [{ allowed_roles:listPhaseOneBusinessRoles() }]
    );
  }
  return null;
}

export function phaseOneCapabilitiesFor(input) {
  const resolution = roleResolution(input);
  if (resolution.source === "explicit") {
    return Object.freeze([...(PHASE_ONE_ROLE_CAPABILITIES[resolution.role] || [])]);
  }
  return legacyTechnicalCapabilitiesFor(input);
}

export function phaseOneTechnicalRolesFor(input) {
  const role = resolvePhaseOneBusinessRole(input);
  return Object.freeze([...(PHASE_ONE_ROLE_TECHNICAL_COMPATIBILITY[role] || [])]);
}

export function effectiveManagementRolesFor(input) {
  const rawRoles = roleValues(input);
  const resolution = roleResolution(input);
  const compatibilityRoles = resolution.source === "explicit"
    ? phaseOneTechnicalRolesFor(resolution.role)
    : [];
  // Explicit business roles are a ceiling, not an additive privilege grant.
  // Old admin/reviewer claims cannot give a system administrator publishing rights.
  return Object.freeze(resolution.source === "explicit"
    ? [...new Set([resolution.role, ...compatibilityRoles])]
    : rawRoles);
}

export function hasPhaseOneCapability(input, capability) {
  const normalizedCapability = String(capability || "").trim();
  if (!ALL_CAPABILITIES.includes(normalizedCapability)) return false;
  return phaseOneCapabilitiesFor(input).includes(normalizedCapability);
}

export function requirePhaseOneCapability(principal, capability) {
  if (hasPhaseOneCapability(principal, capability)) return resolvePhaseOneBusinessRole(principal);
  const role = resolvePhaseOneBusinessRole(principal);
  throw policyError(
    "PHASE_ONE_CAPABILITY_FORBIDDEN",
    "当前一期角色无权执行该操作",
    403,
    [{ capability:String(capability || ""), role:role || "未配置" }]
  );
}

export const phaseOneRolePolicyError = policyError;
