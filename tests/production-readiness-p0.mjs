// Offline regression must not inherit live member credentials from .env.local.
process.env.HUAMEI_MEMBER_CHECK_ENABLED = "false";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const strongApiKey = "p0-api-key-0123456789abcdef0123456789abcdef";
const strongSessionSecret = "p0-session-secret-0123456789abcdef0123456789abcdef";

const reservePort = () => new Promise((resolve, reject) => {
  const probe = createNetServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    probe.close((error) => error ? reject(error) : resolve(address.port));
  });
});

const readJson = async (response) => {
  try { return await response.json(); }
  catch { return {}; }
};

const postJson = (url, payload, headers = {}) => fetch(url, {
  method:"POST",
  headers:{ "Content-Type":"application/json", ...headers },
  body:JSON.stringify(payload)
});

const sessionCredentialFrom = (response, body) => {
  const sessionId = body.session?.id
    || body.session_id
    || body.profile_signals?.session_id
    || body.conversation_id
    || "";
  const token = body.session?.token
    || body.session_token
    || response.headers.get("x-huamei-session-token")
    || response.headers.get("x-session-token")
    || "";
  const setCookie = response.headers.get("set-cookie") || "";
  const cookie = setCookie ? setCookie.split(";", 1)[0] : "";
  return { sessionId, token, cookie };
};

const sessionHeaders = (credential) => ({
  ...(credential.token ? { "X-Huamei-Session-Token":credential.token } : {}),
  ...(credential.cookie ? { Cookie:credential.cookie } : {})
});

const sessionPayload = (credential, payload) => ({
  ...payload,
  session_id:credential.sessionId,
  ...(credential.token ? { session_token:credential.token } : {})
});

async function startAcquisitionService() {
  process.env.HUAMEI_LLM_ENABLED = "false";
  process.env.HUAMEI_ACQUISITION_SESSION_STORE_FILE = ":memory:";
  process.env.HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE = ":memory:";
  process.env.HUAMEI_KNOWLEDGE_RELEASE_STORE_FILE = ":memory:";
  process.env.HUAMEI_KNOWLEDGE_APPROVAL_MODE = "preview";
  process.env.HUAMEI_ACQUISITION_SERVICE_RATE_LIMIT = "5000";
  const { createAcquisitionServiceServer } = await import("../server/acquisition-service-server.mjs");
  const server = createAcquisitionServiceServer({ host:"127.0.0.1" });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const invoke = (payload, idempotencyKey) => postJson(`${baseUrl}/v1/conversations/reply`, payload, {
    "Idempotency-Key":idempotencyKey
  });
  return { server, invoke };
}

const baseIdempotencyPayload = {
  tenant_id:"tenant-a",
  channel:"api",
  conversation_id:"conversation-a",
  message:{ id:"message-a", text:"请介绍热玛吉的一般项目知识" }
};

async function verifyCrossTenantIdempotency({ invoke }) {
  const first = await invoke(baseIdempotencyPayload, "cross-tenant-key");
  assert.equal(first.status, 200);
  const firstBody = await readJson(first);
  const crossTenant = await invoke({
    tenant_id:"tenant-b",
    channel:"api",
    conversation_id:"conversation-b",
    message:{ id:"message-b", text:"李健院长擅长什么？" }
  }, "cross-tenant-key");
  assert.equal(crossTenant.status, 200, "相同幂等键不能跨租户冲突");
  assert.notEqual(crossTenant.headers.get("x-idempotent-replay"), "true", "跨租户请求不能重放其他租户响应");
  const crossTenantBody = await readJson(crossTenant);
  assert.equal(crossTenantBody.tenant_id, "tenant-b");
  assert.equal(crossTenantBody.conversation_id, "conversation-b");
  assert.notEqual(crossTenantBody.run_id, firstBody.run_id);
}

