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

const root = fileURLToPath(new URL("../", import.meta.url));
const tenantId = "huamei-shanghai";
const runtimeRoot = await mkdtemp(join(tmpdir(), "huamei-phase-one-api-"));
const overlayStore = join(runtimeRoot, "management-domain-overlay.json");

const reservePort = () => new Promise((resolve, reject) => {
  const probe = createNetServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const port = probe.address().port;
    probe.close((error) => error ? reject(error) : resolve(port));
  });
});

const waitReady = async (url) => {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await delay(75);
  }
  throw new Error(`gateway did not become ready: ${url}`);
};

const sharedEnv = {
  ...process.env,
  NODE_ENV:"development",
  HUAMEI_RUNTIME_ENV:"development",
  HUAMEI_PERSISTENCE_BACKEND:"local_json",
  HUAMEI_HOST:"127.0.0.1",
  HUAMEI_LOCAL_REQUIRE_AUTH:"false",
  HUAMEI_ADMIN_SESSION_AUTH:"false",
  // Keep this offline boundary regression isolated from an operator's local
  // PostgreSQL acceptance-audit configuration.
  HUAMEI_LOCAL_MANAGEMENT_AUDIT_ENABLED:"false",
  HUAMEI_LLM_ENABLED:"false",
  HUAMEI_GRAPHRAG_ENABLED:"false",
  HUAMEI_PUBLIC_TENANT_ID:tenantId,
  HUAMEI_DEFAULT_TENANT_ID:tenantId,
  HUAMEI_ACQUISITION_TENANT_ID:tenantId,
  HUAMEI_ACQUISITION_SERVICE_IN_PROCESS:"true",
  HUAMEI_MANAGEMENT_DOMAIN_STORE_FILE:overlayStore,
  HUAMEI_ACQUISITION_SESSION_STORE_FILE:":memory:",
  HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE:":memory:",
  HUAMEI_CONVERSATION_FEEDBACK_STORE_FILE:":memory:",
  HUAMEI_KNOWLEDGE_RELEASE_STORE_FILE:":memory:",
  HUAMEI_KNOWLEDGE_INTAKE_STORE_FILE:":memory:",
  HUAMEI_RUNTIME_KNOWLEDGE_INDEX_FILE:":memory:",
  HUAMEI_LEAD_STORE_FILE:":memory:",
  HUAMEI_APPOINTMENT_REGISTRATION_FILE:":memory:",
  MINIMAX_API_KEY:"",
  MINIMAX_REAL_CALL_ENABLED:"false",
  MINIMAX_POLL_INTERVAL_MS:"60000",
  // An external channel must not inherit a developer's local credential when
  // this boundary test checks the fail-closed, not_configured contract.
  HUAMEI_CHANNEL_WECOM_CORP_ID:"",
  HUAMEI_CHANNEL_WECOM_AGENT_ID:"",
  HUAMEI_CHANNEL_WECOM_SECRET:"",
  HUAMEI_CHANNEL_WECOM_TOKEN:"",
  HUAMEI_CHANNEL_WECOM_ENCODING_AES_KEY:"",
  HUAMEI_CHANNEL_DOUYIN_APP_ID:"",
  HUAMEI_CHANNEL_DOUYIN_APP_SECRET:"",
  HUAMEI_CHANNEL_DOUYIN_WEBHOOK_SECRET:"",
  HUAMEI_CHANNEL_XIAOHONGSHU_APP_ID:"",
  HUAMEI_CHANNEL_XIAOHONGSHU_APP_SECRET:"",
  HUAMEI_CHANNEL_XIAOHONGSHU_WEBHOOK_SECRET:""
};

const startGateway = async ({ role, subject }) => {
  const port = await reservePort();
  const child = spawn(process.execPath, [join(root, "server.mjs")], {
    cwd:root,
    env:{
      ...sharedEnv,
      PORT:String(port),
      HUAMEI_LOCAL_MANAGEMENT_ROLE:role,
      HUAMEI_LOCAL_ADMIN_SUBJECT:subject
    },
    stdio:"ignore"
  });
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const baseUrl = `http://127.0.0.1:${port}`;
  await waitReady(`${baseUrl}/api/health`);
  return {
    baseUrl,
    async stop() {
      if (!child.killed) child.kill("SIGTERM");
      await Promise.race([exited, delay(1_500)]);
    }
  };
};

