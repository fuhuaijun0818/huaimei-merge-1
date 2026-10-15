// Offline regression must not inherit live member credentials from .env.local.
process.env.HUAMEI_MEMBER_CHECK_ENABLED = "false";

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { DEMO_API_KEY } from "../server/api-router.mjs";

const root = new URL("../", import.meta.url);
const reservePort = () => new Promise((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    probe.close((error) => error ? reject(error) : resolve(address.port));
  });
});
const port = await reservePort();
const baseUrl = `http://127.0.0.1:${port}`;
const avatarRuntimeRoot = await mkdtemp(join(tmpdir(), "huamei-avatar-api-test-"));
const testInstanceId = `api-${process.pid}-${Date.now()}`;
let server = spawn(process.execPath, [fileURLToPath(new URL("server.mjs", root))], {
  cwd: fileURLToPath(root), env: { ...process.env, HUAMEI_LOCAL_MANAGEMENT_ROLE:"presales", PORT: String(port), HUAMEI_LLM_ENABLED: "false", HUAMEI_ACQUISITION_SERVICE_IN_PROCESS:"true", HUAMEI_LEAD_STORE_FILE: ":memory:", HUAMEI_ACQUISITION_SESSION_STORE_FILE:":memory:", HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE:":memory:", HUAMEI_APPOINTMENT_REGISTRATION_FILE:":memory:", HUAMEI_KNOWLEDGE_INTAKE_STORE_FILE:":memory:", HUAMEI_RUNTIME_KNOWLEDGE_INDEX_FILE:":memory:", HUAMEI_KNOWLEDGE_RELEASE_STORE_FILE:":memory:", HUAMEI_TEST_INSTANCE_ID:testInstanceId, MINIMAX_API_KEY: "", MINIMAX_REAL_CALL_ENABLED: "false", MINIMAX_POLL_INTERVAL_MS:"60000", PHYSICIAN_AVATAR_RUNTIME_ROOT:avatarRuntimeRoot }, stdio: "ignore"
});
let serverExited = new Promise((resolve) => server.once("exit", resolve));

const restartWithRole = async role => {
  server.kill("SIGTERM"); await Promise.race([serverExited,delay(1500)]); if(server.exitCode===null){server.kill("SIGKILL");await serverExited;}
  server=spawn(process.execPath,[fileURLToPath(new URL("server.mjs",root))],{cwd:fileURLToPath(root),env:{...process.env,PORT:String(port),HUAMEI_LOCAL_MANAGEMENT_ROLE:role,HUAMEI_LLM_ENABLED:"false",HUAMEI_ACQUISITION_SERVICE_IN_PROCESS:"true",HUAMEI_LEAD_STORE_FILE:":memory:",HUAMEI_ACQUISITION_SESSION_STORE_FILE:":memory:",HUAMEI_ACQUISITION_OPERATIONS_STORE_FILE:":memory:",HUAMEI_KNOWLEDGE_INTAKE_STORE_FILE:":memory:",HUAMEI_RUNTIME_KNOWLEDGE_INDEX_FILE:":memory:",HUAMEI_KNOWLEDGE_RELEASE_STORE_FILE:":memory:",HUAMEI_TEST_INSTANCE_ID:testInstanceId,PHYSICIAN_AVATAR_RUNTIME_ROOT:avatarRuntimeRoot},stdio:"ignore"});
  serverExited=new Promise(resolve=>server.once("exit",resolve));
  for(let i=0;i<80;i++){try{if((await fetch(baseUrl+"/api/health")).ok)return;}catch{} await delay(100);}throw new Error("role server not ready");
};

const apiFetch = (path, options = {}) => fetch(`${baseUrl}${path}`, {
  ...options,
  headers: { "X-API-Key": DEMO_API_KEY, ...(options.body ? { "Content-Type": "application/json" } : {}), ...(options.headers || {}) }
});

const sessionCredentialFrom = (response, body) => {
  const sessionId = body.session?.id || body.session_id || body.profile_signals?.session_id || "";
  const token = body.session?.token || body.session_token || response.headers.get("x-huamei-session-token") || response.headers.get("x-session-token") || "";
  const setCookie = response.headers.get("set-cookie") || "";
  return { sessionId, token, cookie:setCookie ? setCookie.split(";", 1)[0] : "" };
};

