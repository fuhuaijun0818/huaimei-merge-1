import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  authorizeManagementPrincipal,
  createManagementAuthorizer,
  MANAGEMENT_ROLES
} from "../server/platform/management-authorization.mjs";
import { assertManagementRequestOrigin } from "../server/platform/management-request-origin.mjs";

const identities = new Map([
  ["Bearer alice-token", {
    subject:"oidc|alice",
    roles:[MANAGEMENT_ROLES.customerRead, MANAGEMENT_ROLES.serviceRead],
    tenantIds:["tenant-a"]
  }],
  ["Bearer bob-token", {
    subject:"oidc|bob",
    roles:[MANAGEMENT_ROLES.runsRead],
    tenantIds:["tenant-b", "tenant-c"]
  }],
  ["Bearer contact-token", {
    subject:"oidc|contact-agent",
    roles:[MANAGEMENT_ROLES.operationsAgent, MANAGEMENT_ROLES.contactReveal],
    tenantIds:["tenant-a"]
  }],
  ["Bearer knowledge-token", {
    subject:"oidc|knowledge-governor",
    roles:[MANAGEMENT_ROLES.knowledgeRead],
    tenantIds:["tenant-a"]
  }]
]);
const verifier = {
  async verifyAuthorizationHeader(header) {
    if (!identities.has(header)) {
      const error = new Error("Bearer token is required");
      error.code = "OIDC_TOKEN_MISSING";
      error.status = 401;
      throw error;
    }
    return identities.get(header);
  }
};
const authorizer = createManagementAuthorizer({ oidcVerifier:verifier });

const alice = await authorizer.authorize(
  { headers:{ authorization:"Bearer alice-token" } },
  { requiredRoles:[MANAGEMENT_ROLES.customerRead] }
);
assert.equal(alice.subject, "oidc|alice");
assert.equal(alice.tenantId, "tenant-a", "单租户身份可以安全推导唯一租户");

const contactAgent = await authorizer.authorize(
  { headers:{ authorization:"Bearer contact-token" } },
  {
    requiredAllRoles:[MANAGEMENT_ROLES.operationsAgent, MANAGEMENT_ROLES.contactReveal],
    tenantId:"tenant-a"
  }
);
assert.equal(contactAgent.subject, "oidc|contact-agent");
const knowledgeGovernor = await authorizer.authorize(
  { headers:{ authorization:"Bearer knowledge-token" } },
  { requiredRoles:[MANAGEMENT_ROLES.knowledgeRead], tenantId:"tenant-a" }
);
assert.equal(knowledgeGovernor.subject, "oidc|knowledge-governor");
assert.throws(
  () => authorizeManagementPrincipal({
    subject:"oidc|operations-only",
    roles:[MANAGEMENT_ROLES.operationsAgent],
    tenantIds:["tenant-a"]
  }, {
    requiredAllRoles:[MANAGEMENT_ROLES.operationsAgent, MANAGEMENT_ROLES.contactReveal],
    tenantId:"tenant-a"
  }),
  (error) => error.code === "OIDC_ROLE_FORBIDDEN"
    && error.details?.[0]?.role === MANAGEMENT_ROLES.contactReveal,
  "联系方式查看必须同时具备operations.agent与contact:reveal"
);

await assert.rejects(
  authorizer.authorize(
    { headers:{ authorization:"Bearer alice-token" } },
    { requiredRoles:[MANAGEMENT_ROLES.runsRead], tenantId:"tenant-a" }
  ),
  (error) => error.code === "OIDC_ROLE_FORBIDDEN" && error.status === 403,
  "客户只读用户不得读取运行审计"
);
await assert.rejects(
  authorizer.authorize(
    { headers:{ authorization:"Bearer alice-token" } },
    { requiredRoles:[MANAGEMENT_ROLES.operationsAgent], tenantId:"tenant-a" }
  ),
  (error) => error.code === "OIDC_ROLE_FORBIDDEN" && error.status === 403,
  "非人工接管顾问不得进入接管BFF"
);
await assert.rejects(
  authorizer.authorize(
    { headers:{ authorization:"Bearer alice-token" } },
    { requiredRoles:[MANAGEMENT_ROLES.knowledgeRead], tenantId:"tenant-a" }
  ),
  (error) => error.code === "OIDC_ROLE_FORBIDDEN" && error.status === 403,
  "非知识治理角色不得读取内部目录与发布状态"
);