async function verifyCrossConversationIdempotency({ invoke }) {
  const first = await invoke(baseIdempotencyPayload, "cross-conversation-key");
  assert.equal(first.status, 200);
  const firstBody = await readJson(first);
  const crossConversation = await invoke({
    tenant_id:"tenant-a",
    channel:"api",
    conversation_id:"conversation-c",
    message:{ id:"message-c", text:"请介绍双眼皮的一般项目知识" }
  }, "cross-conversation-key");
  assert.equal(crossConversation.status, 200, "相同幂等键不能跨会话冲突");
  assert.notEqual(crossConversation.headers.get("x-idempotent-replay"), "true", "跨会话请求不能重放其他会话响应");
  const crossConversationBody = await readJson(crossConversation);
  assert.equal(crossConversationBody.conversation_id, "conversation-c");
  assert.notEqual(crossConversationBody.run_id, firstBody.run_id);
}

async function verifyIdempotencyPayloadHash({ invoke }) {
  const exactFirst = await invoke(baseIdempotencyPayload, "exact-replay-key");
  assert.equal(exactFirst.status, 200);
  const exactFirstBody = await readJson(exactFirst);
  const exactReplay = await invoke(baseIdempotencyPayload, "exact-replay-key");
  assert.equal(exactReplay.status, 200);
  assert.equal(exactReplay.headers.get("x-idempotent-replay"), "true");
  assert.equal((await readJson(exactReplay)).run_id, exactFirstBody.run_id);
  const conflictPayload = {
    ...baseIdempotencyPayload,
    message:{ id:"message-a-changed", text:"同一个作用域但请求内容已经改变" }
  };
  const conflict = await invoke(conflictPayload, "exact-replay-key");
  assert.equal(conflict.status, 409, "同一作用域和幂等键对应不同请求体时必须拒绝，不能返回旧响应");
  assert.equal((await readJson(conflict)).error?.code, "IDEMPOTENCY_PAYLOAD_MISMATCH");
}

async function startGateway() {
  const port = await reservePort();
  const avatarRuntimeRoot = await mkdtemp(join(tmpdir(), "huamei-p0-readiness-"));
  const testInstanceId = `p0-${process.pid}-${Date.now()}`;
  const child = spawn(process.execPath, [fileURLToPath(new URL("server.mjs", root))], {
    cwd:fileURLToPath(root),
    env:{
      ...process.env,
      PORT:String(port),
      HUAMEI_HOST:"127.0.0.1",
      HUAMEI_TEST_INSTANCE_ID:testInstanceId,
      HUAMEI_API_KEY:strongApiKey,
      HUAMEI_LLM_ENABLED:"false",
      HUAMEI_ACQUISITION_SERVICE_IN_PROCESS:"true",
      HUAMEI_LEAD_STORE_FILE:":memory:",
      HUAMEI_ACQUISITION_SESSION_STORE_FILE:":memory:",
      HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE:":memory:",
      HUAMEI_KNOWLEDGE_RELEASE_STORE_FILE:":memory:",
      HUAMEI_KNOWLEDGE_APPROVAL_MODE:"preview",
      HUAMEI_PUBLIC_WEB_RATE_LIMIT:"20",
      HUAMEI_API_RATE_LIMIT:"5000",
      HUAMEI_TRUST_PROXY:"true",
      HUAMEI_TRUSTED_PROXY_ADDRESSES:"127.0.0.1,::1,::ffff:127.0.0.1",
      HUAMEI_PUBLIC_SESSION_SECRET:strongSessionSecret,
      HUAMEI_PRIVACY_VERIFICATION_SECRET:"p0_privacy_verify_M2n8Q4w0E6r3T9y1UiOpAsDf",
      HUAMEI_PRIVACY_COMPLETION_SECRET:"p0_privacy_complete_B5v1C7x3Z9a6S2d8FgHjK",
      HUAMEI_PRIVACY_CANCELLATION_SECRET:"p0_privacy_cancel_C8v4B0n6M2q9W5e1R7t3Y",
      HUAMEI_SESSION_SIGNING_SECRET:strongSessionSecret,
      MINIMAX_API_KEY:"",
      MINIMAX_REAL_CALL_ENABLED:"false",
      MINIMAX_POLL_INTERVAL_MS:"60000",
      PHYSICIAN_AVATAR_RUNTIME_ROOT:avatarRuntimeRoot
    },
    stdio:["ignore", "pipe", "pipe"]
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  let output = "";
  child.stdout.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8_000); });
  child.stderr.on("data", (chunk) => { output = `${output}${chunk}`.slice(-8_000); });
  const baseUrl = `http://127.0.0.1:${port}`;
  let health;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (child.exitCode !== null) break;
    try {
      health = await fetch(`${baseUrl}/api/health`);
      if (health.ok) break;
    } catch {}
    await delay(100);
  }
  if (!health?.ok) {
    child.kill("SIGTERM");
    await Promise.race([exited, delay(1_000)]);
    await rm(avatarRuntimeRoot, { recursive:true, force:true });
    assert.fail(`网关未能启动：${output}`);
  }
  return { baseUrl, child, exited, avatarRuntimeRoot, testInstanceId };
}

