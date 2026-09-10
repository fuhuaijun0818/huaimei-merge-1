// Offline regression must not inherit live member credentials from .env.local.
process.env.HUAMEI_MEMBER_CHECK_ENABLED = "false";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer as createNetServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { issueLocalManagementIdentity, verifyLocalManagementIdentity } from "../server/platform/local-management-identity.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const reservePort = () => new Promise((resolve, reject) => {
  const server = createNetServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    server.close((error) => error ? reject(error) : resolve(port));
  });
});
const [servicePort, gatewayPort] = await Promise.all([reservePort(), reservePort()]);
const serviceUrl = `http://127.0.0.1:${servicePort}`;
const gatewayUrl = `http://127.0.0.1:${gatewayPort}`;
const bridgeSecret = "local-e2e-bridge-9x7c5v3b1n8m6a4s2d0fghjklqwerty";
const runtimeRoot = await mkdtemp(join(tmpdir(), "huamei-admin-bff-e2e-"));
const commonEnv = {
  ...process.env,
  NODE_ENV:"development",
  HUAMEI_RUNTIME_ENV:"development",
  HUAMEI_LOCAL_MANAGEMENT_ROLE:"presales",
  HUAMEI_LLM_ENABLED:"false",
  HUAMEI_GRAPHRAG_ENABLED:"false",
  HUAMEI_PUBLIC_TENANT_ID:"huamei-shanghai",
  HUAMEI_DEFAULT_TENANT_ID:"huamei-shanghai",
  HUAMEI_ACQUISITION_TENANT_ID:"huamei-shanghai",
  HUAMEI_ACQUISITION_SERVICE_URL:serviceUrl,
  HUAMEI_LOCAL_ADMIN_BRIDGE_SECRET:bridgeSecret,
  HUAMEI_LOCAL_ADMIN_SUBJECT:"local-admin-e2e",
  HUAMEI_ACQUISITION_SESSION_STORE_FILE:":memory:",
  HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE:":memory:",
  HUAMEI_CONVERSATION_FEEDBACK_STORE_FILE:":memory:",
  HUAMEI_MANAGEMENT_DOMAIN_STORE_FILE:":memory:",
  HUAMEI_KNOWLEDGE_RELEASE_STORE_FILE:":memory:",
  HUAMEI_LEAD_STORE_FILE:":memory:",
  MINIMAX_API_KEY:"",
  MINIMAX_REAL_CALL_ENABLED:"false",
  MINIMAX_POLL_INTERVAL_MS:"60000",
  PHYSICIAN_AVATAR_RUNTIME_ROOT:runtimeRoot
};
const acquisition = spawn(process.execPath, [join(root, "server/acquisition-service-server.mjs")], {
  cwd:root,
  env:{ ...commonEnv, HUAMEI_ACQUISITION_SERVICE_HOST:"127.0.0.1", HUAMEI_ACQUISITION_SERVICE_PORT:String(servicePort) },
  stdio:"ignore"
});
const gateway = spawn(process.execPath, [join(root, "server.mjs")], {
  cwd:root,
  env:{ ...commonEnv, PORT:String(gatewayPort), HUAMEI_HOST:"127.0.0.1" },
  stdio:"ignore"
});
const exited = Promise.all([
  new Promise((resolve) => acquisition.once("exit", resolve)),
  new Promise((resolve) => gateway.once("exit", resolve))
]);
const waitReady = async (url) => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try { if ((await fetch(url)).ok) return; } catch {}
    await delay(100);
  }
  throw new Error(`service did not become ready: ${url}`);
};

