import assert from "node:assert/strict";
import {
  MANAGEMENT_TECHNICAL_ROLES,
  PHASE_ONE_BUSINESS_ROLES,
  PHASE_ONE_CAPABILITIES,
  effectiveManagementRolesFor,
  hasPhaseOneCapability,
  listPhaseOneBusinessRoles,
  phaseOneCapabilitiesFor,
  requirePhaseOneCapability,
  resolvePhaseOneBusinessRole
} from "../server/platform/phase-one-role-policy.mjs";
import {
  MANAGEMENT_ROLES,
  authorizeManagementPrincipal
} from "../server/platform/management-authorization.mjs";
import {
  issueLocalManagementIdentity,
  verifyLocalManagementIdentity
} from "../server/platform/local-management-identity.mjs";

assert.deepEqual(
  listPhaseOneBusinessRoles(),
  Object.values(PHASE_ONE_BUSINESS_ROLES),
  "一期管理面必须展示五岗位"
);
assert.equal(resolvePhaseOneBusinessRole(["管理员"]), PHASE_ONE_BUSINESS_ROLES.administrator);
assert.equal(resolvePhaseOneBusinessRole(["售前顾问"]), PHASE_ONE_BUSINESS_ROLES.presales);
assert.equal(
  resolvePhaseOneBusinessRole([MANAGEMENT_TECHNICAL_ROLES.operationsAgent]),
  PHASE_ONE_BUSINESS_ROLES.presales,
  "历史人工接管权限可映射为售前人员，便于平滑迁移"
);
assert.throws(
  () => resolvePhaseOneBusinessRole(["管理员", "售前人员"]),
  (error) => error.code === "PHASE_ONE_BUSINESS_ROLE_CONFLICT",
  "一个一期身份不能拥有两个业务角色"
);
assert.throws(
  () => resolvePhaseOneBusinessRole({
    phaseOneRole:"管理员",
    roles:["售前人员"]
  }),
  (error) => error.code === "PHASE_ONE_BUSINESS_ROLE_CONFLICT",
  "显式业务角色与OIDC角色声明冲突时必须失败关闭"
);

const administrator = { roles:["管理员"] };
const presales = { roles:["售前人员"] };
assert.equal(
  hasPhaseOneCapability(administrator, PHASE_ONE_CAPABILITIES.agentsManage),
  true,
  "管理员可维护智能体"
);
assert.equal(
  hasPhaseOneCapability(presales, PHASE_ONE_CAPABILITIES.conversationsTakeover),
  true,
  "售前人员可接管已分配会话"
);
assert.equal(
  hasPhaseOneCapability(presales, PHASE_ONE_CAPABILITIES.hospitalDataManage),
  false,
  "售前人员不能维护医生、项目和价格等医院主数据"
);
assert.equal(
  phaseOneCapabilitiesFor(presales).includes(PHASE_ONE_CAPABILITIES.knowledgeManage),
  false,
  "售前人员不能维护知识库"
);
assert.throws(
  () => requirePhaseOneCapability(presales, PHASE_ONE_CAPABILITIES.systemManage),
  (error) => error.code === "PHASE_ONE_CAPABILITY_FORBIDDEN" && error.status === 403
);

const legacyOperationsOnly = { roles:[MANAGEMENT_TECHNICAL_ROLES.operationsAgent] };
assert.equal(
  hasPhaseOneCapability(legacyOperationsOnly, PHASE_ONE_CAPABILITIES.conversationsTakeover),
  true,
  "历史operations.agent保留会话接管能力"
);
assert.equal(
  hasPhaseOneCapability(legacyOperationsOnly, PHASE_ONE_CAPABILITIES.contactsRevealAssigned),
  false,
  "历史operations.agent不得因角色映射而获得联系方式查看权限"
);
assert.deepEqual(
  effectiveManagementRolesFor(legacyOperationsOnly),
  [MANAGEMENT_TECHNICAL_ROLES.operationsAgent],
  "历史技术权限不得自动扩张为售前人员全部兼容权限"
);
assert.equal(
  hasPhaseOneCapability(
    { roles:[MANAGEMENT_TECHNICAL_ROLES.operationsAgent, MANAGEMENT_TECHNICAL_ROLES.contactReveal] },
    PHASE_ONE_CAPABILITIES.contactsRevealAssigned
  ),
  true,
  "历史联系人权限仍要求operations.agent与contact:reveal同时存在"
);

assert.equal(MANAGEMENT_ROLES.operationsAgent, MANAGEMENT_TECHNICAL_ROLES.operationsAgent);
const authorizedAdmin = authorizeManagementPrincipal({
  subject:"oidc|phase-one-admin",
  roles:["管理员"],
  tenantIds:["tenant-a"]
}, {
  requiredAllRoles:[MANAGEMENT_ROLES.serviceRead],
  requiredCapabilities:[PHASE_ONE_CAPABILITIES.agentsManage],
  tenantId:"tenant-a"
});
assert.equal(authorizedAdmin.phaseOneRole, PHASE_ONE_BUSINESS_ROLES.administrator);
assert.ok(!authorizedAdmin.effectiveRoles.includes(MANAGEMENT_ROLES.knowledgeIntakeWrite));
assert.ok(!authorizedAdmin.phaseOneCapabilities.includes(PHASE_ONE_CAPABILITIES.hospitalDataManage));