await assert.rejects(
  authorizer.authorize(
    { headers:{ authorization:"Bearer bob-token" } },
    { requiredRoles:[MANAGEMENT_ROLES.runsRead], tenantId:"tenant-a" }
  ),
  (error) => error.code === "OIDC_TENANT_FORBIDDEN" && error.status === 403,
  "有运行读权限也不得跨租户读取"
);

await assert.rejects(
  authorizer.authorize(
    { headers:{ authorization:"Bearer bob-token" } },
    { requiredRoles:[MANAGEMENT_ROLES.runsRead] }
  ),
  (error) => error.code === "TENANT_CONTEXT_REQUIRED" && error.status === 400,
  "多租户用户未明确租户时必须失败关闭"
);

const bob = await authorizer.authorize(
  { headers:{ authorization:"Bearer bob-token" } },
  { requiredRoles:[MANAGEMENT_ROLES.runsRead], tenantId:"tenant-c" }
);
assert.equal(bob.tenantId, "tenant-c");

await assert.rejects(
  authorizer.authorize({ headers:{} }, { requiredRoles:[MANAGEMENT_ROLES.customerRead], tenantId:"tenant-a" }),
  (error) => error.code === "OIDC_TOKEN_MISSING" && error.status === 401
);

assert.throws(
  () => authorizeManagementPrincipal({ subject:"root", roles:[MANAGEMENT_ROLES.customerRead], tenantIds:["*"] }, { requiredRoles:[MANAGEMENT_ROLES.customerRead], tenantId:"tenant-a" }),
  (error) => error.code === "OIDC_TENANT_WILDCARD_FORBIDDEN",
  "人类管理身份不得使用全租户通配符"
);

const [routerSource, serverSource, caddySource, openApiSource] = await Promise.all([
  readFile(new URL("../server/api-router.mjs", import.meta.url), "utf8"),
  readFile(new URL("../server.mjs", import.meta.url), "utf8"),
  readFile(new URL("../deploy/Caddyfile", import.meta.url), "utf8"),
  readFile(new URL("../server/openapi.mjs", import.meta.url), "utf8")
]);
assert.match(routerSource, /MANAGEMENT_ROLES\.customerRead/);
assert.match(routerSource, /MANAGEMENT_ROLES\.runsRead/);
assert.match(routerSource, /\/api\/admin\/knowledge\/governance/);
assert.match(routerSource, /MANAGEMENT_ROLES\.knowledgeRead/);
assert.match(routerSource, /actorId:principal\.subject/, "管理访问审计必须保留OIDC subject");
assert.match(serverSource, /adminAuthenticated\s*&&\s*!productionRuntime/, "生产不得把Basic标记为管理身份");
assert.match(caddySource, /@management_api[\s\S]*\/api\/admin\/\*[\s\S]*\/api\/local\/\*[\s\S]*\/api\/v1\/runs/);
assert.match(openApiSource, /OidcBearerAuth/, "OpenAPI必须声明管理端OIDC Bearer认证");

const productionOriginEnv = { NODE_ENV:"production", HUAMEI_ADMIN_ORIGIN:"https://admin.huamei.cn" };
assert.doesNotThrow(() => assertManagementRequestOrigin(
  { method:"POST", headers:{ origin:"https://admin.huamei.cn", "sec-fetch-site":"same-origin" } },
  productionOriginEnv
));
assert.doesNotThrow(() => assertManagementRequestOrigin(
  { method:"GET", headers:{ "sec-fetch-site":"none" } },
  productionOriginEnv
), "生产管理端顶层导航的Sec-Fetch-Site:none必须可用");
assert.throws(
  () => assertManagementRequestOrigin(
    { method:"GET", headers:{ "sec-fetch-site":"same-site" } },
    productionOriginEnv
  ),
  (error) => error?.code === "MANAGEMENT_CSRF_ORIGIN_FORBIDDEN"
);
assert.throws(
  () => assertManagementRequestOrigin(
    { method:"POST", headers:{ origin:"https://evil.example", "sec-fetch-site":"cross-site" } },
    productionOriginEnv
  ),
  (error) => error.code === "MANAGEMENT_CSRF_ORIGIN_FORBIDDEN" && error.status === 403
);
assert.throws(
  () => assertManagementRequestOrigin({ method:"POST", headers:{ "sec-fetch-site":"same-origin" } }, productionOriginEnv),
  (error) => error.code === "MANAGEMENT_CSRF_ORIGIN_FORBIDDEN"
);

console.log("✓ 管理面OIDC/RBAC/租户授权及两用户负例通过");