const managementOverlay = ({ data, headers = {} } = {}) => ({
  method:"PUT",
  headers:{
    "Content-Type":"application/json",
    "Idempotency-Key":"phase-one-overlay-seed-001",
    ...headers
  },
  body:JSON.stringify(data)
});

try {
  const administrator = await startGateway({ role:"管理员", subject:"phase-one-admin" });
  try {
    const content = await startGateway({role:"content",subject:"phase-one-content"});
    const knowledgeBase = `${content.baseUrl}/api/admin/knowledge/intake/documents`;
    let mutationNumber = 0;
    const writeKnowledge = (suffix, payload, key) => fetch(knowledgeBase + suffix, { method:"POST", headers:{ "Content-Type":"application/json", "Idempotency-Key":key || `p0-knowledge-${++mutationNumber}` }, body:JSON.stringify(payload) });
    const draftResponse = await writeKnowledge("", { source_filename:"接口回归资料.md", department:"运营中心", owner:"测试内容员", content_type:"服务流程", text_content:"这份资料仅用于接口回归测试，说明内部版本校订和确认凭据的登记方式，不含真实客户数据。" });
    assert.equal(draftResponse.status, 201);
    const draft = (await draftResponse.json()).data;
    assert.equal(draft.status, "draft");
    const detailResponse = await fetch(`${knowledgeBase}/${draft.id}`);
    assert.equal(detailResponse.status, 200);
    assert.ok((await detailResponse.json()).data.text_content);
    assert.equal((await writeKnowledge(`/${draft.id}`, { actor:"forged", expected_version:1 })).status, 400);
    assert.equal((await writeKnowledge(`/${draft.id}`, { tenant_id:"other", expected_version:1 })).status, 400);
    assert.equal((await writeKnowledge(`/${draft.id}`, { permitted_departments:["*"], expected_version:1 })).status, 400);
    const incomplete = await writeKnowledge(`/${draft.id}/candidate`, { expected_version:1 });
    assert.equal(incomplete.status, 400);
    const update = { expected_version:1, source_reference:"测试受控资料 001", applicable_campuses:["测试院区"], public_scope:"customer_summary", customer_facing_candidate:true,
      effective_at:new Date(Date.now() - 60000).toISOString(), expires_at:new Date(Date.now() + 86400000).toISOString() };
    const updatedResponse = await writeKnowledge(`/${draft.id}`, update, "p0-knowledge-update-v1");
    assert.equal(updatedResponse.status, 200);
    assert.equal((await updatedResponse.json()).data.version, 2);
    assert.equal((await writeKnowledge(`/${draft.id}`, update)).status, 409);
    const confirmedResponse = await writeKnowledge(`/${draft.id}/confirmation`, { expected_version:2, reference:"院方测试确认 002", confirmed_by:"测试确认人", confirmed_at:new Date(Date.now() - 1000).toISOString(), confirmation_expires_at:new Date(Date.now() + 3600000).toISOString() });
    assert.equal(confirmedResponse.status, 200);
    const candidateResponse = await writeKnowledge(`/${draft.id}/candidate`, { expected_version:2 });
    assert.equal(candidateResponse.status, 200);
    const candidate = (await candidateResponse.json()).data;
    assert.equal(candidate.status, "release_candidate");
    assert.equal(candidate.publication_status, "not_published");
    await content.stop();
    const initialResponse = await fetch(`${administrator.baseUrl}/api/admin/management/domain-overlay`);
    assert.equal(initialResponse.status, 200);
    const initial = await initialResponse.json();
    assert.equal(initial.data.revision, 0);

    const seedOverlay = {
      currentRole:"管理员",
      managementUsers:[
        {
          id:"U-ADMIN", name:"平台管理员", nickname:"管理小美", staffId:"ADM-001", account:"admin", roleId:"R-ADMIN", role:"管理员", status:"启用", department:"运营中心", internalNote:"不得下发"
        },
        {
          id:"U-PRESALES", name:"售前小安", nickname:"安安", staffId:"PS-100", account:"presales.anan", roleId:"R-PRESALES", role:"售前人员", status:"启用", department:"在线咨询组", internalNote:"不得下发"
        }
      ],
      managementRoles:[
        { id:"R-ADMIN", name:"管理员", permissions:["platform:manage"] },
        { id:"R-PRESALES", name:"售前人员", permissions:["conversations:reply"] }
      ],
      customers:[
        { id:"C-CHAT", name:"已进入聊天客户", mobile:"13800000001", profile:{ stage:"咨询中" } },
        { id:"C-NOT-CHAT", name:"未进入聊天客户", mobile:"13800000002", profile:{ stage:"线索" } }
      ],
      tasks:[
        { id:"T-CHAT", customerId:"C-CHAT", title:"回复客户" },
        { id:"T-NOT-CHAT", customerId:"C-NOT-CHAT", title:"不应下发" }
      ],
      conversations:[
        { id:"V-CHAT", customerId:"C-CHAT", channel:"网页应用", status:"进行中", mode:"机器人", messages:[] }
      ],
      journeys:[{ id:"J-SECRET", name:"管理员旅程" }],
      agents:[{ id:"A-SECRET", name:"不应下发的智能体" }],
      connectors:[{ id:"CONN-SECRET", name:"不应下发的连接器" }],
      audit:[{ id:"AUDIT-SECRET", action:"不应下发" }],
      handovers:[{ id:"H-SECRET", assignee:"admin" }],
      configurationRecords:[
        { id:"TPL-PRESALES", kind:"message_template", title:"欢迎话术", content:"您好，我是安安。", status:"启用", presalesVisible:true },
        { id:"TPL-ADMIN", kind:"message_template", title:"仅管理员话术", content:"内部使用", status:"启用", presalesVisible:false },
        { id:"TPL-DISABLED", kind:"message_template", title:"已停用话术", content:"已停用内容", status:"停用", presalesVisible:true },
        { id:"CFG-SECRET", kind:"system_config", value:"不应下发" }
      ],
      productOverrides:[{ id:"P-SECRET", price:"99999" }],
      physicianOverrides:[{ id:"D-SECRET", note:"不应下发" }],
      knowledgeOverrides:[{ id:"K-SECRET", content:"不应下发" }]
    };
    const savedResponse = await fetch(`${administrator.baseUrl}/api/admin/management/domain-overlay`, managementOverlay({
      data:{ revision:initial.data.revision, overlay:seedOverlay }
    }));
    assert.equal(savedResponse.status, 403, "Global overlay cannot grant customer or publishing authority");
    process.env.HUAMEI_MANAGEMENT_DOMAIN_STORE_FILE=overlayStore;
    const {replaceManagementDomainOverlay}=await import('../server/management-domain-store.mjs');
    seedOverlay.conversations=seedOverlay.conversations.map(c=>({...c,assignee:'presales.anan',department:'test'}));
    seedOverlay.conversations.push({id:'V-OTHER',customerId:'C-NO-CHAT',assignee:'another-advisor',department:'test',messages:[]});
    replaceManagementDomainOverlay({tenantId,expectedRevision:0,overlay:seedOverlay,actor:'fixture',idempotencyKey:'fixture-seed-role-scopes'});

    const adminChannelsResponse = await fetch(`${administrator.baseUrl}/api/local/acquisition-channels`);
    assert.equal(adminChannelsResponse.status, 200, "管理员应能查看 IM 通道状态");
    const adminChannels = (await adminChannelsResponse.json()).data;
    for (const id of ["wecom", "douyin", "xiaohongshu"]) {
      const channel = adminChannels.find((item) => item.id === id);
      assert.equal(channel?.status, "not_configured", `${id}无官方配置时必须保持未配置`);
      assert.equal(channel?.enabled, false, `${id}不得在未实现官方 adapter 时伪装为已启用`);
    }
  } finally {
    await administrator.stop();
  }

  const presales = await startGateway({ role:"售前人员", subject:"presales.anan" });
  try {
    const deniedPath = `${presales.baseUrl}/api/admin/knowledge/intake/documents/kidoc_missing`;
    assert.equal((await fetch(deniedPath)).status, 403, "售前无权读取内部校订正文");
    for (const suffix of ["", "/confirmation", "/candidate"]) assert.equal((await fetch(deniedPath + suffix, { method:"POST", headers:{ "Content-Type":"application/json", "Idempotency-Key":"p0-presales-forbidden" }, body:JSON.stringify({ expected_version:1 }) })).status, 403);
    const readResponse = await fetch(`${presales.baseUrl}/api/admin/management/domain-overlay`);
    assert.equal(readResponse.status, 200, "售前人员应能读取会话工作集");
    const record = (await readResponse.json()).data;
    const overlay = record.overlay;
    assert.equal(record.updated_by, null, "售前读取不得暴露管理员操作人");
    assert.equal(overlay.currentRole, "售前人员");
    assert.deepEqual(overlay.managementRoles, [], "售前不得获得角色管理数据");
    assert.deepEqual(overlay.agents, [], "售前不得获得智能体维护数据");
    assert.deepEqual(overlay.connectors, [], "售前不得获得通道配置数据");
    assert.deepEqual(overlay.audit, [], "售前不得获得审计数据");
    assert.deepEqual(overlay.journeys, [], "售前不得获得运营旅程数据");
    assert.deepEqual(overlay.productOverrides, [], "售前不得获得医院产品维护数据");
    assert.deepEqual(overlay.physicianOverrides, [], "售前不得获得医生维护数据");
    assert.deepEqual(overlay.knowledgeOverrides, [], "售前不得获得知识库维护数据");
    assert.deepEqual(overlay.configurationRecords.map((item) => item.id), ["TPL-PRESALES"], "售前只可取得已启用且可见的常用话术（停用与仅管理员话术都不得下发）");
    assert.deepEqual(overlay.conversations.map((item) => item.id), ["V-CHAT"]);
    assert.deepEqual(overlay.customers.map((item) => item.id), ["C-CHAT"], "仅已进入聊天的客户可下发至售前工作集");
    assert.deepEqual(overlay.tasks.map((item) => item.id), ["T-CHAT"]);
    assert.deepEqual(overlay.managementUsers, [{
      id:"U-PRESALES", name:"售前小安", nickname:"安安", staffId:"PS-100", account:"presales.anan", role:"售前人员", status:"启用"
    }], "售前仅取得当前接待所需的售前昵称和 ID");

    const rejectedWrite = await fetch(`${presales.baseUrl}/api/admin/management/domain-overlay`, managementOverlay({
      headers:{ "Idempotency-Key":"phase-one-presales-write-001" },
      data:{ revision:record.revision, overlay:overlay }
    }));
    assert.equal(rejectedWrite.status, 403, "售前人员不得回写全局管理覆盖层");
    assert.equal((await rejectedWrite.json()).error.code, "PHASE_ONE_CAPABILITY_FORBIDDEN");

    const presalesChannelsResponse = await fetch(`${presales.baseUrl}/api/local/acquisition-channels`);
    assert.equal(presalesChannelsResponse.status, 200, "售前人员应能读取接待所需的 IM 通道状态");
    const presalesChannels = (await presalesChannelsResponse.json()).data;
    for (const id of ["wecom", "douyin", "xiaohongshu"]) {
      const channel = presalesChannels.find((item) => item.id === id);
      assert.equal(channel?.status, "not_configured", `${id}未配置官方凭据不得显示已连接`);
      assert.equal(channel?.enabled, false, `${id}未配置时不得显示可发送`);
    }
  } finally {
    await presales.stop();
  }

  console.log("✓ 一期管理员/售前服务端边界、会话工作集裁剪与 IM 未配置状态通过");
} finally {
  await rm(runtimeRoot, { recursive:true, force:true });
}
