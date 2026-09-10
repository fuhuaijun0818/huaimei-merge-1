import assert from "node:assert/strict";

const gatewaySecret = "gw_A7d9K2m4P8q1R6t3V5x0ZcBnHyLuEeW";
const multiTenantSecret = "mt_Q3w7E9r2T6y4U8i1O5p0AsDfGhJkLzX";
const operationsSecret = "op_Z9x7C5v3B1n8M6a4S2d0FgHjKlQwErT";
const operationsWriteSecret = "ow_M4n8B2v6C0x3Z7a1S5d9FgHjKlQwErTy";
const contactRevealSecret = "cr_P9v7N5m3K1j8H6g4F2d0SaQwXeRtYuIo";

process.env.HUAMEI_RUNTIME_ENV = "development";
process.env.HUAMEI_LLM_ENABLED = "false";
process.env.HUAMEI_DEFAULT_TENANT_ID = "tenant-a";
process.env.HUAMEI_ACQUISITION_SESSION_STORE_FILE = ":memory:";
process.env.HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE = ":memory:";
process.env.HUAMEI_KNOWLEDGE_RELEASE_STORE_FILE = ":memory:";
process.env.HUAMEI_KNOWLEDGE_APPROVAL_MODE = "preview";
process.env.HUAMEI_ACQUISITION_CLIENTS_JSON = JSON.stringify({
  huamei_web_gateway:{
    secret:gatewaySecret,
    tenant_ids:["tenant-a"],
    permissions:["service:read", "conversation:write", "privacy:request", "runs:read"]
  },
  multi_tenant_connector:{
    secret:multiTenantSecret,
    tenant_ids:["tenant-a", "tenant-b"],
    permissions:["conversation:write"]
  },
  operations_reader:{
    secret:operationsSecret,
    tenant_ids:["tenant-a"],
    permissions:["operations:read"]
  },
  operations_writer:{
    secret:operationsWriteSecret,
    tenant_ids:["tenant-a"],
    permissions:["operations:write"]
  },
  contact_revealer:{
    secret:contactRevealSecret,
    tenant_ids:["tenant-a"],
    permissions:["contact:reveal"]
  }
});

const { createAcquisitionServiceServer } = await import("../server/acquisition-service-server.mjs");

const oidcVerifier = {
  async verifyAuthorizationHeader(header, requirements = {}) {
    const token = String(header || "").replace(/^Bearer\s+/i, "");
    if (!token) {
      const error = new Error("missing"); error.code = "OIDC_TOKEN_MISSING"; error.status = 401; throw error;
    }
    if (!["operations-agent", "operations-contact-agent"].includes(token)) {
      const error = new Error("forbidden"); error.code = "OIDC_ROLE_FORBIDDEN"; error.status = 403; throw error;
    }
    const roles = token === "operations-contact-agent"
      ? ["operations.agent", "contact:reveal"]
      : ["operations.agent"];
    const missing = (requirements.requiredAllRoles || []).filter((role) => !roles.includes(role));
    if (missing.length) {
      const error = new Error("forbidden"); error.code = "OIDC_ROLE_FORBIDDEN"; error.status = 403; error.details = missing.map((role) => ({ role })); throw error;
    }
    return { subject:"advisor-auth-001", roles, tenantIds:[requirements.tenantId], issuer:"https://identity.test" };
  }
};
const server = createAcquisitionServiceServer({ host:"127.0.0.1", oidcVerifier });
await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const credentials = (callerId, secret, tenantId = "") => ({
  "X-Caller-Id":callerId,
  "X-Service-Key":secret,
  ...(tenantId ? { "X-Tenant-Id":tenantId } : {})
});
const post = (path, body, headers = {}) => fetch(`${baseUrl}${path}`, {
  method:"POST",
  headers:{ "Content-Type":"application/json", ...headers },
  body:JSON.stringify(body)
});
const bodyOf = async (response) => {
  try { return await response.json(); }
  catch { return {}; }
};