const authorizedPresales = authorizeManagementPrincipal({
  subject:"oidc|phase-one-presales",
  roles:["售前人员"],
  tenantIds:["tenant-a"]
}, {
  requiredAllRoles:[MANAGEMENT_ROLES.operationsAgent, MANAGEMENT_ROLES.contactReveal],
  requiredCapabilities:[PHASE_ONE_CAPABILITIES.conversationsReply],
  tenantId:"tenant-a"
});
assert.equal(authorizedPresales.phaseOneRole, PHASE_ONE_BUSINESS_ROLES.presales);
assert.ok(authorizedPresales.effectiveRoles.includes(MANAGEMENT_ROLES.operationsAgent));
assert.throws(
  () => authorizeManagementPrincipal({
    subject:"oidc|phase-one-presales",
    roles:["售前人员"],
    tenantIds:["tenant-a"]
  }, {
    requiredCapabilities:[PHASE_ONE_CAPABILITIES.knowledgeManage],
    tenantId:"tenant-a"
  }),
  (error) => error.code === "PHASE_ONE_CAPABILITY_FORBIDDEN" && error.status === 403,
  "权限迁移期也必须阻止售前人员维护知识库"
);
assert.throws(
  () => authorizeManagementPrincipal({
    subject:"oidc|legacy-operations-only",
    roles:[MANAGEMENT_ROLES.operationsAgent],
    tenantIds:["tenant-a"]
  }, {
    requiredAllRoles:[MANAGEMENT_ROLES.operationsAgent, MANAGEMENT_ROLES.contactReveal],
    tenantId:"tenant-a"
  }),
  (error) => error.code === "OIDC_ROLE_FORBIDDEN",
  "细粒度技术权限兼容不得绕过联系方式双权限校验"
);
const authorizedLegacyOperations = authorizeManagementPrincipal({
  subject:"oidc|legacy-operations-only",
  roles:[MANAGEMENT_ROLES.operationsAgent],
  tenantIds:["tenant-a"]
}, { tenantId:"tenant-a" });
assert.equal(authorizedLegacyOperations.phaseOneRoleSource, "legacy_technical");
assert.equal(
  hasPhaseOneCapability(authorizedLegacyOperations, PHASE_ONE_CAPABILITIES.contactsRevealAssigned),
  false,
  "授权结果再次进入能力检查时，也不得把历史operations.agent扩张为联系人权限"
);

const localSecret = "local-role-policy-bridge-secret-1234567890abcdef";
const localEnv = {
  NODE_ENV:"development",
  HUAMEI_RUNTIME_ENV:"development",
  HUAMEI_LOCAL_ADMIN_BRIDGE_SECRET:localSecret,
  HUAMEI_LOCAL_ADMIN_SUBJECT:"local-role-policy-admin"
};
const localIdentityOptions = {
  env:localEnv,
  gatewayHost:"127.0.0.1",
  serviceUrl:new URL("http://127.0.0.1:4180"),
  serviceHost:"127.0.0.1",
  remoteAddress:"127.0.0.1",
  tenantId:"tenant-a",
  method:"POST",
  pathname:"/v1/handovers/example/claim",
  issuedAt:1_760_000_000_000
};
const localIssued = issueLocalManagementIdentity(localIdentityOptions);
const localAdministrator = verifyLocalManagementIdentity({
  ...localIdentityOptions,
  headers:localIssued.headers,
  nowMs:Number(localIssued.headers["x-huamei-local-admin-issued-at"])
});
assert.equal(
  localAdministrator.phaseOneRole,
  PHASE_ONE_BUSINESS_ROLES.administrator,
  "本地开发默认使用管理员业务角色"
);
assert.ok(!localAdministrator.roles.includes(MANAGEMENT_ROLES.knowledgeIntakeWrite));
assert.ok(localAdministrator.capabilities.includes(PHASE_ONE_CAPABILITIES.systemManage));

const localPresalesEnv = { ...localEnv, HUAMEI_LOCAL_MANAGEMENT_ROLE:"售前人员" };
const localPresalesIssued = issueLocalManagementIdentity({ ...localIdentityOptions, env:localPresalesEnv });
const localPresales = verifyLocalManagementIdentity({
  ...localIdentityOptions,
  env:localPresalesEnv,
  headers:localPresalesIssued.headers,
  nowMs:Number(localPresalesIssued.headers["x-huamei-local-admin-issued-at"])
});
assert.equal(localPresales.phaseOneRole, PHASE_ONE_BUSINESS_ROLES.presales);
assert.ok(localPresales.roles.includes(MANAGEMENT_ROLES.operationsAgent));
assert.ok(!localPresales.roles.includes(MANAGEMENT_ROLES.knowledgeIntakeWrite));
assert.throws(
  () => issueLocalManagementIdentity({
    ...localIdentityOptions,
    env:{ ...localEnv, HUAMEI_LOCAL_MANAGEMENT_ROLE:"医学审核员" }
  }),
  (error) => error.code === "LOCAL_MANAGEMENT_ROLE_INVALID" && error.status === 503
);

console.log("✓ 一期管理员/售前人员角色策略、技术权限兼容和本地默认管理员身份通过");

for (const role of ["系统管理员","内容专员","质量与运营人员","售前顾问"]) {
  assert.equal(hasPhaseOneCapability({roles:[role,"knowledge.publisher"]},"knowledge:publish"),false);
  assert.ok(!effectiveManagementRolesFor({roles:[role,"knowledge.publisher"]}).includes("knowledge.publisher"));
}
assert.equal(hasPhaseOneCapability({roles:["发布与索引管理员"]},"knowledge:publish"),true);
assert.equal(hasPhaseOneCapability({roles:["质量与运营人员"]},"contacts:reveal_assigned"),false);
assert.equal(hasPhaseOneCapability({roles:["内容专员"]},"knowledge:manage"),true);