const publicSessionRequest = (credential, message, extra = {}) => ({
  method:"POST",
  headers:{
    "Content-Type":"application/json",
    ...(credential.token ? { "X-Huamei-Session-Token":credential.token } : {}),
    ...(credential.cookie ? { Cookie:credential.cookie } : {})
  },
  body:JSON.stringify({
    message,
    session_id:credential.sessionId,
    ...(credential.token ? { session_token:credential.token } : {}),
    ...extra
  })
});

const publicLeadRequest = (credential, payload) => ({
  method:"POST",
  headers:{
    "Content-Type":"application/json",
    ...(credential?.token ? { "X-Huamei-Session-Token":credential.token } : {}),
    ...(credential?.cookie ? { Cookie:credential.cookie } : {})
  },
  body:JSON.stringify({
    ...(credential?.sessionId ? { session_id:credential.sessionId } : {}),
    ...(credential?.token ? { session_token:credential.token } : {}),
    ...payload
  })
});

const assertMinimalCapturedLeadReceipt = (body) => {
  assert.deepEqual(Object.keys(body).sort(), [
    "identity", "masked_mobile", "message", "receipt_id", "request_id", "session_expires_at",
    "session_id", "session_token", "status"
  ]);
  assert.equal(body.status, "accepted");
  assert.deepEqual(body.identity, { phone_verification_status:"pending_manual" });
  assert.equal(body.masked_mobile, "138****5678");
  assert.match(body.receipt_id, /^lead_[0-9a-f-]{36}$/i);
  assert.doesNotMatch(JSON.stringify(body),
    /same_customer|customer_created|customer_updated|customer_id|management_path|macro_stage|micro_stage|primary_interest|API测试客户|光子嫩肤|C-AI-/i);
};