try {
  const missingCredentials = await fetch(`${baseUrl}/v1/channels`);
  assert.equal(missingCredentials.status, 401, "配置了客户端注册表后，loopback不得绕过鉴权");

  const wrongCredentials = await fetch(`${baseUrl}/v1/channels`, {
    headers:credentials("huamei_web_gateway", operationsSecret)
  });
  assert.equal(wrongCredentials.status, 401);

  const spoofedCaller = await fetch(`${baseUrl}/v1/operations/metrics?tenant_id=tenant-a`, {
    headers:credentials("operations_reader", gatewaySecret)
  });
  assert.equal(spoofedCaller.status, 401, "caller id和secret必须作为同一条注册记录验证");

  const channels = await fetch(`${baseUrl}/v1/channels`, {
    headers:credentials("huamei_web_gateway", gatewaySecret)
  });
  assert.equal(channels.status, 200);

  const allowedConversation = await post("/v1/conversations/reply", {
    tenant_id:"tenant-a",
    channel:"api",
    conversation_id:"auth-allowed-a",
    message:{ id:"auth-msg-a", text:"请介绍光子嫩肤的一般项目知识" }
  }, credentials("huamei_web_gateway", gatewaySecret));
  assert.equal(allowedConversation.status, 200);
  assert.equal((await bodyOf(allowedConversation)).tenant_id, "tenant-a");

  const ordinaryCallerFormalEntry = await post("/v1/conversations/reply", {
    tenant_id:"tenant-a",
    channel:"api",
    conversation_id:"auth-formal-denied",
    message:{ id:"auth-formal-denied-message", text:"请介绍双眼皮" }
  }, {
    ...credentials("huamei_web_gateway", gatewaySecret),
    "X-Huamei-Formal-Load-Entry-Id":"eye.0"
  });
  assert.equal(ordinaryCallerFormalEntry.status, 403, "普通/web caller不得触达正式taxonomy通道");
  assert.equal((await bodyOf(ordinaryCallerFormalEntry)).error?.code, "INSUFFICIENT_PERMISSION");

  const clientSuppliedFormalQuery = await post("/v1/conversations/reply", {
    tenant_id:"tenant-a",
    channel:"api",
    conversation_id:"auth-formal-query-denied",
    message:{ id:"auth-formal-query-denied-message", text:"请介绍双眼皮" }
  }, {
    ...credentials("huamei_web_gateway", gatewaySecret),
    "X-Huamei-Formal-Load-Query":"eye.0-nonce"
  });
  assert.equal(clientSuppliedFormalQuery.status, 400, "任何caller都不得直接传入query/nonce");
  assert.equal((await bodyOf(clientSuppliedFormalQuery)).error?.code, "FORMAL_LOAD_TAXONOMY_UNSUPPORTED_INPUT");

  const crossTenant = await post("/v1/conversations/reply", {
    tenant_id:"tenant-b",
    channel:"api",
    conversation_id:"auth-denied-b",
    message:{ id:"auth-msg-b", text:"请介绍光子嫩肤" }
  }, credentials("huamei_web_gateway", gatewaySecret));
  assert.equal(crossTenant.status, 403);
  assert.equal((await bodyOf(crossTenant)).error?.code, "TENANT_ACCESS_DENIED");

  const inconsistentTenant = await post("/v1/conversations/reply", {
    tenant_id:"tenant-b",
    channel:"api",
    conversation_id:"auth-mismatch",
    message:{ id:"auth-msg-mismatch", text:"请介绍双眼皮" }
  }, credentials("multi_tenant_connector", multiTenantSecret, "tenant-a"));
  assert.equal(inconsistentTenant.status, 403);
  assert.equal((await bodyOf(inconsistentTenant)).error?.code, "TENANT_CONTEXT_MISMATCH");

  const insufficientPermission = await fetch(`${baseUrl}/v1/operations/metrics?tenant_id=tenant-a`, {
    headers:credentials("huamei_web_gateway", gatewaySecret)
  });
  assert.equal(insufficientPermission.status, 403);
  assert.equal((await bodyOf(insufficientPermission)).error?.code, "INSUFFICIENT_PERMISSION");

  const privacyPermissionDenied = await post("/v1/privacy/requests", {
    tenant_id:"tenant-a",
    request_type:"delete",
    mobile:"not-a-mobile"
  }, credentials("multi_tenant_connector", multiTenantSecret));
  assert.equal(privacyPermissionDenied.status, 403, "个人信息权利建单必须使用独立最小权限");
  assert.equal((await bodyOf(privacyPermissionDenied)).error?.code, "INSUFFICIENT_PERMISSION");

  const privacyInputRejectedBeforeStorage = await post("/v1/privacy/requests", {
    tenant_id:"tenant-a",
    request_type:"delete",
    mobile:"not-a-mobile"
  }, credentials("huamei_web_gateway", gatewaySecret));
  assert.equal(privacyInputRejectedBeforeStorage.status, 400);
  assert.equal((await bodyOf(privacyInputRejectedBeforeStorage)).error?.code, "PRIVACY_MOBILE_INVALID");

  const privacyReadDenied = await fetch(`${baseUrl}/v1/privacy/requests?tenant_id=tenant-a`, {
    headers:credentials("operations_reader", operationsSecret)
  });
  assert.equal(privacyReadDenied.status, 403);
  assert.equal((await bodyOf(privacyReadDenied)).error?.code, "INSUFFICIENT_PERMISSION");

  const authorizedOperationsRead = await fetch(`${baseUrl}/v1/operations/metrics?tenant_id=tenant-a`, {
    headers:credentials("operations_reader", operationsSecret)
  });
  assert.equal(authorizedOperationsRead.status, 200);

  const serviceOnlyOperationsWrite = await post("/v1/handovers/ho_deadbeef/claim", {
    tenant_id:"tenant-a"
  }, credentials("operations_writer", operationsWriteSecret));
  assert.equal(serviceOnlyOperationsWrite.status, 401, "机器operations:write密钥不能冒充人工顾问");
  assert.equal((await bodyOf(serviceOnlyOperationsWrite)).error?.code, "OIDC_TOKEN_MISSING");

  const wrongRoleOperationsWrite = await post("/v1/handovers/ho_deadbeef/claim", {
    tenant_id:"tenant-a"
  }, { ...credentials("operations_writer", operationsWriteSecret), Authorization:"Bearer wrong-role" });
  assert.equal(wrongRoleOperationsWrite.status, 403);

  const spoofedOperationsActor = await post("/v1/handovers/ho_deadbeef/claim", {
    tenant_id:"tenant-a", assignee:"advisor-other"
  }, { ...credentials("operations_writer", operationsWriteSecret), Authorization:"Bearer operations-agent" });
  assert.equal(spoofedOperationsActor.status, 400);
  assert.equal((await bodyOf(spoofedOperationsActor)).error?.code, "OPERATIONS_ACTOR_OVERRIDE_FORBIDDEN");

  const authorizedOperationsWrite = await post("/v1/handovers/ho_deadbeef/claim", {
    tenant_id:"tenant-a"
  }, { ...credentials("operations_writer", operationsWriteSecret), Authorization:"Bearer operations-agent" });
  assert.equal(authorizedOperationsWrite.status, 404, "实名角色通过后才进入任务查找");

  const contactWithoutHuman = await post("/v1/handovers/ho_deadbeef/contact-reveal", {
    tenant_id:"tenant-a"
  }, {
    ...credentials("contact_revealer", contactRevealSecret),
    "Idempotency-Key":"contact-no-human"
  });
  assert.equal(contactWithoutHuman.status, 401, "机器contact:reveal权限不能代替实名人员身份");

  const contactWithoutIndependentRole = await post("/v1/handovers/ho_deadbeef/contact-reveal", {
    tenant_id:"tenant-a"
  }, {
    ...credentials("contact_revealer", contactRevealSecret),
    Authorization:"Bearer operations-agent",
    "Idempotency-Key":"contact-no-role"
  });
  assert.equal(contactWithoutIndependentRole.status, 403, "仅operations.agent不得查看联系方式");
  assert.equal((await bodyOf(contactWithoutIndependentRole)).error?.code, "OIDC_ROLE_FORBIDDEN");

  const contactWithoutServicePermission = await post("/v1/handovers/ho_deadbeef/contact-reveal", {
    tenant_id:"tenant-a"
  }, {
    ...credentials("operations_writer", operationsWriteSecret),
    Authorization:"Bearer operations-contact-agent",
    "Idempotency-Key":"contact-no-service-permission"
  });
  assert.equal(contactWithoutServicePermission.status, 403, "普通operations:write服务密钥不得读取联系方式");
  assert.equal((await bodyOf(contactWithoutServicePermission)).error?.code, "INSUFFICIENT_PERMISSION");

  const contactAuthorized = await post("/v1/handovers/ho_deadbeef/contact-reveal", {
    tenant_id:"tenant-a"
  }, {
    ...credentials("contact_revealer", contactRevealSecret),
    Authorization:"Bearer operations-contact-agent",
    "Idempotency-Key":"contact-authorized-once"
  });
  assert.equal(contactAuthorized.status, 404, "双角色和独立服务权限通过后才进入当前租户任务查找");
  assert.equal(contactAuthorized.headers.get("cache-control"), "no-store");
  assert.equal(contactAuthorized.headers.get("pragma"), "no-cache");

  const operationsCrossTenant = await fetch(`${baseUrl}/v1/operations/metrics?tenant_id=tenant-b`, {
    headers:credentials("operations_reader", operationsSecret)
  });
  assert.equal(operationsCrossTenant.status, 403);
  assert.equal((await bodyOf(operationsCrossTenant)).error?.code, "TENANT_ACCESS_DENIED");

  process.env.HUAMEI_ACQUISITION_SERVICE_URL = baseUrl;
  process.env.HUAMEI_ACQUISITION_CALLER_ID = "huamei_web_gateway";
  process.env.HUAMEI_ACQUISITION_CALLER_SECRET = gatewaySecret;
  process.env.HUAMEI_ACQUISITION_TENANT_ID = "tenant-a";
  process.env.HUAMEI_ACQUISITION_SERVICE_IN_PROCESS = "false";
  const { callAcquisitionChannel } = await import(`../server/acquisition-service-client.mjs?auth=${Date.now()}`);
  const fixedGatewayIdentity = await callAcquisitionChannel("web", {
    message:"请介绍双眼皮的一般项目知识",
    session_id:"fixed-gateway-identity"
  }, { caller:"operations_reader" });
  assert.equal(fixedGatewayIdentity.tenant_id, "tenant-a", "客户端必须使用配置的固定caller和租户");

  await assert.rejects(
    () => callAcquisitionChannel("web", {
      tenant_id:"tenant-b",
      message:"请介绍双眼皮",
      session_id:"fixed-gateway-override"
    }, { caller:"huamei_web_gateway" }),
    (error) => error?.code === "TENANT_ACCESS_DENIED" && error?.status === 403
  );

  console.log("✓ 调用方密钥、最小权限与租户白名单绑定通过");
  console.log("✓ payload/query/header跨租户覆盖与身份伪造均被拒绝");
} finally {
  await new Promise((resolve) => server.close(resolve));
}