async function verifyProxyRateLimit(gateway) {
  const publicChat = (payload, headers = {}) => postJson(`${gateway.baseUrl}/api/public/acquisition-chat`, payload, headers);
  const burst = await Promise.all(Array.from({ length:20 }, (_, index) => publicChat({
    message:"你好",
    session_id:`proxy-session-${index}`
  }, {
    "X-Forwarded-For":`198.18.0.${index + 1}`,
    "X-Forwarded-Proto":"https",
    "X-Request-Id":`proxy-rate-${index}`
  })));
  const statusCounts = burst.reduce((counts, response) => {
    counts[response.status] = (counts[response.status] || 0) + 1;
    return counts;
  }, {});
  assert.equal(statusCounts[429] || 0, 0, `可信反代后的20个独立访客不能共享一个限流桶：${JSON.stringify(statusCounts)}`);
  assert.equal(statusCounts[200] || 0, 20, `20个独立访客都应获得正常响应：${JSON.stringify(statusCounts)}`);
}

async function verifyPublicSessionIsolation(gateway) {
  const publicChat = (payload, headers = {}) => postJson(`${gateway.baseUrl}/api/public/acquisition-chat`, payload, headers);
  const first = await publicChat({ message:"预算一万左右，想做双眼皮" }, {
      "X-Forwarded-For":"198.19.0.10",
      "X-Forwarded-Proto":"https"
  });
  assert.equal(first.status, 200);
  const firstBody = await readJson(first);
  const credential = sessionCredentialFrom(first, firstBody);
  assert.ok(credential.sessionId, "首次公共咨询必须返回服务端会话标识");
  assert.ok(credential.token || credential.cookie, "公共会话必须有独立于session_id的服务端签发凭证");
  const legitimateFollowup = await publicChat(sessionPayload(credential, { message:"我想要自然一点" }), {
    ...sessionHeaders(credential),
    "X-Forwarded-For":"198.19.0.10",
    "X-Forwarded-Proto":"https"
  });
  assert.equal(legitimateFollowup.status, 200);
  const legitimateBody = await readJson(legitimateFollowup);
  assert.equal(legitimateBody.profile_signals?.known_slots?.budget, "一万", "携带有效会话凭证时应延续本人上下文");
  const attacker = await publicChat({
    message:"预算九万左右，我想做隆鼻",
    session_id:credential.sessionId
  }, {
    "X-Forwarded-For":"198.19.0.99",
    "X-Forwarded-Proto":"https"
  });
  if (attacker.status === 200) {
    const attackerBody = await readJson(attacker);
    assert.notEqual(attackerBody.profile_signals?.known_slots?.budget, "一万", "无会话凭证者不得读取原会话画像");
    assert.equal(attackerBody.profile_signals?.turn_count, 1, "无会话凭证者即使获准新建会话，也必须从全新上下文开始");
  } else {
    assert.ok([401, 403, 409].includes(attacker.status), `盗用会话标识应被拒绝或隔离，实际状态码 ${attacker.status}`);
  }
  const afterAttack = await publicChat(sessionPayload(credential, { message:"继续刚才的方向" }), {
    ...sessionHeaders(credential),
    "X-Forwarded-For":"198.19.0.10",
    "X-Forwarded-Proto":"https"
  });
  assert.equal(afterAttack.status, 200);
  const afterAttackBody = await readJson(afterAttack);
  assert.equal(afterAttackBody.profile_signals?.known_slots?.budget, "一万", "盗用请求不能污染原会话预算");
  assert.ok(!(afterAttackBody.profile_signals?.projects || []).includes("隆鼻"), "盗用请求不能污染原会话项目兴趣");
}