try {
  let health;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      health = await fetch(`${baseUrl}/api/health`);
      if (health.ok) break;
    } catch {}
    await delay(80);
  }
  assert.equal(health?.status, 200, "API健康检查应可访问");
  const healthBody = await health.json();
  assert.equal(healthBody.test_instance_id, testInstanceId, "API测试必须命中本次隔离启动的服务实例");
  assert.doesNotMatch(JSON.stringify(healthBody), /source_root|storage|active_release|knowledge_admission|acquisition_service|base_host|\.local-data|\/Users\//i, "公开health只能返回最小状态");
  const unauthorizedReadiness = await fetch(`${baseUrl}/api/ready`);
  assert.ok([401,403].includes(unauthorizedReadiness.status));
  const readiness = await apiFetch("/api/ready");
  assert.equal(readiness.status, 200);
  const readinessBody = await readiness.json();
  assert.ok(readinessBody.checks || readinessBody.dependencies || readinessBody.acquisition_service);

  const openapi = await fetch(`${baseUrl}/api/v1/openapi.json`);
  assert.equal(openapi.status, 200);
  const specification = await openapi.json();
  assert.equal(specification.openapi, "3.1.0");
  assert.ok(specification.paths["/api/v1/agents/{agentId}/invoke"]);
  assert.ok(specification.paths["/api/v1/router/invoke"]);
  assert.ok(specification.paths["/api/v1/compliance/check"]);
  assert.ok(specification.paths["/api/v1/model/status"]);
  assert.ok(specification.paths["/api/public/acquisition-chat"]);
  assert.ok(specification.paths["/api/public/acquisition-lead"]);
  assert.ok(specification.paths["/api/public/appointment-intakes"]);
  assert.ok(specification.paths["/api/admin/appointment-intakes"]);
  assert.ok(specification.paths["/api/admin/schedule-slots"]);
  assert.ok(specification.paths["/api/admin/knowledge/intake/documents"]);
  assert.ok(specification.paths["/api/admin/knowledge/intake/assets/prepare"]);
  assert.ok(specification.paths["/api/admin/knowledge/intake/assets/{assetId}/content"]);
  assert.equal(specification.paths["/api/admin/knowledge/intake/documents/{documentId}/reviews/{stage}"], undefined,
    "自动入库模式不得继续暴露知识审核流转接口");
  assert.equal(specification.paths["/api/public/acquisition-lead"].post.responses["201"], undefined,
    "公网留资不得用HTTP状态区分新建与命中既有档案");
  assert.ok(specification.paths["/api/local/acquisition-agent/status"]);
  assert.equal(specification.components.parameters.ClientId.name, "X-Client-Id");

  const unauthorized = await fetch(`${baseUrl}/api/v1/agents`);
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).error.code, "UNAUTHORIZED");

  const publicChat = await fetch(`${baseUrl}/api/public/acquisition-chat`, { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ message:"请介绍光子嫩肤的一般项目知识" }) });
  assert.equal(publicChat.status, 200);
  const publicChatBody = await publicChat.json();
  assert.equal(publicChatBody.agent.id, "A-01");
  assert.ok(publicChatBody.reply_segments.length >= 2);
  assert.ok(publicChatBody.citations.some((item) => item.source_record_id === "KB-P-024"));
  assert.equal(publicChatBody.guardrails.medical_diagnosis_allowed, false);
  assert.equal(publicChatBody.lead_capture.should_prompt, false, "首轮知识问答不应立即催促留资");
  assert.equal(publicChatBody.lead_capture.reason, "continue_ai_conversation");
  assert.ok(publicChatBody.profile_signals.projects.includes("光子嫩肤"));
  // 公开知识子集换版后版本号来自内容包 manifest；用 manifest 独立复核，
  // 避免把历史包名写死在断言里。
  const knowledgeManifest = JSON.parse(readFileSync(
    `${process.env.HUAMEI_KNOWLEDGE_ROOT || "knowledge/huamei-v1"}/manifest.json`,
    "utf8"
  ));
  assert.equal(publicChatBody.guardrails.knowledge_version, knowledgeManifest.version);
  assert.equal(publicChatBody.profile_signals.turn_count, 1);
  const publicChatSession = sessionCredentialFrom(publicChat, publicChatBody);
  assert.ok(publicChatSession.sessionId);
  assert.ok(publicChatSession.token || publicChatSession.cookie, "公共会话必须返回服务端签发凭证");

  const publicDoctorPoster = await fetch(`${baseUrl}/api/public/acquisition-chat`, {
    method:"POST",
    headers:{ "Content-Type":"application/json" },
    body:JSON.stringify({ message:"发一下李健院长丰胸宣传海报", session_id:"api-public-media" })
  });
  assert.equal(publicDoctorPoster.status, 200);
  const publicDoctorPosterBody = await publicDoctorPoster.json();
  assert.ok(publicDoctorPosterBody.media?.length > 0, "网页渠道应直接收到经白名单审核的公开图片");
  assert.ok(publicDoctorPosterBody.media.every((item) => item.source_relative_path.startsWith("医生介绍/")));
  const publicPosterAsset = await fetch(`${baseUrl}${publicDoctorPosterBody.media[0].url}`);
  assert.equal(publicPosterAsset.status, 200);
  assert.match(publicPosterAsset.headers.get("content-type") || "", /^image\//);
  const blockedCaseAsset = await fetch(`${baseUrl}/api/public/knowledge-media/asset_bee713dfc5131bd1`);
  assert.equal(blockedCaseAsset.status, 404, "术前术后/案例素材不得被公开图片端点读取");

  const publicChatFollowup = await fetch(`${baseUrl}/api/public/acquisition-chat`, { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ message:"预算一万左右，想要自然一点", interests:["双眼皮"] }) });
  assert.equal(publicChatFollowup.status, 200);
  const followupBody = await publicChatFollowup.json();
  assert.equal(followupBody.profile_signals.known_slots.budget, "一万");
  const followupSession = sessionCredentialFrom(publicChatFollowup, followupBody);
  assert.ok(followupSession.sessionId);
  assert.ok(followupSession.token || followupSession.cookie);
  const publicChatFollowupSecond = await fetch(`${baseUrl}/api/public/acquisition-chat`, publicSessionRequest(followupSession, "我不想被推套餐，下一步核验什么？"));
  const followupSecondBody = await publicChatFollowupSecond.json();
  assert.equal(followupSecondBody.profile_signals.known_slots.budget, "一万");
  assert.ok(followupSecondBody.profile_signals.projects.includes("双眼皮"));

  const bookingChat = await fetch(`${baseUrl}/api/public/acquisition-chat`, { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ message:"帮我预约双眼皮面诊，本周六下午方便", session_id:"api-booking-turn" }) });
  const bookingBody = await bookingChat.json();
  const bookingSession = sessionCredentialFrom(bookingChat, bookingBody);
  assert.equal(bookingBody.lead_capture.should_prompt, true, "明确预约时才应提供人工协助入口");
  assert.equal(bookingBody.profile_signals.dialogue_stage, "appointment_coordination");
  assert.equal(bookingBody.orchestration.action_proposal.type, "appointment_request");
  assert.equal(bookingBody.orchestration.action_proposal.adapter_status, "internal_ready");
  const appointmentRequest = {
    action_id:bookingBody.orchestration.action_proposal.id,
    session_id:bookingSession.sessionId,
    ...(bookingSession.token ? { session_token:bookingSession.token } : {}),
    projects:bookingBody.profile_signals.projects,
    preferred_date:new Date(Date.now() + 86400000 * 5).toISOString().slice(0,10),
    time_period:"afternoon",
    branch:"上海华美医疗美容医院",
    customer_confirmed:true
  };
  const unverifiedAppointment = await fetch(`${baseUrl}/api/public/appointment-intakes`, {
    method:"POST",
    headers:{ "Content-Type":"application/json", ...(bookingSession.token ? { "X-Huamei-Session-Token":bookingSession.token } : {}), ...(bookingSession.cookie ? { Cookie:bookingSession.cookie } : {}) },
    body:JSON.stringify(appointmentRequest)
  });
  assert.equal(unverifiedAppointment.status, 400, "预约申请必须先绑定已保存联系方式");
  assert.equal((await unverifiedAppointment.json()).error.code, "APPOINTMENT_CONTACT_REQUIRED");
  const bookingLead = await fetch(`${baseUrl}/api/public/acquisition-lead`, publicLeadRequest(bookingSession, {
    name:"预约测试客户", mobile:"13812345678", service_consent:true,
    interests:bookingBody.profile_signals.projects,
    messages:[{ role:"user", content:"帮我预约双眼皮面诊，本周六下午方便" }]
  }));
  assert.equal(bookingLead.status, 200);
  assertMinimalCapturedLeadReceipt(await bookingLead.json());
  const acceptedAppointment = await fetch(`${baseUrl}/api/public/appointment-intakes`, {
    method:"POST",
    headers:{ "Content-Type":"application/json", ...(bookingSession.token ? { "X-Huamei-Session-Token":bookingSession.token } : {}), ...(bookingSession.cookie ? { Cookie:bookingSession.cookie } : {}) },
    body:JSON.stringify(appointmentRequest)
  });
  assert.equal(acceptedAppointment.status, 201);
  const acceptedAppointmentBody = await acceptedAppointment.json();
  assert.equal(acceptedAppointmentBody.status, "accepted");
  assert.equal(acceptedAppointmentBody.intake.status, "registered");
  assert.match(acceptedAppointmentBody.intake.appointment_no, /^HM[A-F0-9]{32}$/);
  assert.equal(acceptedAppointmentBody.intake.contact_status, "pending_manual");
  assert.match(acceptedAppointmentBody.message, /不代表指定医生或接诊名额已锁定/);
  assert.doesNotMatch(JSON.stringify(acceptedAppointmentBody), /internal_customer_reference|13812345678/);
  const replayAppointment = await fetch(`${baseUrl}/api/public/appointment-intakes`, {
    method:"POST",
    headers:{ "Content-Type":"application/json", ...(bookingSession.token ? { "X-Huamei-Session-Token":bookingSession.token } : {}), ...(bookingSession.cookie ? { Cookie:bookingSession.cookie } : {}) },
    body:JSON.stringify(appointmentRequest)
  });
  assert.equal(replayAppointment.status, 200, "同一预约动作重复提交只返回原事项");
  const adminAppointments = await fetch(`${baseUrl}/api/admin/appointment-intakes?status=registered`);
  assert.equal(adminAppointments.status, 200);
  assert.ok((await adminAppointments.json()).data.some((item) => item.id === acceptedAppointmentBody.intake.id));
  const createdSlot = await fetch(`${baseUrl}/api/admin/schedule-slots`, {
    method:"POST", headers:{ "Content-Type":"application/json", "Idempotency-Key":"api-appointment-slot-create" }, body:"{}"
  });
  assert.equal(createdSlot.status, 403, "一期不再提供排班写入入口");
  const claimedAppointment = await fetch(`${baseUrl}/api/admin/appointment-intakes/${acceptedAppointmentBody.intake.id}/claim`, {
    method:"POST", headers:{ "Content-Type":"application/json", "Idempotency-Key":"api-appointment-claim" }, body:"{}"
  });
  assert.equal(claimedAppointment.status, 200);
  assert.equal((await claimedAppointment.json()).data.followup_status, "claimed");
  const contactResponse = await fetch(`${baseUrl}/api/admin/appointment-intakes/${acceptedAppointmentBody.intake.id}/contact-reveal`, { method:"POST", headers:{ "Content-Type":"application/json", "Idempotency-Key":"api-appointment-reveal" }, body:"{}" });
  assert.equal(contactResponse.status,200);
  assert.equal((await contactResponse.json()).data.value,"13812345678");
  assert.match(contactResponse.headers.get("cache-control"), /no-store/);
  const confirmedAppointment = await fetch(`${baseUrl}/api/admin/appointment-intakes/${acceptedAppointmentBody.intake.id}/resolve`, {
    method:"POST",
    headers:{ "Content-Type":"application/json", "Idempotency-Key":"api-appointment-confirm" },
    body:JSON.stringify({ status:"completed", note:"本地端到端记录跟进" })
  });
  assert.equal(confirmedAppointment.status, 200);
  const confirmedAppointmentBody = await confirmedAppointment.json();
  assert.equal(confirmedAppointmentBody.data.status, "registered");
  assert.match(confirmedAppointmentBody.data.appointment_no, /^HM[A-F0-9]{32}$/);

  const appointmentCall = (path, body, key) => fetch(`${baseUrl}/api/public/appointment-intakes${path}`, { method:"POST", headers:{ "Content-Type":"application/json", ...(bookingSession.cookie ? { Cookie:bookingSession.cookie } : {}), ...(bookingSession.token ? { "X-Huamei-Session-Token":bookingSession.token } : {}), ...(key ? { "Idempotency-Key":key } : {}) }, body:JSON.stringify(body) });
  const restored = await appointmentCall("/current", {});
  const restoredBody = await restored.json();
  assert.equal(restoredBody.intake.id, acceptedAppointmentBody.intake.id, "刷新后以凭证恢复当前登记");
  assert.doesNotMatch(JSON.stringify(restoredBody.intake), /assignee|resolution_note|confirmation|internal_customer_reference/);
  const aptId = acceptedAppointmentBody.intake.id;
  const changed = await appointmentCall(`/${aptId}/reschedule`, { session_id:bookingSession.sessionId, expected_version:1, customer_confirmed:true, preferred_date:new Date(Date.now()+86400000*7).toISOString().slice(0,10) }, "api-customer-change");
  assert.equal(changed.status, 200);
  assert.equal((await changed.json()).intake.version, 2);
  const staleCancel = await appointmentCall(`/${aptId}/cancel`, { session_id:bookingSession.sessionId, expected_version:1, customer_confirmed:true }, "api-customer-stale");
  assert.equal(staleCancel.status, 409);
  const cancelled = await appointmentCall(`/${aptId}/cancel`, { session_id:bookingSession.sessionId, expected_version:2, customer_confirmed:true }, "api-customer-cancel");
  assert.equal(cancelled.status, 200);
  assert.equal((await cancelled.json()).intake.status, "cancelled");
  const freshSession = await appointmentCall("/current", { session_id:"new-dialog-after-restore" });
  const freshBody = await freshSession.json();
  assert.notEqual(freshBody.session_id, bookingSession.sessionId, "新对话必须更换服务端会话");
  assert.equal(freshBody.intake,null,"新对话不恢复原登记");
  const foreignChange = await fetch(`${baseUrl}/api/public/appointment-intakes/${aptId}/cancel`, { method:"POST", headers:{ "Content-Type":"application/json", "Idempotency-Key":"api-customer-foreign" }, body:JSON.stringify({ session_id:"unrelated-test-session", expected_version:3, customer_confirmed:true }) });
  assert.equal(foreignChange.status, 404, "其他会话不能访问或取消此登记");

  await restartWithRole("content");
  const createdKnowledgeIntake = await fetch(`${baseUrl}/api/admin/knowledge/intake/documents`, {
    method:"POST",
    headers:{ "Content-Type":"application/json", "Idempotency-Key":"api-knowledge-intake-create" },
    body:JSON.stringify({
      source_filename:"API测试知识.md",
      department:"整形外科",
      content_type:"项目介绍",
      owner:"整形外科内容负责人",
      tags:["双眼皮"],
      text_content:"# 双眼皮项目服务说明\n\n这是用于验证管理端录入、解析、向量化并直接进入知识库问答链路的项目资料。"
    })
  });
  assert.equal(createdKnowledgeIntake.status, 201);
  const createdKnowledgeIntakeBody = await createdKnowledgeIntake.json();
  assert.equal(createdKnowledgeIntakeBody.data.status, "draft");
  assert.equal(createdKnowledgeIntakeBody.data.parser_status, "parsed");
  assert.equal(createdKnowledgeIntakeBody.data.knowledge_base_status, "internal_only");
  assert.ok(createdKnowledgeIntakeBody.data.indexed_chunk_count >= 1);
  assert.equal(Object.hasOwn(createdKnowledgeIntakeBody.data, "raw_text"), false);
  const intakeList = await fetch(`${baseUrl}/api/admin/knowledge/intake/documents?department=${encodeURIComponent("整形外科")}`);
  assert.equal(intakeList.status, 200);
  assert.ok((await intakeList.json()).data.some((item) => item.id === createdKnowledgeIntakeBody.data.id));
  const filteredIntakeList = await fetch(`${baseUrl}/api/admin/knowledge/intake/documents?q=${encodeURIComponent("API测试")}&content_type=${encodeURIComponent("项目介绍")}&public_scope=internal`);
  assert.equal(filteredIntakeList.status, 200);
  assert.ok((await filteredIntakeList.json()).data.some((item) => item.id === createdKnowledgeIntakeBody.data.id), "组合筛选应返回匹配的资料");
  const emptyIntakeList = await fetch(`${baseUrl}/api/admin/knowledge/intake/documents?q=${encodeURIComponent("不存在的资料")}`);
  assert.equal(emptyIntakeList.status, 200);
  assert.deepEqual((await emptyIntakeList.json()).data, [], "搜索条件不匹配时应返回空列表");
  const rawMaterial = Buffer.from("# API原始素材\n\n本文件用于验证后台原始素材预留、上传、隔离保存及受控解析流程。", "utf8");
  const preparedKnowledgeAsset = await fetch(`${baseUrl}/api/admin/knowledge/intake/assets/prepare`, {
    method:"POST",
    headers:{ "Content-Type":"application/json", "Idempotency-Key":"api-knowledge-asset-prepare" },
    body:JSON.stringify({
      source_filename:"API原始素材.md", mime:"text/markdown", size:rawMaterial.length,
      department:"整形外科", content_type:"项目介绍", owner:"整形外科内容负责人", tags:["API测试"]
    })
  });
  assert.equal(preparedKnowledgeAsset.status, 201);
  const preparedKnowledgeAssetBody = await preparedKnowledgeAsset.json();
  assert.match(preparedKnowledgeAssetBody.data.upload_url, /\/api\/admin\/knowledge\/intake\/assets\//);
  const uploadedKnowledgeAsset = await fetch(`${baseUrl}${preparedKnowledgeAssetBody.data.upload_url}`, {
    method:"PUT", headers:{ "Content-Type":"text/markdown" }, body:rawMaterial
  });
  assert.equal(uploadedKnowledgeAsset.status, 200);
  const completedKnowledgeAsset = await fetch(`${baseUrl}/api/admin/knowledge/intake/assets/${preparedKnowledgeAssetBody.data.id}/complete`, {
    method:"POST", headers:{ "Content-Type":"application/json", "Idempotency-Key":"api-knowledge-asset-complete" }, body:"{}"
  });
  assert.equal(completedKnowledgeAsset.status, 201);
  const completedKnowledgeAssetBody = await completedKnowledgeAsset.json();
  assert.equal(completedKnowledgeAssetBody.data.status, "draft");
  assert.equal(completedKnowledgeAssetBody.data.parser_status, "parsed");
  assert.equal(completedKnowledgeAssetBody.data.knowledge_base_status, "internal_only");
  assert.equal(Object.hasOwn(completedKnowledgeAssetBody.data, "raw_text"), false);

  await restartWithRole("presales");
  const firstLead = await fetch(`${baseUrl}/api/public/acquisition-lead`, publicLeadRequest(null, {
    name:"API测试客户", mobile:"13812345678", service_consent:true,
    interests:["光子嫩肤"], messages:[{ role:"user", content:"想了解光子嫩肤" }]
  }));
  assert.equal(firstLead.status, 200);
  const firstLeadBody = await firstLead.json();
  assertMinimalCapturedLeadReceipt(firstLeadBody);
  const firstLeadSession = sessionCredentialFrom(firstLead, firstLeadBody);

  const sameLead = await fetch(`${baseUrl}/api/public/acquisition-lead`, publicLeadRequest(firstLeadSession, {
    mobile:"+86 138 1234 5678", service_consent:true,
    interests:["热玛吉"]
  }));
  assert.equal(sameLead.status, 200);
  const sameLeadBody = await sameLead.json();
  assertMinimalCapturedLeadReceipt(sameLeadBody);
  assert.notEqual(sameLeadBody.receipt_id, firstLeadBody.receipt_id);
  assert.equal(sameLeadBody.status, firstLeadBody.status,
    "同号再次提交与首次提交的公网响应必须不可区分");

  const invalidLead = await fetch(`${baseUrl}/api/public/acquisition-lead`, publicLeadRequest(null, {
    mobile:"12345", service_consent:true
  }));
  assert.equal(invalidLead.status, 400);
  assert.equal((await invalidLead.json()).error.code, "INVALID_MOBILE");

  const acquisitionSnapshot = await fetch(`${baseUrl}/api/local/acquisition-customers`);
  assert.equal(acquisitionSnapshot.status, 200);
  const acquisitionSnapshotBody = await acquisitionSnapshot.json();
  assert.equal(acquisitionSnapshotBody.data.customers.length, 0);
  assert.equal(acquisitionSnapshotBody.data.meta.identity_rule, "tenant_scoped_normalized_mobile_hmac");
  assert.doesNotMatch(JSON.stringify(acquisitionSnapshotBody), /13812345678/);

  const acquisitionAgentStatus = await fetch(`${baseUrl}/api/local/acquisition-agent/status`);
  assert.equal(acquisitionAgentStatus.status, 403);

  const publicHandover = await fetch(`${baseUrl}/api/public/acquisition-chat`, { method:"POST", headers:{ "Content-Type":"application/json" }, body:JSON.stringify({ message:"我适不适合做线雕？", customer_id:"C-VICTIM-PUBLIC-IMPERSONATION" }) });
  assert.equal(publicHandover.status, 200);
  assert.equal((await publicHandover.json()).status, "handover_required");

  const publicImpersonationRuns = await apiFetch("/api/v1/runs?limit=100");
  assert.equal(publicImpersonationRuns.status, 200);
  assert.doesNotMatch(JSON.stringify(await publicImpersonationRuns.json()), /C-VICTIM-PUBLIC-IMPERSONATION/, "公网会话不得将调用方声称的customer_id写入审计或人工接管数据");

  const agents = await apiFetch("/api/v1/agents");
  assert.equal(agents.status, 200);
  const agentList = await agents.json();
  assert.equal(agentList.data.length, 6);
  assert.equal(agents.headers.get("x-ratelimit-limit"), "60");
  assert.equal(agentList.meta.llm.enabled, false);

  const modelStatus = await apiFetch("/api/v1/model/status");
  assert.equal(modelStatus.status, 200);
  assert.equal((await modelStatus.json()).data.mode, "local_rule_runtime");

  const avatarUserHeaders = { "Content-Type":"application/json", "X-Huamei-User-Id":"api-avatar-test" };
  const avatarPayload = {
    physicianId:"DR-001",
    title:"API删除流程测试",
    script:"大家好，今天为大家介绍医美项目的一般流程，具体方案需到院后由专业医师评估。",
    voiceId:"Chinese (Mandarin)_Reliable_Executive",
    mode:"reference_avatar",
    resolution:"768P",
    duration:12,
    ratio:"3:4",
    consentConfirmed:true,
    generativeDisclosureConfirmed:true
  };
  const avatarCreated = await fetch(`${baseUrl}/api/local/physician-avatar/jobs`, { method:"POST", headers:{ ...avatarUserHeaders, "Idempotency-Key":"api-delete-flow" }, body:JSON.stringify(avatarPayload) });
  assert.equal(avatarCreated.status, 403, "Avatar capabilities are not assigned to phase-one staff; runtime lifecycle is tested separately");

  const payload = {
    customer_id: "C-API-TEST", message: "我想了解热玛吉的一般流程", mode: "assist", channel: "test",
    context: { macro_stage: "售前", interests: [{ name: "热玛吉", score: 92 }], marketing_consent: true, owner: "周妍" }
  };
  const invocation = await apiFetch("/api/v1/agents/A-01/invoke", { method: "POST", headers: { "Idempotency-Key": "api-test-001" }, body: JSON.stringify(payload) });
  assert.equal(invocation.status, 200);
  const invocationBody = await invocation.json();
  assert.equal(invocationBody.agent.id, "A-01");
  assert.equal(invocationBody.status, "completed");
  assert.match(invocationBody.run_id, /^run_/);

  const replay = await apiFetch("/api/v1/agents/A-01/invoke", { method: "POST", headers: { "Idempotency-Key": "api-test-001" }, body: JSON.stringify(payload) });
  const replayBody = await replay.json();
  assert.equal(replayBody.run_id, invocationBody.run_id);
  assert.equal(replay.headers.get("x-idempotent-replay"), "true");

  const invalid = await apiFetch("/api/v1/agents/A-01/invoke", { method: "POST", body: JSON.stringify({ message: "", mode: "wrong" }) });
  assert.equal(invalid.status, 400);
  assert.equal((await invalid.json()).error.code, "VALIDATION_ERROR");

  const tenantOverride = await apiFetch("/api/v1/agents/A-01/invoke", {
    method:"POST",
    body:JSON.stringify({ ...payload, tenant_id:"attacker-tenant" })
  });
  assert.equal(tenantOverride.status, 403, "网关后端调用也不得覆盖固定租户");
  assert.equal((await tenantOverride.json()).error.code, "TENANT_ACCESS_DENIED");

  const router = await apiFetch("/api/v1/router/invoke", { method: "POST", body: JSON.stringify({ ...payload, message: "周三几点可以预约？" }) });
  const routerBody = await router.json();
  assert.equal(routerBody.routing.selected_agent_id, "A-02");

  const compliance = await apiFetch("/api/v1/compliance/check", { method: "POST", body: JSON.stringify({ message: "保证安全而且一定有效", mode: "assist" }) });
  const complianceBody = await compliance.json();
  assert.equal(complianceBody.agent.id, "A-06");
  assert.equal(complianceBody.status, "blocked");

  const run = await apiFetch(`/api/v1/runs/${invocationBody.run_id}`);
  assert.equal(run.status, 200);
  assert.equal((await run.json()).data.audit.agent_id, "A-01");

  const cors = await fetch(`${baseUrl}/api/v1/router/invoke`, { method: "OPTIONS", headers: { Origin: "http://127.0.0.1:4173", "Access-Control-Request-Method": "POST" } });
  assert.equal(cors.status, 204);
  assert.equal(cors.headers.get("access-control-allow-origin"), "http://127.0.0.1:4173");
  assert.match(cors.headers.get("access-control-allow-headers"), /X-Client-Id/);
  assert.match(cors.headers.get("access-control-allow-methods"), /DELETE/);

  const protectedSource = await fetch(`${baseUrl}/server/api-router.mjs`);
  assert.equal(protectedSource.status, 404, "服务端实现文件不能通过静态服务器访问");

  console.log("✓ API鉴权、限流头、校验与结构化错误通过");
  console.log("✓ 指定调用、自动路由、合规检查与运行审计通过");
  console.log("✓ 幂等重放、CORS与OpenAPI 3.1规范通过");
} finally {
  server.kill("SIGTERM");
  await Promise.race([serverExited, delay(1000)]);
  await rm(avatarRuntimeRoot, { recursive:true, force:true });
}