try {
  await Promise.all([waitReady(`${serviceUrl}/health`), waitReady(`${gatewayUrl}/api/health`)]);
  const managementInitialResponse = await fetch(`${gatewayUrl}/api/admin/management/domain-overlay`);
  assert.equal(managementInitialResponse.status, 200);
  const managementInitial = await managementInitialResponse.json();
  assert.equal(managementInitial.data.revision, 0);
  assert.deepEqual(managementInitial.data.overlay.customers, [], "本地管理后台不得以虚构客户作为初始数据");
  const managementOverlay = {
    ...managementInitial.data.overlay,
    customers:[{
      id:"C-e2e-1", name:"本地闭环客户", mobile:"13800000000", timeline:[], interests:[], pains:[], itches:[], delights:[], journeys:[], profile:{}, nextAction:{ title:"待人工制定" }
    }],
    conversations:[{
      id:"V-e2e-1", customerId:"C-e2e-1", channel:"官网", status:"待人工", mode:"人工", messages:[]
    }]
  };
  const managementSavedResponse = await fetch(`${gatewayUrl}/api/admin/management/domain-overlay`, {
    method:"PUT",
    headers:{ "Content-Type":"application/json", "Idempotency-Key":"local-management-overlay-e2e-001" },
    body:JSON.stringify({ revision:managementInitial.data.revision, overlay:managementOverlay })
  });
  assert.equal(managementSavedResponse.status, 403);
  const forbiddenManagementIdentity = await fetch(`${gatewayUrl}/api/admin/management/domain-overlay`, {
    method:"PUT",
    headers:{ "Content-Type":"application/json", "Idempotency-Key":"local-management-overlay-e2e-002" },
    body:JSON.stringify({ tenant_id:"other-tenant", revision:1, overlay:managementOverlay })
  });
  assert.equal(forbiddenManagementIdentity.status, 400);
  assert.equal((await forbiddenManagementIdentity.json()).error.code, "ADMIN_IDENTITY_OVERRIDE_FORBIDDEN");

  const publicChat = await fetch(`${gatewayUrl}/api/public/acquisition-chat`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ message:"我想了解丰胸项目" })
  });
  assert.equal(publicChat.status, 200);
  const publicChatBody = await publicChat.json();
  const publicFeedback = await fetch(`${gatewayUrl}/api/public/acquisition-feedback`, {
    method:"POST",
    headers:{ "Content-Type":"application/json", "X-Huamei-Session-Token":publicChatBody.session_token },
    body:JSON.stringify({
      session_id:publicChatBody.session_id,
      session_token:publicChatBody.session_token,
      reply_id:publicChatBody.run_id,
      rating:"down",
      transcript:[
        { role:"user", content:"我想了解丰胸项目", at:"2026-08-31T09:00:00.000Z" },
        { role:"assistant", content:publicChatBody.reply, at:"2026-08-31T09:00:01.000Z" }
      ]
    })
  });
  assert.equal(publicFeedback.status, 200);
  const publicFeedbackBody = await publicFeedback.json();
  assert.match(publicFeedbackBody.feedback.id, /^fb_/);
  const badCaseList = await fetch(`${gatewayUrl}/api/admin/acquisition/bad-cases?status=new`);
  assert.equal(badCaseList.status, 403);
  const badCaseListBody = await badCaseList.json();
  const reviewedBadCase = await fetch(`${gatewayUrl}/api/admin/acquisition/bad-cases/${publicFeedbackBody.feedback.id}/review`, {
    method:"POST",
    headers:{ "Content-Type":"application/json", "Idempotency-Key":"local-bad-case-review-once" },
    body:JSON.stringify({ status:"included_in_eval", note:"纳入本地回归测试" })
  });
  assert.equal(reviewedBadCase.status, 403);

  const created = await fetch(`${serviceUrl}/v1/conversations/reply`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({
      tenant_id:"huamei-shanghai",
      channel:"api",
      conversation_id:"local-admin-e2e-conversation",
      message:{ id:"local-admin-risk-1", text:"我这种情况适不适合做线雕？" }
    })
  });
  assert.equal(created.status, 200);
  const createdBody = await created.json();
  assert.equal(createdBody.status, "handover_required");
  const handoverId = createdBody.handover.id;

  const list = await fetch(`${gatewayUrl}/api/admin/acquisition/handovers?status=pending`, {
    headers:{ "X-Huamei-Local-Admin-Subject":"browser-spoof-must-be-ignored" }
  });
  assert.equal(list.status, 200);
  const listBody = await list.json();
  assert.ok(listBody.data.some((item) => item.id === handoverId));

  const claimed = await fetch(`${gatewayUrl}/api/admin/acquisition/handovers/${handoverId}/claim`, {
    method:"POST",
    headers:{ "Content-Type":"application/json", "X-Huamei-Local-Admin-Subject":"browser-spoof-must-be-ignored" },
    body:"{}"
  });
  assert.equal(claimed.status, 200);
  assert.equal((await claimed.json()).data.assignee, "local-admin-e2e", "操作人必须由网关服务端固定");

  const completed = await fetch(`${gatewayUrl}/api/admin/acquisition/handovers/${handoverId}/complete`, {
    method:"POST",
    headers:{ "Content-Type":"application/json", "Idempotency-Key":"local-complete-atomic-once" },
    body:JSON.stringify({ resolution:"已完成本地人工说明", minutes:3.5, notes:"本地闭环测试" })
  });
  assert.equal(completed.status, 200);
  const completedBody = await completed.json();
  assert.equal(completedBody.data.handover.status, "completed");
  assert.equal(completedBody.data.human_work.staff_id, "local-admin-e2e");
  assert.equal(completedBody.data.human_work.minutes, 3.5);
  assert.equal(completedBody.meta.atomic, true);

  const work = await fetch(`${gatewayUrl}/api/admin/acquisition/human-work`, {
    method:"POST",
    headers:{ "Content-Type":"application/json", "Idempotency-Key":"local-supplemental-work" },
    body:JSON.stringify({ conversation_id:"local-admin-e2e-conversation", handover_id:handoverId, minutes:1.25, notes:"完结后的补充人工工作" })
  });
  assert.equal(work.status, 201);
  assert.equal((await work.json()).data.staff_id, "local-admin-e2e");

  const overridden = await fetch(`${gatewayUrl}/api/admin/acquisition/human-work`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ staff_id:"browser-attacker", conversation_id:"local-admin-e2e-conversation", minutes:1 })
  });
  assert.equal(overridden.status, 400);
  assert.equal((await overridden.json()).error.code, "ADMIN_IDENTITY_OVERRIDE_FORBIDDEN");

  const prodEnv = { ...commonEnv, NODE_ENV:"production", HUAMEI_RUNTIME_ENV:"production" };
  assert.throws(() => issueLocalManagementIdentity({
    env:prodEnv,
    gatewayHost:"127.0.0.1",
    serviceUrl:new URL(serviceUrl),
    subject:"local-admin-e2e",
    tenantId:"huamei-shanghai",
    method:"GET",
    pathname:"/v1/handovers"
  }), (error) => error.code === "LOCAL_MANAGEMENT_IDENTITY_FORBIDDEN");
  assert.throws(() => verifyLocalManagementIdentity({
    env:prodEnv,
    serviceHost:"127.0.0.1",
    remoteAddress:"127.0.0.1",
    headers:{},
    tenantId:"huamei-shanghai",
    method:"GET",
    pathname:"/v1/handovers"
  }), (error) => error.code === "LOCAL_MANAGEMENT_IDENTITY_FORBIDDEN");
  console.log("✓ 主BFF→售前服务赞踩/Bad Case、list/claim/complete/human-work 本地闭环与生产fail-closed通过");
} finally {
  acquisition.kill("SIGTERM");
  gateway.kill("SIGTERM");
  await Promise.race([exited, delay(1500)]);
  await rm(runtimeRoot, { recursive:true, force:true });
}