async function verifyPublicTenantBinding(gateway) {
  const payloadOverride = await postJson(`${gateway.baseUrl}/api/public/acquisition-chat`, {
    tenant_id:"attacker-tenant",
    message:"请介绍光子嫩肤"
  });
  assert.equal(payloadOverride.status, 403, "公网请求不得通过payload覆盖网关已绑定租户");
  assert.equal((await readJson(payloadOverride)).error?.code, "TENANT_ACCESS_DENIED");

  const headerOverride = await postJson(`${gateway.baseUrl}/api/public/acquisition-chat`, {
    message:"请介绍双眼皮"
  }, { "X-Tenant-Id":"attacker-tenant" });
  assert.equal(headerOverride.status, 403, "公网请求不得通过header覆盖网关已绑定租户");
  assert.equal((await readJson(headerOverride)).error?.code, "TENANT_ACCESS_DENIED");
}

async function verifyPublicHealth(gateway) {
  const health = await fetch(`${gateway.baseUrl}/api/health`);
  assert.equal(health.status, 200);
  const healthBody = await readJson(health);
  assert.equal(healthBody.test_instance_id, gateway.testInstanceId);
  const publicHealthJson = JSON.stringify(healthBody);
  assert.doesNotMatch(publicHealthJson, /source_root|\.local-data|\/Users\/|\/data\/|storage|active_release|approved_record_ids|knowledge_admission|acquisition_service|base_host|http:\/\/(?:acquisition|graphrag)/i, "公开health不得泄露内部路径、URL、存储或发布详情");
}

async function verifyProtectedReadiness(gateway) {
  const publicReady = await fetch(`${gateway.baseUrl}/api/ready`);
  assert.ok([401, 403].includes(publicReady.status), "详细readiness必须鉴权");
  const wrongReady = await fetch(`${gateway.baseUrl}/api/ready`, { headers:{ "X-API-Key":"wrong-key" } });
  assert.ok([401, 403].includes(wrongReady.status), "无效运维凭证不能读取详细readiness");
  const protectedReady = await fetch(`${gateway.baseUrl}/api/ready`, { headers:{ "X-API-Key":strongApiKey } });
  assert.equal(protectedReady.status, 200, "有效运维凭证应能读取详细readiness");
  const readyBody = await readJson(protectedReady);
  assert.ok(readyBody.checks || readyBody.dependencies || readyBody.acquisition_service, "受保护readiness应返回依赖检查详情");
}

const failures = [];
const runCase = async (name, operation) => {
  try {
    await operation();
    console.log(`✓ ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`✗ ${name}: ${error.message}`);
  }
};

const acquisition = await startAcquisitionService();
try {
  await runCase("P0：幂等键跨租户隔离", () => verifyCrossTenantIdempotency(acquisition));
  await runCase("P0：幂等键跨会话隔离", () => verifyCrossConversationIdempotency(acquisition));
  await runCase("P0：同键不同请求体返回409", () => verifyIdempotencyPayloadHash(acquisition));
} finally {
  await new Promise((resolve) => acquisition.server.close(resolve));
}

const gateway = await startGateway();
try {
  await runCase("P0：最小公开health", () => verifyPublicHealth(gateway));
  await runCase("P0：受保护readiness", () => verifyProtectedReadiness(gateway));
  await runCase("P0：公网网关固定租户且拒绝请求覆盖", () => verifyPublicTenantBinding(gateway));
  await runCase("P0：公共会话凭证防复用与防污染", () => verifyPublicSessionIsolation(gateway));
  await runCase("P0：可信反代下20个独立访客限流隔离", () => verifyProxyRateLimit(gateway));
} finally {
  gateway.child.kill("SIGTERM");
  await Promise.race([gateway.exited, delay(1_000)]);
  await rm(gateway.avatarRuntimeRoot, { recursive:true, force:true });
}

if (failures.length) {
  throw new AggregateError(failures.map((item) => item.error), `${failures.length}项P0回归尚未通过：${failures.map((item) => item.name).join("；")}`);
}
